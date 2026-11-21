package ops

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// Chuyển account giữa server (Phase 9, ADR 0038, D-93). Dữ liệu đi qua repo restic của account; các op ở đây chỉ
// kiểm tra (preflight/verify/http.check) và khóa/mở account (cutover/rollback). Không op nào nhận host hay đường
// dẫn tự do: http.check chỉ gọi 127.0.0.1 của chính node với Host header là domain đã kiểm.

// MigrationDir giữ trạng thái khóa/mở của từng lần chuyển (để rollback trả đúng những gì đã dừng).
const MigrationDir = "/var/lib/itso/migrations"

// migratingSuffix: include bảo trì cạnh include WAF (`include /etc/itso/waf/<uuid>.nginx*;` trong vhost).
const migratingSuffix = "-migrating"

// MaintenanceInclude là include nginx trả 503 (trang bảo trì) cho mọi yêu cầu trừ ACME, trong lúc cutover.
const MaintenanceInclude = `# Sinh bởi itso-agent (migrate.cutover): account đang chuyển server. Không sửa tay.
error_page 503 /itso-suspended.html;
location = /itso-suspended.html {
    root /var/lib/itso/suspended;
    internal;
}
set $itso_migrating 1;
if ($uri ~ "^/(itso-suspended\.html|\.well-known/acme-challenge/)") {
    set $itso_migrating 0;
}
if ($itso_migrating) {
    return 503;
}
`

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpHTTPCheck:        d.httpCheck,
			contracts.OpMigratePreflight: d.migratePreflight,
			contracts.OpMigrateVerify:    d.migrateVerify,
			contracts.OpMigrateCutover:   d.migrateCutover,
			contracts.OpMigrateRollback:  d.migrateRollback,
		}
	})
}

// ---------- http.check ----------

var reHTTPPath = regexp.MustCompile(`^/[A-Za-z0-9._~%/-]*$`)

func checkHTTPPath(p string) error {
	if len(p) > 512 || !reHTTPPath.MatchString(p) || strings.Contains(p, "//") {
		return invalid("path không hợp lệ")
	}
	lp := strings.ToLower(p)
	if strings.Contains(lp, "%2e") || strings.Contains(lp, "%2f") {
		return invalid("path không được mã hóa . hoặc /")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return invalid("path không được chứa . hoặc ..")
		}
	}
	return nil
}

func (d *Deps) httpAddr(scheme string) string {
	if a := d.HTTPAddrs[scheme]; a != "" {
		return a
	}
	if scheme == "https" {
		return "127.0.0.1:443"
	}
	return "127.0.0.1:80"
}

// doHTTPCheck gửi GET tới 127.0.0.1 của node với Host = host; không theo redirect; đọc tối đa 1 MiB thân.
func (d *Deps) doHTTPCheck(ctx context.Context, scheme, host, path string, expect []int64) contracts.HTTPCheckResult {
	addr := d.httpAddr(scheme)
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, addr) // luôn là địa chỉ cố định của node, bỏ qua DNS
		},
		// Đích là 127.0.0.1 của chính node; hợp lệ chứng chỉ được kiểm riêng (verify kind ssl).
		TLSClientConfig:       &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, //nolint:gosec
		ResponseHeaderTimeout: 10 * time.Second,
		DisableKeepAlives:     true,
		Proxy:                 nil,
	}
	cl := &http.Client{Transport: tr, Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	start := d.now()
	res := contracts.HTTPCheckResult{BodySHA256: json.RawMessage("null")}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+host+path, nil)
	if err == nil {
		req.Header.Set("User-Agent", "itso-agent/"+Version+" (http.check)")
		var resp *http.Response
		resp, err = cl.Do(req)
		if err == nil {
			h := sha256.New()
			_, _ = io.Copy(h, io.LimitReader(resp.Body, 1<<20))
			_ = resp.Body.Close()
			res.Status = int64(resp.StatusCode)
			res.BodySHA256 = json.RawMessage(strconv.Quote(hex.EncodeToString(h.Sum(nil))))
		}
	}
	res.DurationMs = time.Since(start).Milliseconds()
	if d.Now != nil {
		res.DurationMs = 0
	}
	for _, s := range expect {
		if s == res.Status {
			res.OK = true
		}
	}
	return res
}

