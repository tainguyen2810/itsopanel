package ops

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// WordPress Toolkit (D-99, ADR 0044). Mọi lệnh WP-CLI chạy bằng `php<ver> wp-cli.phar` dưới uid account trong slice
// của account (systemd-run), với subcommand cố định do agent dựng (không nhận subcommand từ panel). Đường dẫn site
// luôn nằm dưới ~/sites/<domain>/public và không thành phần nào là symlink. Mật khẩu chỉ đi qua stdin (--prompt).

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpWpDetect:        d.wpDetect,
			contracts.OpWpInfo:          d.wpInfo,
			contracts.OpWpInstall:       d.wpInstall,
			contracts.OpWpUpdate:        d.wpUpdate,
			contracts.OpWpClone:         d.wpClone,
			contracts.OpWpHarden:        d.wpHarden,
			contracts.OpWpAdminPassword: d.wpAdminPassword,
			contracts.OpWpMaintenance:   d.wpMaintenance,
		}
	})
}

// WPStateDir giữ trạng thái hardening do agent ghi (root 0700): cờ vhost, thời điểm đổi salt.
const WPStateDir = "/var/lib/itso/wp"

// WPHardeningPlugin là mu-plugin ẩn phiên bản WordPress (version_hidden).
const WPHardeningPlugin = "wp-content/mu-plugins/itso-hardening.php"

const wpHardeningPHP = `<?php
/* Quản lý bởi itso-agent (wp.harden). Không sửa tay. */
remove_action('wp_head', 'wp_generator');
add_filter('the_generator', '__return_empty_string');
`

// wpAllowedCmds: subcommand WP-CLI duy nhất agent được gọi (ADR 0044 §2).
var wpAllowedCmds = map[string]bool{
	"core version": true, "core check-update": true, "core download": true, "core install": true, "core update": true,
	"core update-db": true, "core verify-checksums": true, "plugin list": true, "plugin update": true,
	"plugin verify-checksums": true, "theme list": true, "theme update": true, "option get": true, "option update": true,
	"config create": true, "config set": true, "config delete": true, "config shuffle-salts": true,
	"maintenance-mode activate": true, "maintenance-mode deactivate": true, "maintenance-mode is-active": true,
	"search-replace": true, "user update": true,
}

// wpForbiddenFlags: cờ toàn cục WP-CLI có thể nạp/chạy mã tùy ý hoặc đổi site đích.
var wpForbiddenFlags = []string{"--require", "--exec", "--ssh", "--http", "--path", "--user=", "--context", "--debug"}

// WPAllowed kiểm argv WP-CLI (sau phần php + phar) theo allowlist; dùng cả trong test.
func WPAllowed(args []string) error {
	if len(args) == 0 {
		return errors.New("thiếu subcommand")
	}
	key := args[0]
	if key != "search-replace" {
		if len(args) < 2 {
			return errors.New("thiếu subcommand")
		}
		key = args[0] + " " + args[1]
	}
	if !wpAllowedCmds[key] {
		return fmt.Errorf("subcommand WP-CLI không được phép: %q", key)
	}
	for _, a := range args {
		if strings.ContainsAny(a, "\x00\n\r") {
			return errors.New("tham số có ký tự điều khiển")
		}
		for _, f := range wpForbiddenFlags {
			if strings.HasPrefix(a, f) {
				return fmt.Errorf("cờ WP-CLI bị cấm: %q", a)
			}
		}
	}
	return nil
}

type wpSite struct {
	acct    contracts.Account
	uid     int64
	gid     int64
	domain  string
	rel     string // so với home
	home    string // đường dẫn logic /home/<user>
	realHom string // đường dẫn thật (sandbox: dưới gốc giả)
	abs     string // đường dẫn thật của site
	php     string
	exists  bool
}

func wpInvalid(f string, a ...any) error {
	return &registry.OpError{Code: "invalid_params", Message: fmt.Sprintf(f, a...)}
}

// site kiểm WpSite: account khớp /etc/passwd, đường dẫn dưới sites/<domain>/public, PHP 8.1–8.4, không symlink.
func (d *Deps) site(s contracts.WpSite) (*wpSite, error) {
	u, err := d.lookupAccount(s.Account)
	if err != nil {
		return nil, err
	}
	dom := string(s.Domain)
	if err := validate.Domain(dom); err != nil {
		return nil, opErr(err)
	}
	rel := string(s.Path)
	if err := fsx.CheckPath(rel); err != nil || rel == "." {
		return nil, wpInvalid("path không hợp lệ")
	}
	base := "sites/" + dom + "/public"
	if rel != base && !strings.HasPrefix(rel, base+"/") {
		return nil, wpInvalid("path phải là %s hoặc nằm dưới đó", base)
	}
	if err := validate.PHPVersion(string(s.PHPVersion), true); err != nil {
		return nil, opErr(err)
	}
	home := homeOf(s.Account.Username)
	exists, err := d.walkNoSymlink(home, rel)
	if err != nil {
		return nil, err
	}
	realHome, err := d.FS.Path(home)
	if err != nil {
		return nil, opErr(err)
	}
	return &wpSite{acct: s.Account, uid: u.UID, gid: u.GID, domain: dom, rel: rel, home: home, realHom: realHome,
		abs: realHome + "/" + rel, php: string(s.PHPVersion), exists: exists}, nil
}

// walkNoSymlink: mọi thành phần của rel dưới home phải là thư mục thật. exists=false khi một thành phần chưa có.
// Chỉ lstat (không mở file trong home bằng root); lệnh WP-CLI sau đó chạy dưới uid account nên kể cả khi bị đổi
// đồng thời cũng không vượt quyền account.
func (d *Deps) walkNoSymlink(home, rel string) (bool, error) {
	fi, err := d.FS.Lstat(home)
	if err != nil || !fi.IsDir() || fi.Mode()&fs.ModeSymlink != 0 {
		return false, &registry.OpError{Code: "precondition_failed", Message: "home account không hợp lệ"}
	}
	cur := home
	for _, seg := range strings.Split(rel, "/") {
		cur += "/" + seg
		fi, err := d.FS.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, opErr(err)
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return false, &registry.OpError{Code: "path_outside_home", Message: "đường dẫn có symlink: " + strings.TrimPrefix(cur, home+"/")}
		}
		if !fi.IsDir() {
			return false, &registry.OpError{Code: "precondition_failed", Message: strings.TrimPrefix(cur, home+"/") + " không phải thư mục"}
		}
	}
	return true, nil
}

