package ops

// Import từ panel khác trên cùng máy (Phase 12, D-108, ADR 0053):
//   - import.scan: CHỈ ĐỌC cấu hình aaPanel / HestiaCP / nginx thuần → kế hoạch (site, alias, docroot, PHP, SSL,
//     DB, cron, cảnh báo). Không theo include, không đọc nội dung website.
//   - import.copy: root đọc docroot nguồn bằng openat O_NOFOLLOW (fsx.SourceTar), helper uid account giải vào home
//     (restore_tar). Symlink/hardlink/socket/thiết bị bị bỏ, có giới hạn max_bytes.
//   - import.cutover / import.rollback: đổi tên vhost nguồn có trong kế hoạch, nginx -t (lỗi thì hoàn tác), reload.

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"path"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpImportScan:     d.importScan,
			contracts.OpImportCopy:     d.importCopy,
			contracts.OpImportCutover:  d.importCutover,
			contracts.OpImportRollback: d.importRollback,
		}
	})
}

const (
	AaVhostDir         = "/www/server/panel/vhost/nginx"
	aaVersionFile      = "/www/server/panel/class/common.py"
	HestiaUsersDir     = "/usr/local/hestia/data/users"
	hestiaConf         = "/usr/local/hestia/conf/hestia.conf"
	HestiaVhostDir     = "/etc/nginx/conf.d/domains"
	NginxConfD         = "/etc/nginx/conf.d"
	NginxDisabledDir   = "/etc/nginx/itso-disabled"
	ImportDisabledSufx = ".itso-disabled"
	importMaxEntries   = 2_000_000
	importMeasureMax   = 500_000
	importCertMax      = 64 << 10
)

var (
	reImportSrc     = regexp.MustCompile(`^/(www/wwwroot|home|var/www|srv)/[^\x00-\x1f]+$`)
	reImportSrcBad  = regexp.MustCompile(`(^|/)\.{1,2}(/|$)|//`)
	reImportVhost   = regexp.MustCompile(`^/(www/server/panel/vhost/nginx/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}\.conf|etc/nginx/conf\.d/(domains/)?[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}\.conf|etc/nginx/sites-enabled/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199})$`)
	reHestiaUser    = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	reHestiaKV      = regexp.MustCompile(`([A-Z_]+)='([^']*)'`)
	reHestiaBackend = regexp.MustCompile(`^PHP-([5-8])_([0-9])$`)
	reAaVersion     = regexp.MustCompile(`(?m)^\s*g\.version\s*=\s*['"]([0-9][0-9.]{0,15})['"]`)
	reHestiaVersion = regexp.MustCompile(`(?m)^VERSION='([0-9][0-9.]{0,15})'`)
	reCronField     = regexp.MustCompile(`^[0-9*/,-]{1,20}$`)
	certPrefixes    = []string{"/www/server/panel/vhost/cert/", "/etc/letsencrypt/", "/etc/ssl/", "/etc/nginx/", "/home/", "/usr/local/hestia/"}
	itsoPHPVersions = []string{"8.1", "8.2", "8.3", "8.4"}
)

// CheckImportSrc kiểm lại ImportSrcPath như contract.
func CheckImportSrc(p string) error {
	if len(p) > 4096 || !reImportSrc.MatchString(p) || reImportSrcBad.MatchString(p) || path.Clean(p) != p {
		return invalidOp("src: docroot nguồn không hợp lệ")
	}
	return nil
}

// CheckImportVhost kiểm lại ImportVhostPath như contract và từ chối vhost do ITSO quản lý.
func CheckImportVhost(p string) error {
	if len(p) > 512 || !reImportVhost.MatchString(p) {
		return invalidOp("vhost_paths: đường dẫn vhost không hợp lệ")
	}
	if strings.HasPrefix(path.Base(p), "itso-") {
		return invalidOp("vhost_paths: vhost do ITSO quản lý, không phải của panel nguồn")
	}
	return nil
}