func (d *Deps) httpCheck(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.HTTPCheckParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.Domain(string(p.Host)); err != nil {
		return nil, opErr(err)
	}
	if err := checkHTTPPath(string(p.Path)); err != nil {
		return nil, opErr(err)
	}
	if p.Scheme != "http" && p.Scheme != "https" {
		return nil, &registry.OpError{Code: "invalid_params", Message: "scheme phải là http hoặc https"}
	}
	return toData(d.doHTTPCheck(ctx, p.Scheme, string(p.Host), string(p.Path), p.ExpectStatus))
}

// ---------- migrate.preflight (chạy ở đích) ----------

type migrateRepoParams struct {
	Account       contracts.Account    `json:"account"`
	MigrationUUID string               `json:"migration_uuid"`
	Repo          backup.RepoParams    `json:"repo"`
	NeedBytes     int64                `json:"need_bytes"`
	PHPVersions   []string             `json:"php_versions"`
	Databases     []contracts.BackupDB `json:"databases"`
	Sites         []string             `json:"sites"`
	SnapshotID    string               `json:"snapshot_id"`
}

func (p *migrateRepoParams) check() error {
	if err := checkAccount(p.Account); err != nil {
		return opErr(err)
	}
	if !reUUIDStr(p.MigrationUUID) {
		return bkInvalid("migration_uuid không hợp lệ")
	}
	for _, s := range p.Sites {
		if !validDomain(s) {
			return bkInvalid("site không hợp lệ: " + s)
		}
	}
	for _, v := range p.PHPVersions {
		if validate.PHPVersion(v, false) != nil {
			return bkInvalid("php_version không hợp lệ: " + v)
		}
	}
	for _, db := range p.Databases {
		if err := CheckDBName(dbEngine(db.Engine), p.Account, string(db.Name)); err != nil {
			return err
		}
	}
	return nil
}

type preCheck = contracts.MigratePreflightResultChecksItem

func (d *Deps) diskFree(p string) (int64, bool) {
	rp, err := d.FS.Path(p)
	if err != nil {
		return 0, false
	}
	var st syscall.Statfs_t
	for rp != "/" && rp != "." {
		if syscall.Statfs(rp, &st) == nil {
			return int64(st.Bavail) * st.Bsize, true //nolint:gosec // Bsize dương
		}
		rp = rp[:max(strings.LastIndex(rp, "/"), 1)]
	}
	if syscall.Statfs("/", &st) == nil {
		return int64(st.Bavail) * st.Bsize, true //nolint:gosec
	}
	return 0, false
}