// regular: file rel (so với home) tồn tại và là file thường (không symlink).
func (d *Deps) regular(s *wpSite, rel string) (bool, error) {
	fi, err := d.FS.Lstat(s.home + "/" + rel)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, opErr(err)
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return false, &registry.OpError{Code: "path_outside_home", Message: rel + " là symlink"}
	}
	return fi.Mode().IsRegular(), nil
}

// requireWP: site đã có WordPress (wp-config.php + wp-includes/version.php là file thường).
func (d *Deps) requireWP(s *wpSite) error {
	if !s.exists {
		return &registry.OpError{Code: "not_found", Message: "không có thư mục " + s.rel}
	}
	for _, f := range []string{"wp-config.php", "wp-includes/version.php"} {
		ok, err := d.regular(s, s.rel+"/"+f)
		if err != nil {
			return err
		}
		if !ok {
			return &registry.OpError{Code: "not_found", Message: "không thấy WordPress tại " + s.rel + " (thiếu " + f + ")"}
		}
	}
	return nil
}

// wp chạy một lệnh WP-CLI dưới uid account. stdin chỉ dùng cho giá trị bí mật (--prompt).
func (d *Deps) wp(ctx context.Context, s *wpSite, timeout int, stdin []byte, args ...string) (platform.Result, error) {
	if err := WPAllowed(args); err != nil {
		return platform.Result{}, &registry.OpError{Code: "internal", Message: err.Error()}
	}
	slice, err := validate.SliceName(s.uid)
	if err != nil {
		return platform.Result{}, opErr(err)
	}
	argv := []string{"--wait", "--pipe", "--collect", "--quiet", fmt.Sprintf("--uid=%d", s.uid), fmt.Sprintf("--gid=%d", s.gid),
		"--slice=" + slice, "--working-directory=" + s.realHom, "-p", "NoNewPrivileges=yes", "-p", "PrivateTmp=yes",
		"-p", fmt.Sprintf("RuntimeMaxSec=%d", timeout), "-E", "HOME=" + s.realHom, "-E", "WP_CLI_CACHE_DIR=" + s.realHom + "/.wp-cli/cache",
		"-E", "WP_CLI_DISABLE_AUTO_CHECK_UPDATE=1", "-E", "WP_CLI_CONFIG_PATH=/dev/null",
		"/usr/bin/php" + s.php, "-d", "memory_limit=512M", WPCLIPath, "--path=" + s.abs, "--no-color", "--skip-plugins", "--skip-themes"}
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: "systemd-run", Args: append(argv, args...), Stdin: stdin})
	if err != nil {
		return res, opErr(err)
	}
	return res, nil
}

// wpOK chạy lệnh và đòi thoát 0.
func (d *Deps) wpOK(ctx context.Context, s *wpSite, timeout int, stdin []byte, args ...string) (string, error) {
	res, err := d.wp(ctx, s, timeout, stdin, args...)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", wpFail(args, res)
	}
	return strings.TrimSpace(string(res.Stdout)), nil
}

func wpFail(args []string, res platform.Result) error {
	sub := args[0]
	if len(args) > 1 && !strings.HasPrefix(args[1], "-") {
		sub += " " + args[1]
	}
	msg := strings.TrimSpace(string(res.Stderr))
	if msg == "" {
		msg = strings.TrimSpace(string(res.Stdout))
	}
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("wp %s thoát mã %d: %s", sub, res.ExitCode, msg)}
}

// ---------- đọc file dưới uid account (fs helper) ----------