// vhostMatchesSource: mỗi nguồn chỉ được đụng vào thư mục vhost của chính nó.
func vhostMatchesSource(src, p string) bool {
	switch src {
	case "aapanel":
		return strings.HasPrefix(p, AaVhostDir+"/")
	case "hestia":
		return strings.HasPrefix(p, HestiaVhostDir+"/")
	case "nginx":
		return strings.HasPrefix(p, VhostDir+"/") || (strings.HasPrefix(p, NginxConfD+"/") && !strings.HasPrefix(p, HestiaVhostDir+"/"))
	}
	return false
}

func checkImportSource(s contracts.ImportSource) error {
	if s != "aapanel" && s != "hestia" && s != "nginx" {
		return invalidOp("source: chỉ aapanel, hestia, nginx")
	}
	return nil
}

// importSrcOK: ngoài contract, từ chối docroot nằm trong home của account ITSO (có /home/<u>/.itso).
func (d *Deps) importSrcOK(src string) error {
	if err := CheckImportSrc(src); err != nil {
		return err
	}
	if rest, ok := strings.CutPrefix(src, HomeBase+"/"); ok {
		u, _, _ := strings.Cut(rest, "/")
		if d.FS.Exists(HomeBase + "/" + u + "/.itso") {
			return invalidOp("src: nằm trong home của account ITSO")
		}
	}
	return nil
}

// ---------- import.scan ----------

type importSite = contracts.ImportScanResultSitesItem

func (d *Deps) importScan(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ImportScanParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkImportSource(p.Source); err != nil {
		return nil, err
	}
	if p.MaxSites < 1 || p.MaxSites > 500 {
		return nil, invalidOp("max_sites: 1–500")
	}
	var (
		sites []importSite
		ver   *string
		err   error
	)
	switch p.Source {
	case "aapanel":
		sites, ver, err = d.scanAaPanel()
	case "hestia":
		sites, ver, err = d.scanHestia()
	default:
		sites, err = d.scanNginx()
	}
	if err != nil {
		return nil, err
	}
	res := contracts.ImportScanResult{SourceVersion: ver, Sites: []importSite{}}
	seen := map[string]bool{}
	for _, s := range sites {
		if seen[string(s.Domain)] {
			continue
		}
		seen[string(s.Domain)] = true
		if int64(len(res.Sites)) >= p.MaxSites {
			res.Truncated = true
			break
		}
		res.Sites = append(res.Sites, s)
	}
	return toData(res)
}