func (d *Deps) migratePreflight(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p migrateRepoParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := p.check(); err != nil {
		return nil, err
	}
	u, uid := string(p.Account.Username), int64(p.Account.UID)
	var checks []preCheck
	add := func(key, level, msg string) {
		checks = append(checks, preCheck{Key: key, Level: level, Message: truncate(msg, 500)})
	}

	// 1. Username/UID ở đích.
	us, err := d.users()
	if err != nil {
		return nil, opErr(err)
	}
	gs, err := d.groups()
	if err != nil {
		return nil, opErr(err)
	}
	userLvl, userMsg := "ok", fmt.Sprintf("username %s và uid %d còn trống", u, uid)
	for _, x := range us {
		switch {
		case x.Name == u && x.UID == uid && strings.HasPrefix(x.Gecos, "ITSO hosting"):
			userLvl, userMsg = "warn", "account đã có ở đích với đúng uid (chạy lại lần chuyển): dữ liệu sẽ bị ghi đè"
		case x.Name == u:
			userLvl, userMsg = "block", fmt.Sprintf("username %s đã có ở đích (uid %d)", u, x.UID)
		case x.UID == uid:
			userLvl, userMsg = "block", fmt.Sprintf("uid %d đã thuộc user %s ở đích", uid, x.Name)
		}
		if userLvl == "block" {
			break
		}
	}
	for _, g := range gs {
		if userLvl != "block" && g.GID == uid && g.Name != u {
			userLvl, userMsg = "block", fmt.Sprintf("gid %d đã thuộc group %s ở đích", uid, g.Name)
		}
	}
	add("username", userLvl, userMsg)

	// 2. Đĩa: cần + 10 % dự phòng.
	need := p.NeedBytes + p.NeedBytes/10
	if free, ok := d.diskFree(HomeBase); !ok {
		add("disk", "warn", "không đọc được dung lượng trống của "+HomeBase)
	} else if free < need {
		add("disk", "block", fmt.Sprintf("cần %d MB (gồm 10%% dự phòng), còn trống %d MB", need>>20, free>>20))
	} else {
		add("disk", "ok", fmt.Sprintf("cần %d MB, còn trống %d MB", need>>20, free>>20))
	}

	// 3. PHP.
	var missing []string
	for _, v := range p.PHPVersions {
		ver, err := d.pkgVersion(ctx, "php"+v+"-fpm")
		if err != nil {
			return nil, err
		}
		if ver == nil {
			missing = append(missing, v)
		}
	}
	switch {
	case len(p.PHPVersions) == 0:
		add("php", "ok", "account không dùng PHP")
	case len(missing) > 0:
		add("php", "block", "đích chưa cài PHP "+strings.Join(missing, ", ")+" (cài ở trang server trước)")
	default:
		add("php", "ok", "đích có PHP "+strings.Join(p.PHPVersions, ", "))
	}

	// 4. Database: engine chạy được, tên DB chưa có.
	dbLvl, dbMsgs := "ok", []string{}
	for _, db := range p.Databases {
		e := dbEngine(db.Engine)
		exists, err := d.dbExists(ctx, e, string(db.Name))
		if err != nil {
			dbLvl = "block"
			dbMsgs = append(dbMsgs, string(db.Engine)+" không dùng được ở đích")
			continue
		}
		if exists {
			if dbLvl != "block" {
				dbLvl = "warn"
			}
			dbMsgs = append(dbMsgs, "DB "+string(db.Name)+" đã có ở đích (sẽ bị ghi đè)")
		}
	}
	if len(p.Databases) == 0 {
		add("database", "ok", "account không có database")
	} else if len(dbMsgs) == 0 {
		add("database", "ok", fmt.Sprintf("%d database: engine sẵn sàng, tên còn trống", len(p.Databases)))
	} else {
		add("database", dbLvl, strings.Join(dbMsgs, "; "))
	}

	// 5. Domain chưa có vhost của account khác ở đích.
	taken, err := d.domainOwners()
	if err != nil {
		return nil, err
	}
	var clash []string
	for _, s := range p.Sites {
		if owner, ok := taken[s]; ok && owner != u {
			clash = append(clash, s+" (account "+owner+")")
		}
	}
	if len(clash) > 0 {
		add("domain", "block", "domain đã có trên server đích: "+strings.Join(clash, ", "))
	} else {
		add("domain", "ok", fmt.Sprintf("%d domain chưa có trên server đích", len(p.Sites)))
	}

	// 6. Đọc được repo (mật khẩu đúng, đích backup tới được).
	r, cleanup, err := d.openRepoRead(env, p.Repo)
	if err != nil {
		add("repo", "block", "không mở được repo: "+errMsg(err))
	} else {
		code, _, stderr, rerr := r.restic(ctx, "", nil, nil, "cat", "config")
		cleanup()
		switch {
		case rerr != nil:
			add("repo", "block", "không đọc được repo: "+errMsg(rerr))
		case code != 0:
			add("repo", "block", "không đọc được repo: "+errMsg(r.fail(code, stderr)))
		default:
			add("repo", "ok", "đích đọc được repo backup của account")
		}
	}

	ok := true
	for _, c := range checks {
		ok = ok && c.Level != "block"
	}
	return toData(contracts.MigratePreflightResult{OK: ok, Checks: checks})
}