func (d *Deps) readAs(ctx context.Context, a contracts.Account, rel string, max int64) ([]byte, bool, error) {
	raw, err := d.callFS(ctx, fsReq{acct: a, op: "read", params: map[string]any{"path": rel, "max_bytes": max}})
	if err != nil {
		var oe *registry.OpError
		if errors.As(err, &oe) && oe.Code == "not_found" {
			return nil, false, nil
		}
		return nil, false, err
	}
	var r struct {
		Content string `json:"content_b64"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, false, opErr(err)
	}
	b, err := base64.StdEncoding.DecodeString(r.Content)
	if err != nil {
		return nil, false, opErr(err)
	}
	return b, true, nil
}

var (
	reWPVersion   = regexp.MustCompile(`\$wp_version\s*=\s*'([0-9][0-9A-Za-z.\-]{0,30})'`)
	reWPMultisite = regexp.MustCompile(`(?i)define\(\s*['"]MULTISITE['"]\s*,\s*true\s*\)`)
	reWPFileEdit  = regexp.MustCompile(`(?i)define\(\s*['"]DISALLOW_FILE_EDIT['"]\s*,\s*true\s*\)`)
	reWPDBName    = regexp.MustCompile(`define\(\s*['"]DB_NAME['"]\s*,\s*['"]([a-z][a-z0-9_]{0,63})['"]\s*\)`)
)

// ---------- wp.detect ----------

func (d *Deps) wpDetect(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpDetectParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	if len(p.Roots) == 0 || len(p.Roots) > 200 {
		return nil, wpInvalid("roots: 1–200 mục")
	}
	home := homeOf(p.Account.Username)
	out := contracts.WpDetectResult{Sites: []contracts.WpDetectResultSitesItem{}}
	seen := map[string]bool{}
	for _, r := range p.Roots {
		rel := string(r)
		if err := fsx.CheckPath(rel); err != nil || !strings.HasPrefix(rel, "sites/") || seen[rel] {
			if seen[rel] {
				continue
			}
			return nil, wpInvalid("root phải nằm dưới sites/: %q", rel)
		}
		seen[rel] = true
		exists, err := d.walkNoSymlink(home, rel)
		if err != nil {
			var oe *registry.OpError
			if errors.As(err, &oe) && oe.Code == "path_outside_home" {
				continue // root có symlink: bỏ qua, không đi theo
			}
			return nil, err
		}
		if !exists {
			continue
		}
		s := &wpSite{acct: p.Account, home: home, rel: rel}
		if ok, err := d.regular(s, rel+"/wp-config.php"); err != nil || !ok {
			continue
		}
		if ok, err := d.regular(s, rel+"/wp-includes/version.php"); err != nil || !ok {
			continue
		}
		vb, _, err := d.readAs(ctx, p.Account, rel+"/wp-includes/version.php", 65536)
		if err != nil {
			return nil, err
		}
		m := reWPVersion.FindSubmatch(vb)
		if m == nil {
			continue
		}
		cb, _, err := d.readAs(ctx, p.Account, rel+"/wp-config.php", 524288)
		if err != nil {
			return nil, err
		}
		out.Sites = append(out.Sites, contracts.WpDetectResultSitesItem{Path: contracts.RelPath(rel), Version: string(m[1]),
			Multisite: reWPMultisite.Match(cb)})
	}
	return toData(out)
}

// ---------- wp.info ----------

type wpListItem struct {
	Name          string `json:"name"`
	Title         string `json:"title"`
	Status        string `json:"status"`
	Version       string `json:"version"`
	UpdateVersion string `json:"update_version"`
}

var reSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,99}$`)

func (d *Deps) wpList(ctx context.Context, s *wpSite, kind string) ([]wpListItem, error) {
	out, err := d.wpOK(ctx, s, 120, nil, kind, "list", "--format=json", "--fields=name,title,status,version,update_version")
	if err != nil {
		return nil, err
	}
	var items []wpListItem
	if out != "" {
		if err := json.Unmarshal([]byte(out), &items); err != nil {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "wp " + kind + " list: JSON không hợp lệ"}
		}
	}
	keep := items[:0]
	for _, it := range items {
		if reSlug.MatchString(it.Name) && len(keep) < 500 {
			keep = append(keep, it)
		}
	}
	return keep, nil
}

type wpCoreUpdate struct {
	Version    string `json:"version"`
	UpdateType string `json:"update_type"`
}

func (d *Deps) wpCoreUpdateVersion(ctx context.Context, s *wpSite) *string {
	res, err := d.wp(ctx, s, 120, nil, "core", "check-update", "--format=json")
	if err != nil || res.ExitCode != 0 {
		return nil
	}
	var ups []wpCoreUpdate
	if json.Unmarshal(bytes.TrimSpace(res.Stdout), &ups) != nil || len(ups) == 0 {
		return nil
	}
	v := clip(ups[0].Version, 50)
	return &v
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func optStr(s string) *string {
	if s == "" {
		return nil
	}
	v := clip(s, 50)
	return &v
}

// checksumsOK: thoát 0 là khớp; plugin không có trên wordpress.org (không lấy được checksum) không tính là lỗi.
func checksumsOK(res platform.Result) bool {
	if res.ExitCode == 0 {
		return true
	}
	out := string(res.Stdout) + string(res.Stderr)
	bad := strings.Contains(out, "Checksum does not match") || strings.Contains(out, "File should not exist") ||
		strings.Contains(out, "File doesn't exist") || strings.Contains(out, "doesn't verify against checksum")
	return !bad && strings.Contains(out, "Could not retrieve the checksums")
}

type wpState struct {
	XMLRPCBlocked       bool   `json:"xmlrpc_blocked"`
	PHPInUploadsBlocked bool   `json:"php_in_uploads_blocked"`
	SaltsRotatedAt      string `json:"salts_rotated_at,omitempty"`
}

func wpStatePath(s *wpSite) string {
	return fmt.Sprintf("%s/%d/%s.json", WPStateDir, s.uid, s.domain)
}

func (d *Deps) wpLoadState(s *wpSite) wpState {
	var st wpState
	if b, err := d.FS.ReadFile(wpStatePath(s)); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

func (d *Deps) wpSaveState(s *wpSite, st wpState) error {
	if err := d.ensureTree(path.Dir(wpStatePath(s)), 0o700); err != nil {
		return opErr(err)
	}
	b, _ := json.Marshal(st)
	if _, err := d.FS.WriteAtomic(wpStatePath(s), b, 0o600, platform.Owner{}); err != nil {
		return opErr(err)
	}
	return nil
}

func (d *Deps) wpConfigMode(s *wpSite) fs.FileMode {
	fi, err := d.FS.Lstat(s.home + "/" + s.rel + "/wp-config.php")
	if err != nil {
		return 0
	}
	return fi.Mode().Perm()
}

func (d *Deps) wpHardeningState(ctx context.Context, s *wpSite) (contracts.WpInfoResultHardening, error) {
	cfg, _, err := d.readAs(ctx, s.acct, s.rel+"/wp-config.php", 524288)
	if err != nil {
		return contracts.WpInfoResultHardening{}, err
	}
	st := d.wpLoadState(s)
	mu, err := d.regular(s, s.rel+"/"+WPHardeningPlugin)
	if err != nil {
		return contracts.WpInfoResultHardening{}, err
	}
	return contracts.WpInfoResultHardening{FileEditDisabled: reWPFileEdit.Match(cfg), XmlrpcBlocked: st.XMLRPCBlocked,
		PHPInUploadsBlocked: st.PHPInUploadsBlocked, WpConfigProtected: wpProtected(d.wpConfigMode(s)),
		VersionHidden: mu, SaltsRotated: st.SaltsRotatedAt != ""}, nil
}

func (d *Deps) wpInfo(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpInfoParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	s, err := d.site(p.Site)
	if err != nil {
		return nil, err
	}
	if err := d.requireWP(s); err != nil {
		return nil, err
	}
	ver, err := d.wpOK(ctx, s, 60, nil, "core", "version")
	if err != nil {
		return nil, err
	}
	url, _ := d.wpOK(ctx, s, 60, nil, "option", "get", "siteurl")
	out := contracts.WpInfoResult{Version: clip(ver, 50), SiteURL: clip(url, 500), Components: []contracts.WpComponentInfo{}}
	cfg, _, err := d.readAs(ctx, s.acct, s.rel+"/wp-config.php", 524288)
	if err != nil {
		return nil, err
	}
	out.Multisite = reWPMultisite.Match(cfg)
	out.DBName = json.RawMessage("null")
	if m := reWPDBName.FindSubmatch(cfg); m != nil {
		out.DBName = rawStr(string(m[1]))
	}
	if res, err := d.wp(ctx, s, 30, nil, "maintenance-mode", "is-active"); err == nil {
		out.Maintenance = res.ExitCode == 0
	}
	out.Components = append(out.Components, contracts.WpComponentInfo{Type: "core", Slug: json.RawMessage("null"), Name: "WordPress",
		Version: clip(ver, 50), UpdateVersion: d.wpCoreUpdateVersion(ctx, s), Active: true})
	for _, kind := range []string{"plugin", "theme"} {
		items, err := d.wpList(ctx, s, kind)
		if err != nil {
			return nil, err
		}
		for _, it := range items {
			out.Components = append(out.Components, contracts.WpComponentInfo{Type: kind, Slug: json.RawMessage(strconv.Quote(it.Name)),
				Name: clip(firstNonEmpty(it.Title, it.Name), 200), Version: clip(it.Version, 50), UpdateVersion: optStr(it.UpdateVersion),
				Active: it.Status == "active" || it.Status == "must-use" || it.Status == "parent"})
		}
	}
	if out.Hardening, err = d.wpHardeningState(ctx, s); err != nil {
		return nil, err
	}
	if res, err := d.wp(ctx, s, 300, nil, "core", "verify-checksums"); err == nil {
		ok := checksumsOK(res)
		out.ChecksumsOK = &ok
	}
	return toData(out)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ---------- thư mục đích (install, clone): chưa có hoặc rỗng; không bao giờ ghi đè ----------

func (d *Deps) prepareEmptyTarget(ctx context.Context, s *wpSite) error {
	if s.exists {
		raw, err := d.callFS(ctx, fsReq{acct: s.acct, op: "list", params: map[string]any{"path": s.rel, "show_hidden": true, "limit": 5}})
		if err != nil {
			return err
		}
		var l struct {
			Entries []fsx.Entry `json:"entries"`
		}
		if err := json.Unmarshal(raw, &l); err != nil {
			return opErr(err)
		}
		if len(l.Entries) > 0 {
			return &registry.OpError{Code: "already_exists", Message: s.rel + " không rỗng — không ghi đè site có sẵn"}
		}
		return nil
	}
	segs := strings.Split(s.rel, "/")
	for i := range segs {
		sub := strings.Join(segs[:i+1], "/")
		mode := uint32(0o750)
		if i >= 2 {
			mode = 0o755
		}
		if _, err := d.callFS(ctx, fsReq{acct: s.acct, op: "mkdir", params: map[string]any{"path": sub, "mode": mode}}); err != nil {
			return err
		}
	}
	s.exists = true
	return nil
}

// cleanupTarget xóa nội dung vừa tạo ở đích (chỉ gọi khi đích rỗng trước đó).
func (d *Deps) cleanupTarget(ctx context.Context, s *wpSite) {
	raw, err := d.callFS(ctx, fsReq{acct: s.acct, op: "list", params: map[string]any{"path": s.rel, "show_hidden": true, "limit": 5000}})
	if err != nil {
		return
	}
	var l struct {
		Entries []fsx.Entry `json:"entries"`
	}
	if json.Unmarshal(raw, &l) != nil || len(l.Entries) == 0 {
		return
	}
	paths := make([]string, 0, len(l.Entries))
	for _, e := range l.Entries {
		paths = append(paths, s.rel+"/"+e.Name)
	}
	_, _ = d.callFS(ctx, fsReq{acct: s.acct, op: "delete", params: map[string]any{"paths": paths}})
}

// emptyDB: DB đích đã được tạo trước (db.*) và chưa có bảng nào.
func (d *Deps) emptyDB(ctx context.Context, a contracts.Account, name string) error {
	if err := CheckDBName(engMy, a, name); err != nil {
		return err
	}
	ok, err := d.dbExists(ctx, engMy, name)
	if err != nil {
		return err
	}
	if !ok {
		return &registry.OpError{Code: "precondition_failed", Message: "database " + name + " chưa được tạo (db.mysql.create trước)"}
	}
	out, err := d.sql(ctx, engMy, fmt.Sprintf("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=%s;\n", lit(name)))
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) != "0" {
		return &registry.OpError{Code: "already_exists", Message: "database " + name + " đã có bảng — không ghi đè"}
	}
	return nil
}

func checkSecret(p string) error {
	if p == "" || strings.ContainsAny(p, "\x00\n\r") || len(p) > 128 {
		return wpInvalid("mật khẩu không hợp lệ")
	}
	return nil
}

// ---------- wp.install ----------

var reWPUser = regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,59}$`)

func (d *Deps) wpInstall(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpInstallParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	s, err := d.site(p.Site)
	if err != nil {
		return nil, err
	}
	if !reWPUser.MatchString(p.AdminUser) || validate.Email(string(p.AdminEmail)) != nil {
		return nil, wpInvalid("admin_user/admin_email không hợp lệ")
	}
	if p.Title == "" || len(p.Title) > 200 || strings.IndexFunc(p.Title, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return nil, wpInvalid("title không hợp lệ")
	}
	if p.Locale != "vi" && p.Locale != "en_US" {
		return nil, wpInvalid("locale không hợp lệ")
	}
	if err := checkHTTPSURL(string(p.URL), s.domain); err != nil {
		return nil, err
	}
	if err := checkSecret(string(p.AdminPassword)); err != nil {
		return nil, err
	}
	if err := checkSecret(string(p.DB.Password)); err != nil {
		return nil, err
	}
	if err := CheckDBName(engMy, s.acct, string(p.DB.User)); err != nil {
		return nil, err
	}
	if err := d.emptyDB(ctx, s.acct, string(p.DB.Name)); err != nil {
		return nil, err
	}
	if err := d.prepareEmptyTarget(ctx, s); err != nil {
		return nil, err
	}
	fail := func(err error) (map[string]any, error) {
		d.cleanupTarget(ctx, s)
		return nil, err
	}
	if _, err := d.wpOK(ctx, s, 600, nil, "core", "download", "--locale="+p.Locale); err != nil {
		return fail(err)
	}
	if _, err := d.wpOK(ctx, s, 120, []byte(string(p.DB.Password)+"\n"), "config", "create", "--dbname="+string(p.DB.Name),
		"--dbuser="+string(p.DB.User), "--dbhost=localhost", "--dbcharset=utf8mb4", "--locale="+p.Locale, "--prompt=dbpass"); err != nil {
		return fail(err)
	}
	if _, err := d.wpOK(ctx, s, 300, []byte(string(p.AdminPassword)+"\n"), "core", "install", "--url="+string(p.URL),
		"--title="+p.Title, "--admin_user="+p.AdminUser, "--admin_email="+string(p.AdminEmail), "--skip-email",
		"--prompt=admin_password"); err != nil {
		return fail(err)
	}
	ver, err := d.wpOK(ctx, s, 60, nil, "core", "version")
	if err != nil {
		return fail(err)
	}
	return toData(contracts.WpInstallResult{Version: clip(ver, 50), Installed: true})
}

// checkHTTPSURL: URL https của chính domain site (hoặc subdomain/đường dẫn của nó), không userinfo/cổng lạ.
func checkHTTPSURL(u, domain string) error {
	rest, ok := strings.CutPrefix(u, "https://")
	if !ok || len(u) > 500 || strings.ContainsAny(u, " \x00\r\n'\"\\@") {
		return wpInvalid("url phải là https://…")
	}
	host := rest
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		host = rest[:i]
	}
	if validate.Domain(host) != nil {
		return wpInvalid("url: host không hợp lệ")
	}
	if host != domain && !strings.HasSuffix(host, "."+domain) && !strings.HasSuffix(domain, "."+host) {
		return wpInvalid("url phải thuộc domain %s", domain)
	}
	return nil
}