// vhostFiles liệt kê file vhost thường (hoặc symlink hợp lệ với nginx sites-enabled) trong dir, đã sắp xếp.
func (d *Deps) vhostFiles(dir string, suffixConf bool) ([]string, error) {
	if !d.FS.Exists(dir) {
		return nil, nil
	}
	names, err := d.FS.ReadDir(dir)
	if err != nil {
		return nil, opErr(err)
	}
	sort.Strings(names)
	var out []string
	for _, n := range names {
		p := dir + "/" + n
		if (suffixConf && !strings.HasSuffix(n, ".conf")) || CheckImportVhost(p) != nil {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// readVhost đọc file vhost (≤ 256 KB). Với sites-enabled cho phép symlink trỏ vào /etc/nginx/sites-available.
func (d *Deps) readVhost(p string) ([]byte, error) {
	fi, err := d.FS.Lstat(p)
	if err != nil {
		return nil, err
	}
	target := p
	if fi.Mode()&os.ModeSymlink != 0 {
		if !strings.HasPrefix(p, VhostDir+"/") {
			return nil, fmt.Errorf("%s là symlink", p)
		}
		t, err := d.FS.Readlink(p)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(t, "/") {
			t = path.Join(VhostDir, t)
		}
		t = path.Clean(t)
		if !strings.HasPrefix(t, "/etc/nginx/sites-available/") || strings.Count(t, "/") != 4 {
			return nil, fmt.Errorf("%s trỏ ra ngoài sites-available", p)
		}
		if fi, err = d.FS.Lstat(t); err != nil {
			return nil, err
		}
		target = t
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s không phải file thường", p)
	}
	if fi.Size() > nginxMaxFile {
		return nil, fmt.Errorf("%s lớn hơn 256 KB", p)
	}
	return d.FS.ReadFile(target)
}

// siteFromServer dựng mục kế hoạch từ khối server; ok=false nếu không có domain/docroot dùng được.
func (d *Deps) siteFromServer(s nginxServer, vhost, user string) (importSite, bool) {
	var names []string
	for _, n := range s.names {
		n = strings.ToLower(strings.TrimSuffix(n, "."))
		if validate.Domain(n) == nil && !slices.Contains(names, n) {
			names = append(names, n)
		}
	}
	root := path.Clean(s.root)
	if len(names) == 0 || s.root == "" || d.importSrcOK(root) != nil {
		return importSite{}, false
	}
	site := importSite{Domain: contracts.Domain(names[0]), Aliases: []contracts.Domain{}, Docroot: contracts.ImportSrcPath(root),
		VhostPath: contracts.ImportVhostPath(vhost), SystemUser: user,
		Databases: []contracts.ImportScanResultSitesItemDatabasesItem{}, Crons: []contracts.ImportScanResultSitesItemCronsItem{},
		Warnings: []contracts.ImportScanResultSitesItemWarningsItem{}}
	for _, a := range names[1:] {
		if len(site.Aliases) < 50 {
			site.Aliases = append(site.Aliases, contracts.Domain(a))
		}
	}
	if s.phpVer != "" {
		v := s.phpVer
		site.PHPVersion = &v
	}
	if s.proxy {
		warn(&site, "unsupported", "vhost dùng proxy_pass (ứng dụng chạy riêng): chỉ chép file tĩnh, cần cấu hình lại")
	}
	if s.cert != "" {
		d.siteCert(&site, s.cert)
	}
	d.finishSite(&site)
	return site, true
}

func warn(s *importSite, code, msg string) {
	s.Warnings = append(s.Warnings, contracts.ImportScanResultSitesItemWarningsItem{Code: code, Message: msg})
}

// siteCert đọc chứng chỉ (chỉ phần công khai, ≤ 64 KB) để lấy hạn; không đọc private key.
func (d *Deps) siteCert(s *importSite, p string) {
	p = path.Clean(p)
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\x00\n") || len(p) > 4096 ||
		!slices.ContainsFunc(certPrefixes, func(pre string) bool { return strings.HasPrefix(p, pre) }) {
		return
	}
	cp := p
	s.SSL.CertPath = &cp
	fi, err := d.FS.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > importCertMax {
		warn(s, "ssl_expired", "không đọc được chứng chỉ "+p+": sẽ xin chứng chỉ mới")
		return
	}
	b, err := d.FS.ReadFile(p)
	if err != nil {
		return
	}
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			warn(s, "ssl_expired", "chứng chỉ "+p+" không hợp lệ: sẽ xin chứng chỉ mới")
			return
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			warn(s, "ssl_expired", "chứng chỉ "+p+" không hợp lệ: sẽ xin chứng chỉ mới")
			return
		}
		na := c.NotAfter.UTC().Format(time.RFC3339)
		s.SSL.NotAfter = &na
		if c.NotAfter.Before(d.now()) {
			warn(s, "ssl_expired", "chứng chỉ hết hạn "+c.NotAfter.UTC().Format("2006-01-02")+": sẽ xin Let's Encrypt mới")
		}
		return
	}
}

// finishSite đo dung lượng docroot và thêm cảnh báo PHP.
func (d *Deps) finishSite(s *importSite) {
	if s.PHPVersion != nil && !slices.Contains(itsoPHPVersions, *s.PHPVersion) {
		warn(s, "php_missing", "PHP "+*s.PHPVersion+" không có trên ITSO (8.1–8.4): sẽ chạy bằng PHP "+PHPSupportedVersion+", cần kiểm tra tương thích")
	}
	m, err := fsx.MeasureSource(d.FS.Root, string(s.Docroot), importMeasureMax)
	if err != nil {
		warn(s, "symlink_outside", "docroot "+string(s.Docroot)+" không mở được an toàn (symlink hoặc không tồn tại)")
		return
	}
	s.Files, s.SizeBytes = m.Files, contracts.Bytes(m.Bytes)
	if m.SymlinksOutside > 0 {
		warn(s, "symlink_outside", strconv.FormatInt(m.SymlinksOutside, 10)+" symlink trỏ ra ngoài docroot: sẽ bị bỏ khi chép")
	}
	if m.Truncated {
		warn(s, "unsupported", "docroot có hơn "+strconv.Itoa(importMeasureMax)+" mục: dung lượng chỉ là ước lượng")
	}
}

func (d *Deps) scanAaPanel() ([]importSite, *string, error) {
	if !d.FS.Exists(AaVhostDir) {
		return nil, nil, &registry.OpError{Code: "not_found", Message: "không thấy aaPanel (thiếu " + AaVhostDir + ")"}
	}
	var ver *string
	if b, err := d.FS.ReadFile(aaVersionFile); err == nil && len(b) < 1<<20 {
		if m := reAaVersion.FindSubmatch(b); m != nil {
			v := string(m[1])
			ver = &v
		}
	}
	files, err := d.vhostFiles(AaVhostDir, true)
	if err != nil {
		return nil, nil, err
	}
	var out []importSite
	for _, f := range files {
		if strings.HasPrefix(path.Base(f), "0.") || path.Base(f) == "phpfpm_status.conf" {
			continue
		}
		out = append(out, d.sitesFromVhost(f, "www")...)
	}
	return out, ver, nil
}

func (d *Deps) sitesFromVhost(f, user string) []importSite {
	b, err := d.readVhost(f)
	if err != nil {
		return nil
	}
	servers, err := nginxServers(b)
	if err != nil {
		return nil
	}
	var out []importSite
	for _, s := range servers {
		if site, ok := d.siteFromServer(s, f, user); ok {
			// Một vhost thường có 2 khối server (80 và 443): gộp về một site.
			if i := slices.IndexFunc(out, func(x importSite) bool { return x.Domain == site.Domain }); i >= 0 {
				if out[i].SSL.CertPath == nil {
					out[i].SSL, out[i].Warnings = site.SSL, append(out[i].Warnings, site.Warnings...)
				}
				continue
			}
			out = append(out, site)
		}
	}
	return out
}

func (d *Deps) scanNginx() ([]importSite, error) {
	if !d.FS.Exists(VhostDir) && !d.FS.Exists(NginxConfD) {
		return nil, &registry.OpError{Code: "not_found", Message: "không thấy " + VhostDir + " hay " + NginxConfD}
	}
	user := "www-data"
	if b, err := d.FS.ReadFile(nginxConf); err == nil {
		if tree, err := parseNginx(b); err == nil {
			for _, x := range tree {
				if x.name == "user" && len(x.args) >= 1 && reHestiaUser.MatchString(x.args[0]) {
					user = x.args[0]
				}
			}
		}
	}
	a, err := d.vhostFiles(VhostDir, false)
	if err != nil {
		return nil, err
	}
	c, err := d.vhostFiles(NginxConfD, true)
	if err != nil {
		return nil, err
	}
	var out []importSite
	for _, f := range append(a, c...) {
		out = append(out, d.sitesFromVhost(f, user)...)
	}
	if len(out) == 0 {
		return nil, &registry.OpError{Code: "not_found", Message: "Không tìm thấy vhost nào có root/server_name trong " + VhostDir}
	}
	return out, nil
}

// hestiaRecords đọc file key='value' của HestiaCP (mỗi dòng một bản ghi), ≤ 1 MB.
func (d *Deps) hestiaRecords(p string) []map[string]string {
	fi, err := d.FS.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > 1<<20 {
		return nil
	}
	b, err := d.FS.ReadFile(p)
	if err != nil {
		return nil
	}
	var out []map[string]string
	for _, l := range strings.Split(string(b), "\n") {
		m := map[string]string{}
		for _, kv := range reHestiaKV.FindAllStringSubmatch(l, -1) {
			m[kv[1]] = kv[2]
		}
		if len(m) > 0 {
			out = append(out, m)
		}
	}
	return out
}

func (d *Deps) scanHestia() ([]importSite, *string, error) {
	if !d.FS.Exists(HestiaUsersDir) {
		return nil, nil, &registry.OpError{Code: "not_found", Message: "không thấy HestiaCP (thiếu " + HestiaUsersDir + ")"}
	}
	var ver *string
	if b, err := d.FS.ReadFile(hestiaConf); err == nil && len(b) < 1<<20 {
		if m := reHestiaVersion.FindSubmatch(b); m != nil {
			v := string(m[1])
			ver = &v
		}
	}
	users, err := d.FS.ReadDir(HestiaUsersDir)
	if err != nil {
		return nil, nil, opErr(err)
	}
	sort.Strings(users)
	var out []importSite
	for _, u := range users {
		if !reHestiaUser.MatchString(u) || u == "admin" && !d.FS.Exists(HestiaUsersDir+"/admin/web.conf") {
			continue
		}
		dir := HestiaUsersDir + "/" + u
		var mine []importSite
		for _, w := range d.hestiaRecords(dir + "/web.conf") {
			dom := strings.ToLower(w["DOMAIN"])
			if validate.Domain(dom) != nil {
				continue
			}
			root := HomeBase + "/" + u + "/web/" + dom + "/public_html"
			if cd := w["CUSTOM_DOCROOT"]; cd != "" {
				root = path.Clean(cd)
			}
			if d.importSrcOK(root) != nil {
				continue
			}
			vhost := HestiaVhostDir + "/" + dom + ".conf"
			if CheckImportVhost(vhost) != nil {
				continue
			}
			s := importSite{Domain: contracts.Domain(dom), Aliases: []contracts.Domain{}, Docroot: contracts.ImportSrcPath(root),
				VhostPath: contracts.ImportVhostPath(vhost), SystemUser: u,
				Databases: []contracts.ImportScanResultSitesItemDatabasesItem{}, Crons: []contracts.ImportScanResultSitesItemCronsItem{},
				Warnings: []contracts.ImportScanResultSitesItemWarningsItem{}}
			for _, a := range strings.Split(w["ALIAS"], ",") {
				a = strings.ToLower(strings.TrimSpace(a))
				if a != dom && validate.Domain(a) == nil && len(s.Aliases) < 50 {
					s.Aliases = append(s.Aliases, contracts.Domain(a))
				}
			}
			if m := reHestiaBackend.FindStringSubmatch(w["BACKEND"]); m != nil {
				v := m[1] + "." + m[2]
				s.PHPVersion = &v
			}
			if w["SSL"] == "yes" {
				d.siteCert(&s, HomeBase+"/"+u+"/conf/web/"+dom+"/ssl/"+dom+".crt")
			}
			if w["SUSPENDED"] == "yes" {
				warn(&s, "unsupported", "website đang bị tạm ngưng trên HestiaCP")
			}
			d.finishSite(&s)
			mine = append(mine, s)
		}
		// DB và cron của Hestia gắn theo user, không theo domain: chỉ gán khi user có đúng một website.
		if len(mine) == 1 {
			for _, r := range d.hestiaRecords(dir + "/db.conf") {
				if r["TYPE"] != "" && r["TYPE"] != "mysql" {
					continue
				}
				if n := r["DB"]; n != "" && len(n) <= 64 && len(mine[0].Databases) < 50 {
					mb, _ := strconv.ParseInt(r["U_DISK"], 10, 64)
					mine[0].Databases = append(mine[0].Databases, contracts.ImportScanResultSitesItemDatabasesItem{Name: n, SizeBytes: contracts.Bytes(mb << 20)})
				}
			}
			for _, r := range d.hestiaRecords(dir + "/cron.conf") {
				f := []string{r["MIN"], r["HOUR"], r["DAY"], r["MONTH"], r["WDAY"]}
				if !slices.ContainsFunc(f, func(x string) bool { return !reCronField.MatchString(x) }) && r["CMD"] != "" &&
					len(r["CMD"]) <= 1000 && len(mine[0].Crons) < 50 && r["SUSPENDED"] != "yes" {
					mine[0].Crons = append(mine[0].Crons, contracts.ImportScanResultSitesItemCronsItem{Schedule: strings.Join(f, " "), Command: r["CMD"]})
				}
			}
		}
		out = append(out, mine...)
	}
	return out, ver, nil
}

// ---------- import.copy ----------

func (d *Deps) importCopy(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ImportCopyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkImportSource(p.Source); err != nil {
		return nil, err
	}
	if err := d.importSrcOK(string(p.Src)); err != nil {
		return nil, err
	}
	if err := validate.RelPath(string(p.Dst)); err != nil {
		return nil, opErr(err)
	}
	if p.MaxBytes < 1 || p.MaxBytes > 2<<40 {
		return nil, invalidOp("max_bytes: 1 byte – 2 TiB")
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	// Mở thử trước khi gọi helper: symlink ở đường dẫn nguồn → từ chối sớm, không tạo gì ở đích.
	if fd, err := fsx.OpenNoFollow(d.FS.Root, string(p.Src)); err != nil {
		return nil, fsErr(err)
	} else {
		_ = os.NewFile(uintptr(fd), "src").Close()
	}
	pr, pw := io.Pipe()
	stats := make(chan fsx.SourceStats, 1)
	srcErr := make(chan error, 1)
	go func() {
		st, err := fsx.SourceTar(pw, d.FS.Root, string(p.Src), p.MaxBytes, importMaxEntries)
		stats <- st
		srcErr <- err
		_ = pw.CloseWithError(err)
	}()
	raw, herr := d.callFS(ctx, fsReq{acct: p.Account, op: "restore_tar", stdin: pr,
		params: map[string]any{"target": string(p.Dst), "max_total_bytes": p.MaxBytes, "max_entries": importMaxEntries}})
	_ = pr.CloseWithError(io.ErrClosedPipe)
	st, serr := <-stats, <-srcErr
	// Lỗi phía nguồn (vượt max_bytes, symlink) là nguyên nhân gốc khi có; ống bị đóng vì helper từ chối thì lấy lỗi helper.
	if serr != nil && (herr == nil || fsx.Code(serr) != "internal") {
		return nil, fsErr(serr)
	}
	if herr != nil {
		return nil, herr
	}
	var rr fsx.RestoreResult
	if err := json.Unmarshal(raw, &rr); err != nil {
		return nil, opErr(err)
	}
	res := contracts.ImportCopyResult{Files: st.Files, Bytes: contracts.Bytes(st.Bytes), SkippedReasons: []string{}}
	reasons := map[string]int64{}
	for k, v := range st.Skipped {
		reasons[k] += v
	}
	for _, s := range rr.Skipped {
		reasons[s.Reason]++
	}
	keys := make([]string, 0, len(reasons))
	for k, v := range reasons {
		res.Skipped += v
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if len(res.SkippedReasons) < 20 {
			res.SkippedReasons = append(res.SkippedReasons, fmt.Sprintf("%s: %d", k, reasons[k]))
		}
	}
	return toData(res)
}

// fsErr đổi lỗi fsx sang OpError.
func fsErr(err error) error {
	if c := fsx.Code(err); c != "" && c != "internal" {
		return &registry.OpError{Code: c, Message: err.Error()}
	}
	return opErr(err)
}

// ---------- import.cutover / import.rollback ----------

type vhostMove struct{ from, to string }

// disabledPath: vhost thư mục glob *.conf → thêm hậu tố; sites-enabled (nginx include sites-enabled/*) → chuyển
// sang /etc/nginx/itso-disabled/<import>/ cùng filesystem.
func disabledPath(importUUID, p string) string {
	if strings.HasPrefix(p, VhostDir+"/") {
		return NginxDisabledDir + "/" + importUUID + "/" + path.Base(p)
	}
	return p + ImportDisabledSufx
}

func (d *Deps) importVhostParams(src contracts.ImportSource, uuid contracts.UUID, paths []contracts.ImportVhostPath) ([]string, error) {
	if err := checkImportSource(src); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(uuid)); err != nil {
		return nil, opErr(err)
	}
	if len(paths) < 1 || len(paths) > 500 {
		return nil, invalidOp("vhost_paths: 1–500 mục")
	}
	var out []string
	for _, v := range paths {
		p := string(v)
		if err := CheckImportVhost(p); err != nil {
			return nil, err
		}
		if !vhostMatchesSource(string(src), p) {
			return nil, invalidOp("vhost_paths: " + p + " không thuộc nguồn " + string(src))
		}
		if slices.Contains(out, p) {
			return nil, invalidOp("vhost_paths: trùng " + p)
		}
		out = append(out, p)
		// HestiaCP tách vhost HTTPS ra <domain>.ssl.conf: đi cùng vhost chính.
		if src == "hestia" && !strings.HasSuffix(p, ".ssl.conf") {
			ssl := strings.TrimSuffix(p, ".conf") + ".ssl.conf"
			if !slices.Contains(out, ssl) && (d.FS.Exists(ssl) || d.FS.Exists(ssl+ImportDisabledSufx)) {
				out = append(out, ssl)
			}
		}
	}
	return out, nil
}

func (d *Deps) importCutover(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ImportCutoverParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	paths, err := d.importVhostParams(p.Source, p.ImportUUID, p.VhostPaths)
	if err != nil {
		return nil, err
	}
	var moves []vhostMove
	done := []contracts.ImportVhostPath{}
	for _, v := range paths {
		moves = append(moves, vhostMove{from: v, to: disabledPath(string(p.ImportUUID), v)})
	}
	if err := d.applyVhostMoves(ctx, moves, string(p.ImportUUID)); err != nil {
		return nil, err
	}
	for _, v := range paths {
		done = append(done, contracts.ImportVhostPath(v))
	}
	return toData(contracts.ImportCutoverResult{Disabled: done})
}

func (d *Deps) importRollback(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ImportRollbackParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	paths, err := d.importVhostParams(p.Source, p.ImportUUID, p.VhostPaths)
	if err != nil {
		return nil, err
	}
	var moves []vhostMove
	for _, v := range paths {
		moves = append(moves, vhostMove{from: disabledPath(string(p.ImportUUID), v), to: v})
	}
	if err := d.applyVhostMoves(ctx, moves, string(p.ImportUUID)); err != nil {
		return nil, err
	}
	done := []contracts.ImportVhostPath{}
	for _, v := range paths {
		done = append(done, contracts.ImportVhostPath(v))
	}
	return toData(contracts.ImportRollbackResult{Restored: done})
}

// applyVhostMoves đổi tên mọi mục (idempotent: mục đã ở đích thì bỏ qua), nginx -t, lỗi thì hoàn tác; rồi reload.
func (d *Deps) applyVhostMoves(ctx context.Context, moves []vhostMove, importUUID string) error {
	nginxMu.Lock()
	defer nginxMu.Unlock()
	var todo []vhostMove
	for _, m := range moves {
		fromOK, toOK := d.lexists(m.from), d.lexists(m.to)
		switch {
		case fromOK && toOK:
			return &registry.OpError{Code: "precondition_failed", Message: "cả " + m.from + " và " + m.to + " cùng tồn tại"}
		case fromOK:
			if fi, err := d.FS.Lstat(m.from); err != nil || !(fi.Mode().IsRegular() || fi.Mode()&os.ModeSymlink != 0 && strings.Contains(m.from+m.to, "/sites-enabled/")) {
				return &registry.OpError{Code: "precondition_failed", Message: m.from + " không phải file vhost"}
			}
			todo = append(todo, m)
		case !toOK:
			return &registry.OpError{Code: "not_found", Message: "không có " + m.from}
		}
	}
	if len(todo) == 0 {
		return nil
	}
	if slices.ContainsFunc(todo, func(m vhostMove) bool { return strings.HasPrefix(m.to, NginxDisabledDir+"/") }) {
		if err := d.ensureTree(NginxDisabledDir+"/"+importUUID, 0o700); err != nil {
			return opErr(err)
		}
	}
	var applied []vhostMove
	undo := func() {
		for i := len(applied) - 1; i >= 0; i-- {
			_ = d.FS.Rename(applied[i].to, applied[i].from)
		}
	}
	for _, m := range todo {
		if err := d.FS.Rename(m.from, m.to); err != nil {
			undo()
			return opErr(err)
		}
		applied = append(applied, m)
	}
	if err := d.nginxTest(ctx); err != nil {
		undo()
		return err
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service"); err != nil {
		undo()
		return err
	}
	return nil
}

func (d *Deps) lexists(p string) bool {
	_, err := d.FS.Lstat(p)
	return err == nil
}