func errMsg(err error) string {
	var oe *registry.OpError
	if errors.As(err, &oe) {
		return oe.Message
	}
	return err.Error()
}

var reServerName = regexp.MustCompile(`(?m)^\s*server_name\s+([^;]+);`)

// domainOwners trả domain → account từ các vhost do agent sinh.
func (d *Deps) domainOwners() (map[string]string, error) {
	names, err := d.FS.ReadDir(VhostDir)
	if err != nil {
		return nil, opErr(err)
	}
	out := map[string]string{}
	for _, n := range names {
		if !strings.HasPrefix(n, "itso-") || !strings.HasSuffix(n, ".conf") {
			continue
		}
		b, err := d.FS.ReadFile(VhostDir + "/" + n)
		if err != nil {
			return nil, opErr(err)
		}
		owner := ""
		if _, rest, ok := strings.Cut(string(firstLines(b, 2)), "· account "); ok {
			owner, _, _ = strings.Cut(rest, " ")
		}
		for _, m := range reServerName.FindAllStringSubmatch(string(b), -1) {
			for _, h := range strings.Fields(m[1]) {
				out[h] = owner
			}
		}
	}
	return out, nil
}

// ---------- migrate.verify (chạy ở đích, sau backup.restore) ----------

func (d *Deps) migrateVerify(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p migrateRepoParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := p.check(); err != nil {
		return nil, err
	}
	if !backup.ValidSnapshotID(p.SnapshotID) {
		return nil, bkInvalid("snapshot_id không hợp lệ")
	}
	usr, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	r, cleanup, err := d.openRepoRead(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	var checks []contracts.MigrationCheck
	add := func(kind, name string, ok bool, detail string) {
		if len(checks) < 500 {
			checks = append(checks, contracts.MigrationCheck{Kind: kind, Name: truncate(name, 255), OK: ok, Detail: truncate(detail, 500)})
		}
	}

	// 1. File: sha256 theo manifest của snapshot so với file đã khôi phục trong home.
	meta, err := d.metaOf(ctx, r, p.SnapshotID)
	if err != nil {
		return nil, err
	}
	home := homeOf(p.Account.Username)
	// Chuyển account mang theo thư mục site (backup.restore kind website) + DB; chỉ đối chiếu file mẫu dưới sites/<site>/.
	var keys []string
	for _, k := range sortedKeys(meta.Manifest) {
		for _, s := range p.Sites {
			if strings.HasPrefix(k, "sites/"+s+"/") && checkRelPath(k) == nil {
				keys = append(keys, k)
			}
		}
	}
	bad := 0
	for _, k := range keys {
		got, err := d.fileSHA(home + "/" + k)
		if err != nil || got != meta.Manifest[k] {
			bad++
			if bad <= 20 {
				detail := "sha256 khác"
				if err != nil {
					detail = "không đọc được: " + errMsg(err)
				}
				add("files", k, false, detail)
			}
		}
	}
	add("files", "manifest", bad == 0, fmt.Sprintf("%d/%d file mẫu khớp sha256", len(keys)-bad, len(keys)))

	// 2. Chủ sở hữu: mọi mục dưới sites/ thuộc uid account.
	wantUID := int(usr.UID)
	if d.Sandbox {
		wantUID = os.Getuid() // sandbox không chown được
	}
	foreign, total := d.foreignOwned(home+"/sites", wantUID)
	add("ownership", "sites", foreign == 0, fmt.Sprintf("%d/%d mục dưới sites/ thuộc uid %d", total-foreign, total, usr.UID))

	// 3. Database: dump trong repo khớp manifest, DB có ở đích, số bảng khớp (MariaDB).
	for _, db := range p.Databases {
		ok, detail, err := d.verifyDB(ctx, r, db)
		if err != nil {
			return nil, err
		}
		add("database", string(db.Name), ok, detail)
	}

	// 4. HTTP + SSL qua 127.0.0.1 của node.
	vh, err := d.accountVhosts(string(p.Account.Username))
	if err != nil {
		return nil, err
	}
	for _, s := range p.Sites {
		res := d.doHTTPCheck(ctx, "http", s, "/", nil)
		hok := res.Status >= 100 && res.Status < 500
		add("http", s, hok, fmt.Sprintf("HTTP %d qua 127.0.0.1", res.Status))
		tlsOn := false
		for _, b := range vh {
			if strings.Contains(string(b), " "+s) && strings.Contains(string(b), "listen 443") {
				tlsOn = true
			}
		}
		if !tlsOn {
			add("ssl", s, true, "site chưa bật HTTPS ở đích")
			continue
		}
		res = d.doHTTPCheck(ctx, "https", s, "/", nil)
		add("ssl", s, res.Status >= 100 && res.Status < 500, fmt.Sprintf("HTTPS %d qua 127.0.0.1", res.Status))
	}

	// 5. Cron: số job đã cài ở đích.
	units, err := d.accountCronUnits(string(p.Account.Username))
	if err != nil {
		return nil, err
	}
	add("cron", string(p.Account.Username), true, fmt.Sprintf("%d job cron đã cài ở đích", len(units)))

	ok := true
	for _, c := range checks {
		ok = ok && c.OK
	}
	return toData(contracts.MigrateVerifyResult{OK: ok, Checks: checks})
}

func (d *Deps) fileSHA(p string) (string, error) {
	fi, err := d.FS.Lstat(p)
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", errors.New("không phải file thường")
	}
	rp, err := d.FS.Path(p)
	if err != nil {
		return "", err
	}
	f, err := os.Open(rp) //nolint:gosec // đường dẫn trong home đã kiểm, không theo symlink (Lstat ở trên)
	if err != nil {
		return "", err
	}
	defer f.Close() //nolint:errcheck
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// foreignOwned đếm mục (không theo symlink) không thuộc uid; duyệt tối đa backup.ManifestMaxWalk mục.
func (d *Deps) foreignOwned(dir string, uid int) (int, int) {
	rp, err := d.FS.Path(dir)
	if err != nil {
		return 0, 0
	}
	foreign, total := 0, 0
	_ = walkNoFollow(rp, func(fi fs.FileInfo) bool {
		total++
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != uid {
			foreign++
		}
		return total < backup.ManifestMaxWalk
	})
	return foreign, total
}

func walkNoFollow(root string, fn func(fs.FileInfo) bool) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		fi, err := os.Lstat(root + "/" + e.Name())
		if err != nil {
			continue
		}
		if !fn(fi) {
			return io.EOF
		}
		if fi.IsDir() {
			if err := walkNoFollow(root+"/"+e.Name(), fn); errors.Is(err, io.EOF) {
				return err
			}
		}
	}
	return nil
}