// ---------- wp.update ----------

type wpComp struct {
	Type string `json:"type"`
	Slug string `json:"slug,omitempty"`
}

func parseComponents(raw []json.RawMessage) ([]wpComp, error) {
	var out []wpComp
	seen := map[string]bool{}
	for _, r := range raw {
		var c wpComp
		dec := json.NewDecoder(bytes.NewReader(r))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&c); err != nil {
			return nil, wpInvalid("component không hợp lệ")
		}
		switch c.Type {
		case "core":
			if c.Slug != "" {
				return nil, wpInvalid("core không có slug")
			}
		case "plugin", "theme":
			if !reSlug.MatchString(c.Slug) {
				return nil, wpInvalid("slug không hợp lệ: %q", c.Slug)
			}
		default:
			return nil, wpInvalid("type component không hợp lệ")
		}
		k := c.Type + "/" + c.Slug
		if !seen[k] {
			seen[k] = true
			out = append(out, c)
		}
	}
	if len(out) == 0 || len(out) > 200 {
		return nil, wpInvalid("components: 1–200 mục")
	}
	// core trước (update-db), rồi plugin, theme — thứ tự ổn định.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Type == "core" && out[j].Type != "core" })
	return out, nil
}

type wpVersions struct {
	core    string
	plugins map[string]string
	themes  map[string]string
}

func (d *Deps) wpVersions(ctx context.Context, s *wpSite) (wpVersions, error) {
	v := wpVersions{plugins: map[string]string{}, themes: map[string]string{}}
	var err error
	if v.core, err = d.wpOK(ctx, s, 60, nil, "core", "version"); err != nil {
		return v, err
	}
	for kind, m := range map[string]map[string]string{"plugin": v.plugins, "theme": v.themes} {
		items, err := d.wpList(ctx, s, kind)
		if err != nil {
			return v, err
		}
		for _, it := range items {
			m[it.Name] = it.Version
		}
	}
	return v, nil
}

func (v wpVersions) of(c wpComp) (string, bool) {
	switch c.Type {
	case "core":
		return v.core, v.core != ""
	case "plugin":
		x, ok := v.plugins[c.Slug]
		return x, ok
	default:
		x, ok := v.themes[c.Slug]
		return x, ok
	}
}

type wpUpdateParams struct {
	Site       contracts.WpSite  `json:"site"`
	Components []json.RawMessage `json:"components"`
	MinorOnly  bool              `json:"minor_only"`
	Snapshot   struct {
		Repo backup.RepoParams   `json:"repo"`
		DB   *contracts.BackupDB `json:"db"`
		Tags []string            `json:"tags"`
	} `json:"snapshot"`
	CheckScheme string `json:"check_scheme"`
}

// wpHTTPOK: site trả lời (2xx/3xx, hoặc 401/403 khi site có bảo vệ); 404/5xx/không kết nối là lỗi.
func wpHTTPOK(status int64) bool {
	return (status >= 200 && status < 400) || status == 401 || status == 403
}