// verifyDB: snapshot mới nhất có tag db:<tên> → dump khớp sha256 manifest; DB có ở đích; MariaDB: số bảng ở đích
// = số CREATE TABLE trong dump. PostgreSQL (-Fc nhị phân): báo số bảng ở đích.
func (d *Deps) verifyDB(ctx context.Context, r *resticRun, db contracts.BackupDB) (bool, string, error) {
	code, out, stderr, err := r.restic(ctx, "", nil, nil, "snapshots", "--json", "--tag", "db:"+string(db.Name))
	if err != nil {
		return false, "", err
	}
	if code != 0 {
		return false, "", r.fail(code, stderr)
	}
	var snaps []backup.Snapshot
	if err := json.Unmarshal(out, &snaps); err != nil {
		return false, "", opErr(err)
	}
	sort.Slice(snaps, func(i, j int) bool { return snaps[i].Time.After(snaps[j].Time) })
	snap := ""
	for _, s := range snaps { // bỏ bản pre-restore (đích tự tạo khi ghi đè), lấy bản dump mới nhất của nguồn
		if backup.ValidSnapshotID(s.ID) && !contains(s.Tags, "pre-restore") {
			snap = s.ID
			break
		}
	}
	if snap == "" {
		return false, "repo không có bản dump của DB này", nil
	}
	meta, err := d.metaOf(ctx, r, snap)
	if err != nil {
		return false, "", err
	}
	fname := dbFile(db)
	want, ok := meta.Manifest[fname]
	if !ok {
		return false, "snapshot không có " + fname, nil
	}
	hw := backup.NewHashingWriter(io.Discard)
	tc := &tableCounter{}
	code, _, stderr, err = r.restic(ctx, "", nil, io.MultiWriter(hw, tc), "dump", snap, "/"+fname)
	if err != nil {
		return false, "", err
	}
	if code != 0 {
		return false, "", r.fail(code, stderr)
	}
	if hw.Sum() != want {
		return false, "dump trong repo không khớp sha256 manifest", nil
	}
	e := dbEngine(db.Engine)
	exists, err := d.dbExists(ctx, e, string(db.Name))
	if err != nil {
		return false, "", err
	}
	if !exists {
		return false, "DB chưa có ở đích", nil
	}
	q := fmt.Sprintf("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=%s;\n", lit(string(db.Name)))
	if e == engPG {
		q = fmt.Sprintf("\\connect %s\nSELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_catalog=%s;\n",
			pgIdent(string(db.Name)), lit(string(db.Name)))
	}
	res, err := d.sql(ctx, e, q)
	if err != nil {
		return false, "", err
	}
	got, _ := strconv.Atoi(strings.TrimSpace(res))
	if e == engPG {
		return true, fmt.Sprintf("dump khớp sha256; %d bảng ở đích", got), nil
	}
	tc.flush()
	if got != tc.n {
		return false, fmt.Sprintf("dump có %d bảng, đích có %d", tc.n, got), nil
	}
	return true, fmt.Sprintf("dump khớp sha256; %d/%d bảng", got, tc.n), nil
}