func (d *Deps) wpUpdate(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p wpUpdateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	s, err := d.site(p.Site)
	if err != nil {
		return nil, err
	}
	comps, err := parseComponents(p.Components)
	if err != nil {
		return nil, err
	}
	if p.CheckScheme != "http" && p.CheckScheme != "https" {
		return nil, wpInvalid("check_scheme không hợp lệ")
	}
	for _, t := range p.Snapshot.Tags {
		if !backup.ValidTag(t) {
			return nil, wpInvalid("tag không hợp lệ: %q", t)
		}
	}
	repo, err := backup.ParseRepo(p.Snapshot.Repo)
	if err != nil {
		return nil, bkErr(err)
	}
	if repo.AccountUUID() == "" {
		return nil, wpInvalid("snapshot cần repo của account")
	}
	if db := p.Snapshot.DB; db != nil {
		if db.Engine == "postgresql" {
			return nil, wpInvalid("WordPress dùng MariaDB/MySQL")
		}
		if err := CheckDBName(engMy, s.acct, string(db.Name)); err != nil {
			return nil, err
		}
	}
	if err := d.requireWP(s); err != nil {
		return nil, err
	}
	before, err := d.wpVersions(ctx, s)
	if err != nil {
		return nil, err
	}
	r, done, err := d.openRepo(env, p.Snapshot.Repo)
	if err != nil {
		return nil, err
	}
	defer done()

	// 1. Snapshot restic pre-wp-update: file site + DB (dump dưới uid account).
	tags := append([]string{"--tag", "itso", "--tag", "pre-wp-update"}, tagArgs(p.Snapshot.Tags)...)
	base := func(kind string) []string {
		return dedupTags(append(append([]string{"backup", "--json", "--quiet", "--host", r.repo.ServerUUID()}, tags...), "--tag", "type:"+kind))
	}
	acct := s.acct
	site := s.domain
	fsum, err := d.backupFiles(ctx, r, &backupRunParams{Account: &acct, SiteDir: &site}, base("files"), &backup.Meta{})
	if err != nil {
		return nil, err
	}
	out := contracts.WpUpdateResult{Results: []contracts.WpUpdateResultResultsItem{}, SnapshotID: contracts.ResticSnapshotID(fsum.SnapshotID),
		DBSnapshotID: json.RawMessage("null")}
	dbSnap := ""
	if db := p.Snapshot.DB; db != nil {
		dsum, err := d.backupDB(ctx, r, &backupRunParams{Account: &acct, Databases: []contracts.BackupDB{*db}}, base("db"), &backup.Meta{})
		if err != nil {
			return nil, err
		}
		dbSnap = dsum.SnapshotID
		out.DBSnapshotID = rawStr(dbSnap)
	}

	// 2. Maintenance → cập nhật từng thành phần → tắt maintenance.
	if _, err := d.wpOK(ctx, s, 60, nil, "maintenance-mode", "activate"); err != nil {
		return nil, err
	}
	failed := false
	var updatedPlugins []string
	for _, c := range comps {
		from, installed := before.of(c)
		item := contracts.WpUpdateResultResultsItem{Type: c.Type, Slug: json.RawMessage("null"), FromVersion: clip(from, 50)}
		if c.Slug != "" {
			item.Slug = json.RawMessage(strconv.Quote(c.Slug))
		}
		var uerr error
		switch {
		case !installed:
			uerr = errors.New(c.Type + " " + c.Slug + " chưa cài")
		case c.Type == "core":
			args := []string{"core", "update"}
			if p.MinorOnly {
				args = append(args, "--minor")
			}
			if _, uerr = d.wpOK(ctx, s, 900, nil, args...); uerr == nil {
				_, uerr = d.wpOK(ctx, s, 600, nil, "core", "update-db")
			}
		default:
			args := []string{c.Type, "update", c.Slug}
			if p.MinorOnly {
				args = append(args, "--minor")
			}
			_, uerr = d.wpOK(ctx, s, 600, nil, args...)
			if c.Type == "plugin" {
				updatedPlugins = append(updatedPlugins, c.Slug)
			}
		}
		item.OK = uerr == nil
		if uerr != nil {
			failed = true
			msg := clip(uerr.Error(), 500)
			item.Error = &msg
		}
		out.Results = append(out.Results, item)
		if failed {
			break // dừng ở lỗi đầu tiên: phần còn lại không chạy, khôi phục cả site
		}
	}
	_, merr := d.wpOK(ctx, s, 60, nil, "maintenance-mode", "deactivate")

	// 3. Kiểm: checksum core (+ plugin vừa cập nhật) và http.check.
	if !failed {
		res, err := d.wp(ctx, s, 300, nil, "core", "verify-checksums")
		out.ChecksumsOK = err == nil && checksumsOK(res)
		if out.ChecksumsOK && len(updatedPlugins) > 0 {
			res, err := d.wp(ctx, s, 300, nil, append([]string{"plugin", "verify-checksums"}, updatedPlugins...)...)
			out.ChecksumsOK = err == nil && checksumsOK(res)
		}
		out.HTTPStatus = d.wpHTTPStatus(ctx, p.CheckScheme, s.domain)
	}
	if after, err := d.wpVersions(ctx, s); err == nil {
		for i, c := range comps[:len(out.Results)] {
			if v, ok := after.of(c); ok {
				out.Results[i].ToVersion = clip(v, 50)
			}
		}
	}
	if !failed && merr == nil && out.ChecksumsOK && wpHTTPOK(out.HTTPStatus) {
		return toData(out)
	}

	// 4. Khôi phục snapshot: file (hoán đổi nguyên tử, bản lỗi giữ ở sites/<domain>.restore-<ts>) rồi DB.
	ts := d.now().UTC().Format("20060102-150405")
	for i := 2; i < 100; i++ { // hai lần khôi phục trong cùng một giây: không đụng bản lỗi giữ lại trước đó
		if _, err := d.FS.Lstat(s.home + "/sites/" + s.domain + ".restore-" + ts); errors.Is(err, fs.ErrNotExist) {
			break
		}
		ts = d.now().UTC().Format("20060102-150405") + "-" + strconv.Itoa(i)
	}
	rres := contracts.BackupRestoreResult{RestoredPaths: []contracts.RelPath{}, Databases: []contracts.DBName{},
		Skipped: []contracts.BackupRestoreResultSkippedItem{}}
	stage := "wp-" + opDirName(env.OpID)
	rbErr := d.restoreWebsite(ctx, r, &acct, fsum.SnapshotID, stage, s.domain, "overwrite", ts, nil, &rres)
	if rbErr == nil && dbSnap != "" {
		db := p.Snapshot.DB
		rbErr = d.restoreDatabase(ctx, r, &acct, dbSnap, restoreItem{Kind: "database", DB: db, TargetName: string(db.Name)},
			"overwrite", nil, &rres)
	}
	if rbErr != nil {
		return nil, &registry.OpError{Code: "wp_update_failed", Message: clip(fmt.Sprintf("cập nhật lỗi và khôi phục lỗi (snapshot %s, db %s): %v",
			fsum.SnapshotID, firstNonEmpty(dbSnap, "-"), rbErr), 500)}
	}
	out.RolledBack = true
	return toData(out)
}

func tagArgs(tags []string) []string {
	out := make([]string, 0, 2*len(tags))
	for _, t := range tags {
		out = append(out, "--tag", t)
	}
	return out
}

func (d *Deps) wpHTTPStatus(ctx context.Context, scheme, host string) int64 {
	if d.Sandbox && d.HTTPAddrs == nil {
		return 200 // sandbox không có nginx thật
	}
	return d.doHTTPCheck(ctx, scheme, host, "/", []int64{200}).Status
}

// ---------- wp.clone ----------