// tableCounter đếm dòng mở đầu "CREATE TABLE" trong dump SQL (luồng).
type tableCounter struct {
	n    int
	line []byte
}

func (t *tableCounter) Write(p []byte) (int, error) {
	for _, c := range p {
		if c == '\n' {
			t.flush()
			continue
		}
		if len(t.line) < 16 {
			t.line = append(t.line, c)
		}
	}
	return len(p), nil
}

func (t *tableCounter) flush() {
	if strings.HasPrefix(string(t.line), "CREATE TABLE") {
		t.n++
	}
	t.line = t.line[:0]
}

// ---------- migrate.cutover / migrate.rollback ----------

// lockState là trạng thái đã ghi khi khóa account (để mở lại đúng những gì đã dừng).
type lockState struct {
	Username string   `json:"username"`
	Role     string   `json:"role"`
	Locked   bool     `json:"locked"`
	At       string   `json:"at"`
	Pools    []string `json:"pools"`
	Timers   []string `json:"timers"`
	Groups   []string `json:"groups"`
	Sites    []string `json:"sites"`
}

func statePath(migration, role string) string {
	return MigrationDir + "/" + migration + "-" + role + ".json"
}

func (d *Deps) readState(migration, role string) (*lockState, error) {
	b, err := d.FS.ReadFile(statePath(migration, role))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, opErr(err)
	}
	var s lockState
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, &registry.OpError{Code: "internal", Message: "trạng thái chuyển account hỏng: " + err.Error()}
	}
	return &s, nil
}

func (d *Deps) writeState(migration string, s *lockState) error {
	if err := d.mkdirs(MigrationDir); err != nil {
		return opErr(err)
	}
	if _, err := d.FS.EnsureDir(MigrationDir, 0o700, platform.Owner{}); err != nil {
		return opErr(err)
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	if _, err := d.FS.WriteAtomic(statePath(migration, s.Role), b, 0o600, platform.Owner{}); err != nil {
		return opErr(err)
	}
	return nil
}

type migrateRoleParams struct {
	Account       contracts.Account `json:"account"`
	MigrationUUID string            `json:"migration_uuid"`
	Role          string            `json:"role"`
}

func (d *Deps) decodeRole(env *envelope.Envelope) (*migrateRoleParams, *passwdEntry, error) {
	var p migrateRoleParams
	if err := decode(env, &p); err != nil {
		return nil, nil, err
	}
	if !reUUIDStr(p.MigrationUUID) {
		return nil, nil, bkInvalid("migration_uuid không hợp lệ")
	}
	if p.Role != "source" && p.Role != "target" {
		return nil, nil, bkInvalid("role phải là source hoặc target")
	}
	usr, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, nil, err
	}
	if !strings.HasPrefix(usr.Gecos, "ITSO hosting") {
		return nil, nil, &registry.OpError{Code: "precondition_failed", Message: "user không phải account ITSO"}
	}
	return &p, usr, nil
}

func (d *Deps) accountPoolUnits(u contracts.Username) ([]string, error) {
	vers, err := d.FS.ReadDir(phpConfBase)
	if err != nil {
		return nil, opErr(err)
	}
	var out []string
	for _, v := range vers {
		if validate.PHPVersion(v, false) == nil && d.FS.Exists(phpAcctDir(v, u)+"/php-fpm.conf") {
			out = append(out, PHPUnit(v, u))
		}
	}
	return out, nil
}

func (d *Deps) accountSiteUUIDs(u string) ([]string, error) {
	vh, err := d.accountVhosts(u)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, path := range sortedKeys(vh) {
		if id := strings.TrimSuffix(strings.TrimPrefix(path, VhostDir+"/itso-"), ".conf"); validate.UUID(id) == nil {
			out = append(out, id)
		}
	}
	return out, nil
}

// lockAccount: trang bảo trì 503 cho mọi site, dừng pool PHP + timer cron, gỡ khỏi nhóm SFTP/SSH, dừng phiên.
// Ghi trạng thái trước để rollback mở lại đúng. Idempotent: đã khóa thì trả lại thời điểm cũ.
func (d *Deps) lockAccount(ctx context.Context, p *migrateRoleParams, usr *passwdEntry) (*lockState, error) {
	if s, err := d.readState(p.MigrationUUID, p.Role); err != nil || (s != nil && s.Locked) {
		return s, err
	}
	u := string(p.Account.Username)
	st := &lockState{Username: u, Role: p.Role, Locked: true, At: d.now().UTC().Format(time.RFC3339)}
	pools, err := d.accountPoolUnits(p.Account.Username)
	if err != nil {
		return nil, err
	}
	for _, unit := range pools {
		if active, _, err := d.unitState(ctx, unit); err != nil {
			return nil, err
		} else if active {
			st.Pools = append(st.Pools, unit)
		}
	}
	timers, err := d.accountCronUnits(u)
	if err != nil {
		return nil, err
	}
	for _, t := range timers {
		if active, _, err := d.unitState(ctx, t+".timer"); err != nil {
			return nil, err
		} else if active {
			st.Timers = append(st.Timers, t+".timer")
		}
	}
	for _, g := range []string{SFTPGroup, SSHGroup} {
		if grp, err := d.groupByName(g); err != nil {
			return nil, opErr(err)
		} else if grp != nil && contains(grp.Members, u) {
			st.Groups = append(st.Groups, g)
		}
	}
	if st.Sites, err = d.accountSiteUUIDs(u); err != nil {
		return nil, err
	}
	if err := d.writeState(p.MigrationUUID, st); err != nil {
		return nil, err
	}
	// Trang bảo trì trước (khách thấy 503 thay vì lỗi 502 khi pool dừng).
	if len(st.Sites) > 0 {
		if err := d.setMaintenance(ctx, st.Sites, true); err != nil {
			return nil, err
		}
	}
	for _, unit := range append(append([]string{}, st.Pools...), st.Timers...) {
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "stop", unit); err != nil {
			return nil, err
		}
	}
	for _, g := range st.Groups {
		if _, err := d.setGroup(ctx, u, g, false); err != nil {
			return nil, err
		}
	}
	if err := d.stopIfActive(ctx, fmt.Sprintf("user-%d.slice", usr.UID)); err != nil {
		return nil, err
	}
	return st, nil
}