func (d *Deps) wpClone(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpCloneParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	src, err := d.site(p.Source)
	if err != nil {
		return nil, err
	}
	dst, err := d.site(p.Target)
	if err != nil {
		return nil, err
	}
	if src.acct.Username != dst.acct.Username || src.uid != dst.uid {
		return nil, wpInvalid("clone chỉ trong cùng account")
	}
	if src.domain == dst.domain {
		return nil, wpInvalid("site đích phải khác domain nguồn")
	}
	if err := checkHTTPSURL(string(p.TargetURL), dst.domain); err != nil {
		return nil, err
	}
	if p.TargetDB.Engine != "mariadb" && p.TargetDB.Engine != "mysql" {
		return nil, wpInvalid("engine không hợp lệ")
	}
	if err := checkSecret(string(p.TargetDB.Password)); err != nil {
		return nil, err
	}
	if err := CheckDBName(engMy, src.acct, string(p.SourceDB)); err != nil {
		return nil, err
	}
	if err := CheckDBName(engMy, src.acct, string(p.TargetDB.User)); err != nil {
		return nil, err
	}
	if string(p.SourceDB) == string(p.TargetDB.Name) {
		return nil, wpInvalid("DB đích phải khác DB nguồn")
	}
	if err := d.requireWP(src); err != nil {
		return nil, err
	}
	if err := d.emptyDB(ctx, dst.acct, string(p.TargetDB.Name)); err != nil {
		return nil, err
	}
	srcURL, err := d.wpOK(ctx, src, 60, nil, "option", "get", "siteurl")
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(srcURL, "http://") && !strings.HasPrefix(srcURL, "https://") || strings.ContainsAny(srcURL, " \x00\r\n") {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "siteurl nguồn không hợp lệ"}
	}
	if err := d.prepareEmptyTarget(ctx, dst); err != nil {
		return nil, err
	}
	fail := func(err error) (map[string]any, error) {
		d.cleanupTarget(ctx, dst)
		_, _ = d.sql(ctx, engMy, fmt.Sprintf("DROP DATABASE IF EXISTS %s;\n%s", myIdent(string(p.TargetDB.Name)),
			CreateSQL(engMy, string(dst.acct.Username), string(p.TargetDB.Name), "utf8mb4")))
		return nil, err
	}
	// File: liệt kê gốc nguồn rồi chép từng mục vào đích (helper từ chối nếu đích đã có — không ghi đè).
	raw, err := d.callFS(ctx, fsReq{acct: src.acct, op: "list", params: map[string]any{"path": src.rel, "show_hidden": true, "limit": 5000}})
	if err != nil {
		return fail(err)
	}
	var l struct {
		Entries   []fsx.Entry `json:"entries"`
		Truncated bool        `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &l); err != nil || l.Truncated {
		return fail(&registry.OpError{Code: "precondition_failed", Message: "thư mục nguồn có quá nhiều mục"})
	}
	var paths []string
	for _, e := range l.Entries {
		if e.Name != ".maintenance" {
			paths = append(paths, src.rel+"/"+e.Name)
		}
	}
	if len(paths) > 0 {
		if _, err := d.callFS(ctx, fsReq{acct: src.acct, op: "copy", params: map[string]any{"paths": paths, "target": dst.rel}}); err != nil {
			return fail(err)
		}
	}
	// DB: dump nguồn → nhập đích, cả hai dưới uid account (danh tính chủ).
	if err := d.copyDB(ctx, src.acct, string(p.SourceDB), string(p.TargetDB.Name)); err != nil {
		return fail(err)
	}
	for _, kv := range [][2]string{{"DB_NAME", string(p.TargetDB.Name)}, {"DB_USER", string(p.TargetDB.User)}} {
		if _, err := d.wpOK(ctx, dst, 60, nil, "config", "set", kv[0], kv[1], "--type=constant"); err != nil {
			return fail(err)
		}
	}
	if _, err := d.wpOK(ctx, dst, 60, []byte(string(p.TargetDB.Password)+"\n"), "config", "set", "DB_PASSWORD", "--type=constant",
		"--prompt=value"); err != nil {
		return fail(err)
	}
	cnt, err := d.wpOK(ctx, dst, 1800, nil, "search-replace", srcURL, string(p.TargetURL), "--all-tables-with-prefix",
		"--skip-columns=guid", "--precise", "--format=count")
	if err != nil {
		return fail(err)
	}
	replaced, _ := strconv.ParseInt(strings.TrimSpace(cnt), 10, 64)
	if p.Noindex {
		if _, err := d.wpOK(ctx, dst, 60, nil, "option", "update", "blog_public", "0"); err != nil {
			return fail(err)
		}
	}
	return toData(contracts.WpCloneResult{Cloned: true, Replaced: replaced})
}

// copyDB: mariadb-dump (uid account) → pipe → mariadb (uid account) vào DB đích rỗng.
func (d *Deps) copyDB(ctx context.Context, a contracts.Account, from, to string) error {
	st, err := d.streamer()
	if err != nil {
		return err
	}
	cred, _, err := d.helperCred(a)
	if err != nil {
		return err
	}
	dbin, dargs, _ := backupDump(engMy, string(a.Username), from)
	ibin, iargs := restoreImportProc(engMy, string(a.Username), to)
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	var derr, ierr strings.Builder
	type res struct {
		code int
		err  error
	}
	dumped := make(chan res, 1)
	go func() {
		code, err := st.Stream(cctx, platform.Proc{Bin: dbin, Args: dargs, As: cred, Stdout: pw, Stderr: &derr})
		if err != nil || code != 0 {
			_ = pw.CloseWithError(io.ErrUnexpectedEOF)
		} else {
			_ = pw.Close()
		}
		dumped <- res{code, err}
	}()
	icode, ierrRun := st.Stream(cctx, platform.Proc{Bin: ibin, Args: iargs, As: cred, Stdin: pr, Stderr: &ierr})
	_ = pr.Close()
	dr := <-dumped
	if dr.err != nil || dr.code != 0 {
		return &registry.OpError{Code: "precondition_failed", Message: clip(dbin+" lỗi: "+strings.TrimSpace(derr.String()), 300)}
	}
	if ierrRun != nil || icode != 0 {
		return &registry.OpError{Code: "precondition_failed", Message: clip(ibin+" lỗi: "+strings.TrimSpace(ierr.String()), 300)}
	}
	return nil
}

// ---------- wp.harden ----------

func (d *Deps) wpHarden(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpHardenParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	s, err := d.site(p.Site)
	if err != nil {
		return nil, err
	}
	known := map[contracts.WpHardening]bool{"file_edit_disabled": true, "xmlrpc_blocked": true, "php_in_uploads_blocked": true,
		"wp_config_protected": true, "version_hidden": true, "salts_rotated": true}
	en := map[contracts.WpHardening]bool{}
	for _, h := range p.Enable {
		if !known[h] {
			return nil, wpInvalid("hardening không hợp lệ: %q", h)
		}
		en[h] = true
	}
	for _, h := range p.Disable {
		if !known[h] || en[h] {
			return nil, wpInvalid("hardening không hợp lệ hoặc vừa bật vừa tắt: %q", h)
		}
		if h == "salts_rotated" {
			return nil, wpInvalid("salts_rotated không tắt được")
		}
	}
	if err := d.requireWP(s); err != nil {
		return nil, err
	}
	st := d.wpLoadState(s)
	prev := st
	cfgRel := s.rel + "/wp-config.php"
	set := func(h contracts.WpHardening, on bool) error {
		switch h {
		case "file_edit_disabled":
			if on {
				_, err := d.wpOK(ctx, s, 60, nil, "config", "set", "DISALLOW_FILE_EDIT", "true", "--raw", "--type=constant")
				return err
			}
			cfg, _, err := d.readAs(ctx, s.acct, cfgRel, 524288)
			if err != nil || !reWPFileEdit.Match(cfg) {
				return err
			}
			_, err = d.wpOK(ctx, s, 60, nil, "config", "delete", "DISALLOW_FILE_EDIT", "--type=constant")
			return err
		case "xmlrpc_blocked":
			st.XMLRPCBlocked = on
		case "php_in_uploads_blocked":
			st.PHPInUploadsBlocked = on
		case "wp_config_protected":
			mode := uint32(0o640)
			if on {
				mode = 0o400
			}
			_, err := d.callFS(ctx, fsReq{acct: s.acct, op: "chmod", params: map[string]any{"paths": []string{cfgRel}, "mode": mode}})
			return err
		case "version_hidden":
			muRel := s.rel + "/" + WPHardeningPlugin
			if !on {
				ok, err := d.regular(s, muRel)
				if err != nil || !ok {
					return err
				}
				_, err = d.callFS(ctx, fsReq{acct: s.acct, op: "delete", params: map[string]any{"paths": []string{muRel}}})
				return err
			}
			if _, err := d.walkNoSymlink(s.home, path.Dir(muRel)); err != nil {
				return err
			}
			for _, dir := range []string{s.rel + "/wp-content", s.rel + "/wp-content/mu-plugins"} {
				if _, err := d.callFS(ctx, fsReq{acct: s.acct, op: "mkdir", params: map[string]any{"path": dir, "mode": uint32(0o755)}}); err != nil {
					return err
				}
			}
			mode := uint32(0o644)
			_, err := d.callFS(ctx, fsReq{acct: s.acct, op: "write", params: map[string]any{"path": muRel,
				"content_b64": base64.StdEncoding.EncodeToString([]byte(wpHardeningPHP)), "mode": mode}})
			return err
		case "salts_rotated":
			if _, err := d.wpOK(ctx, s, 60, nil, "config", "shuffle-salts"); err != nil {
				return err
			}
			st.SaltsRotatedAt = d.now().UTC().Format("2006-01-02T15:04:05Z")
		}
		return nil
	}
	// wp-config chỉ đọc (0400) chặn chính WP-CLI ghi: mở tạm khi cần sửa, khóa lại ở cuối.
	dis := map[contracts.WpHardening]bool{}
	for _, h := range p.Disable {
		dis[h] = true
	}
	wasProtected := d.wpConfigMode(s)&0o200 == 0
	wantProtected := en["wp_config_protected"] || (wasProtected && !dis["wp_config_protected"])
	if wasProtected && (en["file_edit_disabled"] || dis["file_edit_disabled"] || en["salts_rotated"]) {
		if err := set("wp_config_protected", false); err != nil {
			return nil, err
		}
	}
	for _, h := range []contracts.WpHardening{"file_edit_disabled", "xmlrpc_blocked", "php_in_uploads_blocked", "version_hidden", "salts_rotated"} {
		if en[h] || dis[h] {
			if err := set(h, en[h]); err != nil {
				return nil, err
			}
		}
	}
	if wantProtected != (d.wpConfigMode(s)&0o200 == 0) || en["wp_config_protected"] || dis["wp_config_protected"] {
		if err := set("wp_config_protected", wantProtected); err != nil {
			return nil, err
		}
	}
	if st != prev {
		if err := d.wpSaveState(s, st); err != nil {
			return nil, err
		}
	}
	cur, err := d.wpHardeningState(ctx, s)
	if err != nil {
		return nil, err
	}
	out := contracts.WpHardenResult{Applied: []contracts.WpHardening{},
		NeedsVhostReload: st.XMLRPCBlocked != prev.XMLRPCBlocked || st.PHPInUploadsBlocked != prev.PHPInUploadsBlocked}
	for h, on := range map[contracts.WpHardening]bool{"file_edit_disabled": cur.FileEditDisabled, "xmlrpc_blocked": cur.XmlrpcBlocked,
		"php_in_uploads_blocked": cur.PHPInUploadsBlocked, "wp_config_protected": cur.WpConfigProtected,
		"version_hidden": cur.VersionHidden, "salts_rotated": cur.SaltsRotated} {
		if on {
			out.Applied = append(out.Applied, h)
		}
	}
	sort.Slice(out.Applied, func(i, j int) bool { return out.Applied[i] < out.Applied[j] })
	return toData(out)
}

// ---------- wp.admin_password, wp.maintenance ----------

func (d *Deps) wpAdminPassword(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpAdminPasswordParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	s, err := d.site(p.Site)
	if err != nil {
		return nil, err
	}
	if !reWPUser.MatchString(p.User) {
		return nil, wpInvalid("user không hợp lệ")
	}
	if err := checkSecret(string(p.Password)); err != nil {
		return nil, err
	}
	if err := d.requireWP(s); err != nil {
		return nil, err
	}
	res, err := d.wp(ctx, s, 60, []byte(string(p.Password)+"\n"), "user", "update", p.User, "--skip-email", "--prompt=user_pass")
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		if strings.Contains(string(res.Stderr), "Invalid user") {
			return nil, &registry.OpError{Code: "not_found", Message: "không có user WordPress " + p.User}
		}
		return nil, wpFail([]string{"user", "update"}, res)
	}
	return toData(contracts.WpAdminPasswordResult{Changed: true})
}

func (d *Deps) wpMaintenance(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WpMaintenanceParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	s, err := d.site(p.Site)
	if err != nil {
		return nil, err
	}
	if err := d.requireWP(s); err != nil {
		return nil, err
	}
	res, err := d.wp(ctx, s, 30, nil, "maintenance-mode", "is-active")
	if err != nil {
		return nil, err
	}
	if active := res.ExitCode == 0; active != p.Enabled {
		sub := "deactivate"
		if p.Enabled {
			sub = "activate"
		}
		if _, err := d.wpOK(ctx, s, 60, nil, "maintenance-mode", sub); err != nil {
			return nil, err
		}
	}
	return toData(contracts.WpMaintenanceResult{Enabled: p.Enabled})
}

// wpProtected: wp-config không ai ghi được và nhóm/người khác không có quyền nào (0400/0440).
func wpProtected(m fs.FileMode) bool { return m != 0 && m&0o227 == 0 }