// unlockAccount mở lại theo trạng thái đã ghi (ngược thứ tự khóa).
func (d *Deps) unlockAccount(ctx context.Context, migration, role, u string) (bool, error) {
	st, err := d.readState(migration, role)
	if err != nil || st == nil || !st.Locked {
		return false, err
	}
	for _, g := range st.Groups {
		if _, err := d.setGroup(ctx, u, g, true); err != nil {
			return false, err
		}
	}
	for _, unit := range append(append([]string{}, st.Pools...), st.Timers...) {
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "start", unit); err != nil {
			return false, err
		}
	}
	if len(st.Sites) > 0 {
		if err := d.setMaintenance(ctx, st.Sites, false); err != nil {
			return false, err
		}
	}
	st.Locked = false
	return true, d.writeState(migration, st)
}

// setMaintenance ghi/xóa include bảo trì của các site rồi nginx -t + reload (lỗi thì hoàn tác).
func (d *Deps) setMaintenance(ctx context.Context, sites []string, on bool) error {
	nginxMu.Lock()
	defer nginxMu.Unlock()
	if err := d.mkdirs(WafDir); err != nil {
		return opErr(err)
	}
	changed := []string{}
	for _, id := range sites {
		path := WafIncludePath(id) + migratingSuffix
		var c bool
		var err error
		if on {
			c, err = d.FS.WriteAtomic(path, []byte(MaintenanceInclude), 0o644, platform.Owner{})
		} else {
			c, err = d.FS.Remove(path)
		}
		if err != nil {
			return opErr(err)
		}
		if c {
			changed = append(changed, path)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	if err := d.nginxTest(ctx); err != nil {
		for _, path := range changed {
			if on {
				_, _ = d.FS.Remove(path)
			} else {
				_, _ = d.FS.WriteAtomic(path, []byte(MaintenanceInclude), 0o644, platform.Owner{})
			}
		}
		return err
	}
	_, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service")
	return err
}

// migrate.cutover: source = khóa account (bảo trì + dừng pool/cron/SFTP); target = mở account ở đích (bật
// pool/timer, gỡ bảo trì nếu có, trả nhóm SFTP/SSH đã gỡ khi rollback trước đó).
func (d *Deps) migrateCutover(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, usr, err := d.decodeRole(env)
	if err != nil {
		return nil, err
	}
	if p.Role == "source" {
		st, err := d.lockAccount(ctx, p, usr)
		if err != nil {
			return nil, err
		}
		return toData(contracts.MigrateCutoverResult{Done: true, At: st.At})
	}
	// Đích: nếu trước đó đã bị khóa (rollback role=target), mở lại theo trạng thái; luôn bật pool + timer hiện có.
	if _, err := d.unlockAccount(ctx, p.MigrationUUID, "target", usr.Name); err != nil {
		return nil, err
	}
	pools, err := d.accountPoolUnits(p.Account.Username)
	if err != nil {
		return nil, err
	}
	timers, err := d.accountCronUnits(usr.Name)
	if err != nil {
		return nil, err
	}
	for _, t := range timers {
		pools = append(pools, t+".timer")
	}
	for _, unit := range pools {
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "enable", "--now", unit); err != nil {
			return nil, err
		}
	}
	sites, err := d.accountSiteUUIDs(usr.Name)
	if err != nil {
		return nil, err
	}
	if err := d.setMaintenance(ctx, sites, false); err != nil {
		return nil, err
	}
	return toData(contracts.MigrateCutoverResult{Done: true, At: d.now().UTC().Format(time.RFC3339)})
}

// migrate.rollback: target = khóa bản ở đích (như nguồn khi cutover); source = mở lại nguồn theo trạng thái đã ghi.
func (d *Deps) migrateRollback(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, usr, err := d.decodeRole(env)
	if err != nil {
		return nil, err
	}
	if p.Role == "target" {
		if _, err := d.lockAccount(ctx, p, usr); err != nil {
			return nil, err
		}
		return toData(contracts.MigrateRollbackResult{RolledBack: true})
	}
	done, err := d.unlockAccount(ctx, p.MigrationUUID, "source", usr.Name)
	if err != nil {
		return nil, err
	}
	return toData(contracts.MigrateRollbackResult{RolledBack: done})
}
