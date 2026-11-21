package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

type backupRunParams struct {
	Repo         backup.RepoParams    `json:"repo"`
	Kind         string               `json:"kind"`
	Account      *contracts.Account   `json:"account"`
	WebsiteUUID  *string              `json:"website_uuid"`
	SiteDir      *string              `json:"site_dir"`
	Databases    []contracts.BackupDB `json:"databases"`
	Excludes     []string             `json:"excludes"`
	Tags         []string             `json:"tags"`
	AgeRecipient *string              `json:"age_recipient"`
	Meta         struct {
		PanelVersion string  `json:"panel_version"`
		ServerUUID   string  `json:"server_uuid"`
		AccountUUID  *string `json:"account_uuid"`
		Package      *string `json:"package"`
		Accounts     *int64  `json:"accounts,omitempty"`
	} `json:"meta"`
}

func bkInvalid(msg string) error { return &registry.OpError{Code: "invalid_params", Message: msg} }

// checkRun kiểm lại params backup.run theo loại (ADR 0031): repo account chỉ chứa dữ liệu đúng account đó.
func (p *backupRunParams) check(repo backup.Repo) error {
	for _, t := range p.Tags {
		if !backup.ValidTag(t) {
			return bkInvalid("tag không hợp lệ: " + t)
		}
	}
	if len(p.Tags) == 0 {
		return bkInvalid("thiếu tag")
	}
	for _, e := range p.Excludes {
		if !backup.ValidExclude(e) {
			return bkInvalid("mẫu loại trừ không hợp lệ: " + e)
		}
	}
	if len(p.Excludes) > 50 {
		return bkInvalid("quá 50 mẫu loại trừ")
	}
	if !reUUIDStr(p.Meta.ServerUUID) || !strings.HasPrefix(repo.Path, "itso/"+p.Meta.ServerUUID+"/") {
		return bkInvalid("meta.server_uuid không khớp đường dẫn repo")
	}
	acctRepo := repo.AccountUUID()
	switch p.Kind {
	case "files", "db":
		if p.Account == nil || acctRepo == "" || p.Meta.AccountUUID == nil || *p.Meta.AccountUUID != acctRepo {
			return bkInvalid("backup " + p.Kind + " cần account và repo của đúng account đó")
		}
		if p.AgeRecipient != nil {
			return bkInvalid("age_recipient chỉ dùng cho kind panel")
		}
		if p.Kind == "files" && len(p.Databases) > 0 {
			return bkInvalid("kind files không nhận databases")
		}
		if p.Kind == "db" && len(p.Databases) != 1 {
			return bkInvalid("kind db: mỗi lần một database")
		}
		if p.SiteDir != nil && (p.Kind != "files" || !validDomain(*p.SiteDir)) {
			return bkInvalid("site_dir không hợp lệ")
		}
	case "config", "panel":
		if p.Account != nil || acctRepo != "" || p.SiteDir != nil || len(p.Databases) > 0 {
			return bkInvalid("backup " + p.Kind + " chỉ ghi vào repo server, không có account")
		}
		if (p.Kind == "panel") != (p.AgeRecipient != nil) {
			return bkInvalid("age_recipient bắt buộc với panel và chỉ với panel")
		}
	default:
		return bkInvalid("kind không hợp lệ")
	}
	return nil
}

func reUUIDStr(s string) bool {
	return len(s) == 36 && strings.Count(s, "-") == 4 && strings.Trim(s, "0123456789abcdef-") == ""
}

func validDomain(s string) bool { return validate.Domain(s) == nil }

// PanelDB/PanelCluster: CSDL panel trên cluster PostgreSQL riêng.
const (
	PanelDB      = "itso"
	PanelCluster = "16/itso" // cluster riêng của panel (như itso update)
)

// backupPanel (ADR 0031 §4): pg_dump -Fc itso (dưới user postgres) ghi tạm vào staging root 0700 (tar cần kích
// thước trước), cộng cây /etc/itso → tar → age tới age_recipient → restic --stdin. Bản rõ không rời staging.
func (d *Deps) backupPanel(ctx context.Context, r *resticRun, p *backupRunParams, base []string, meta *backup.Meta) (backup.Summary, error) {
	st, err := d.streamer()
	if err != nil {
		return backup.Summary{}, err
	}
	cred, err := d.systemCred("postgres")
	if err != nil {
		return backup.Summary{}, err
	}
	dir, cleanup, err := d.staging("panel-" + path.Base(r.sess.Dir))
	if err != nil {
		return backup.Summary{}, err
	}
	defer cleanup()
	dumpPath := filepath.Join(dir, "itso.dump")
	f, err := os.OpenFile(dumpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return backup.Summary{}, opErr(err)
	}
	var derr strings.Builder
	code, err := st.Stream(ctx, platform.Proc{Bin: "pg_dump", Args: []string{"--cluster", PanelCluster, "-Fc", PanelDB}, As: cred, Stdout: f, Stderr: &derr})
	if cerr := f.Close(); err == nil && cerr != nil {
		err = cerr
	}
	if err != nil {
		return backup.Summary{}, &registry.OpError{Code: "dependency_unavailable", Message: "pg_dump: " + err.Error(), Retryable: true}
	}
	if code != 0 {
		return backup.Summary{}, &registry.OpError{Code: "precondition_failed", Message: "pg_dump lỗi: " + truncate(strings.TrimSpace(derr.String()), 300)}
	}
	etc, _ := d.FS.Path("/etc/itso")
	files, err := backup.PanelFiles(dumpPath, etc)
	if err != nil {
		return backup.Summary{}, opErr(err)
	}
	// Manifest: sha256 của chính file mã hóa trong snapshot (restore_test kiểm được mà không cần khóa riêng).
	pr, pw := io.Pipe()
	hw := backup.NewHashingWriter(pw)
	go func() {
		_ = pw.CloseWithError(backup.WritePanelArchive(hw, *p.AgeRecipient, files, d.now()))
	}()
	args := append(append([]string{}, base...), "--stdin", "--stdin-filename", "panel/itso-panel.tar.age")
	rcode, out, stderr, rerr := r.restic(ctx, "", pr, nil, dedupTags(args)...)
	_ = pr.CloseWithError(io.ErrClosedPipe)
	if rerr != nil {
		return backup.Summary{}, rerr
	}
	s, err := r.summary(rcode, out, stderr)
	if err != nil {
		return s, err
	}
	meta.Databases = []string{PanelDB}
	meta.Manifest = map[string]string{"panel/itso-panel.tar.age": hw.Sum()}
	return s, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (d *Deps) backupRun(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p backupRunParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	repo, err := backup.ParseRepo(p.Repo)
	if err != nil {
		return nil, bkErr(err)
	}
	if err := p.check(repo); err != nil {
		return nil, err
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	meta := backup.Meta{Version: 1, Kind: p.Kind, PanelVersion: p.Meta.PanelVersion, ServerUUID: p.Meta.ServerUUID,
		AccountUUID: p.Meta.AccountUUID, WebsiteUUID: p.WebsiteUUID, SiteDir: p.SiteDir, Package: p.Meta.Package,
		Accounts: p.Meta.Accounts, Databases: []string{}, CreatedAt: d.now().UTC().Format("2006-01-02T15:04:05Z"),
		Manifest: map[string]string{}}
	base := []string{"backup", "--json", "--quiet", "--host", p.Meta.ServerUUID}
	for _, t := range append([]string{"itso", "type:" + p.Kind}, p.Tags...) {
		base = append(base, "--tag", t)
	}
	base = dedupTags(base)
	var sum backup.Summary
	switch p.Kind {
	case "files":
		sum, err = d.backupFiles(ctx, r, &p, base, &meta)
	case "db":
		sum, err = d.backupDB(ctx, r, &p, base, &meta)
	case "config":
		sum, err = d.backupConfig(ctx, r, base, &meta)
	case "panel":
		sum, err = d.backupPanel(ctx, r, &p, base, &meta)
	}
	if err != nil {
		return nil, err
	}
	meta.SnapshotID = sum.SnapshotID
	mb, _ := json.Marshal(meta)
	h := sha256.Sum256(mb)
	// Snapshot phụ chứa itso-meta.json (ADR 0029 §5). Lỗi ở đây không làm mất snapshot chính nhưng op báo lỗi.
	margs := []string{"backup", "--json", "--quiet", "--host", p.Meta.ServerUUID, "--tag", backup.MetaTag,
		"--tag", "of:" + sum.SnapshotID[:8], "--stdin", "--stdin-filename", "itso-meta.json"}
	code, _, stderr, err := r.restic(ctx, "", strings.NewReader(string(mb)), nil, margs...)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	return toData(contracts.BackupRunResult{SnapshotID: contracts.ResticSnapshotID(sum.SnapshotID), SizeBytes: contracts.Bytes(sum.TotalBytes),
		BytesAdded: contracts.Bytes(sum.DataAdded), FilesNew: sum.FilesNew, DurationMs: int64(sum.TotalSeconds * 1000),
		ManifestSHA256: contracts.SHA256(hex.EncodeToString(h[:]))})
}

func dedupTags(args []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		if args[i] == "--tag" && i+1 < len(args) {
			if seen[args[i+1]] {
				i++
				continue
			}
			seen[args[i+1]] = true
			out = append(out, args[i], args[i+1])
			i++
			continue
		}
		out = append(out, args[i])
	}
	return out
}

func (r *resticRun) summary(code int, out []byte, stderr string) (backup.Summary, error) {
	// restic thoát 3 khi có file không đọc được nhưng snapshot vẫn tạo (cảnh báo); coi là thành công có snapshot.
	if code != 0 && code != 3 {
		return backup.Summary{}, r.fail(code, stderr)
	}
	s, err := backup.ParseSummary(out)
	if err != nil {
		return s, bkErr(err)
	}
	return s, nil
}

// backupFiles: cwd = home, đích "." (cả home) hoặc "sites/<domain>"; không theo symlink, một filesystem, loại trừ
// cố định + policy; manifest mẫu sha256 cho restore test (ADR 0031 §1, ADR 0033 §3).
func (d *Deps) backupFiles(ctx context.Context, r *resticRun, p *backupRunParams, base []string, meta *backup.Meta) (backup.Summary, error) {
	if _, err := d.lookupAccount(*p.Account); err != nil {
		return backup.Summary{}, err
	}
	home := homeOf(p.Account.Username)
	realHome, err := d.FS.Path(home)
	if err != nil {
		return backup.Summary{}, opErr(err)
	}
	target := "."
	if p.SiteDir != nil {
		target = "sites/" + *p.SiteDir
		fi, err := d.FS.Lstat(home + "/" + target)
		if err != nil || !fi.IsDir() {
			return backup.Summary{}, &registry.OpError{Code: "not_found", Message: "không có thư mục " + target + " (hoặc là symlink)"}
		}
	}
	meta.Manifest = backup.SampleManifest(realHome, target)
	args := append(append([]string{}, base...), "--one-file-system")
	args = append(args, backup.ExcludeArgs(realHome, p.Excludes)...)
	args = append(args, "--", target)
	code, out, stderr, err := r.restic(ctx, home, nil, nil, args...)
	if err != nil {
		return backup.Summary{}, err
	}
	s, err := r.summary(code, out, stderr)
	if err != nil {
		return s, err
	}
	backup.Recheck(realHome, meta.Manifest)
	return s, nil
}

// backupDump trả lệnh dump cho backup (D-84): MariaDB --single-transaction … --hex-blob, PostgreSQL -Fc.
func backupDump(e engine, u, name string) (string, []string, string) {
	if e == engMy {
		return "mariadb-dump", []string{"--user=" + u, "--single-transaction", "--quick", "--routines", "--triggers", "--events",
			"--hex-blob", "--no-tablespaces", name}, "db/" + name + ".sql"
	}
	return "pg_dump", []string{"-U", u, "-Fc", "--no-owner", "--no-acl", "-d", name}, "db/" + name + ".dump"
}

// backupDB: dump dưới uid account (danh tính chủ, D-71) → pipe → restic --stdin; dump lỗi thì hủy restic, không để
// lại snapshot dở.
func (d *Deps) backupDB(ctx context.Context, r *resticRun, p *backupRunParams, base []string, meta *backup.Meta) (backup.Summary, error) {
	db := p.Databases[0]
	e := engMy
	if db.Engine == "postgresql" {
		e = engPG
	}
	if err := CheckDBName(e, *p.Account, string(db.Name)); err != nil {
		return backup.Summary{}, opErr(err)
	}
	st, err := d.streamer()
	if err != nil {
		return backup.Summary{}, err
	}
	cred, _, err := d.helperCred(*p.Account)
	if err != nil {
		return backup.Summary{}, err
	}
	bin, dargs, fname := backupDump(e, string(p.Account.Username), string(db.Name))
	dctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	hw := backup.NewHashingWriter(pw)
	var derr strings.Builder
	type res struct {
		code int
		err  error
	}
	dumpDone := make(chan res, 1)
	go func() {
		code, err := st.Stream(dctx, platform.Proc{Bin: bin, Args: dargs, As: cred, Stdout: hw, Stderr: &derr})
		if err != nil || code != 0 {
			_ = pw.CloseWithError(io.ErrUnexpectedEOF)
			cancel() // hủy restic: không tạo snapshot từ dump dở
		} else {
			_ = pw.Close()
		}
		dumpDone <- res{code, err}
	}()
	args := append(append([]string{}, base...), "--tag", "db:"+string(db.Name), "--stdin", "--stdin-filename", fname)
	code, out, stderr, rerr := r.restic(dctx, "", pr, nil, dedupTags(args)...)
	_ = pr.Close()
	dr := <-dumpDone
	if dr.err != nil || dr.code != 0 {
		msg := strings.TrimSpace(derr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if dr.err != nil {
			return backup.Summary{}, &registry.OpError{Code: "dependency_unavailable", Message: bin + ": " + dr.err.Error(), Retryable: true}
		}
		return backup.Summary{}, &registry.OpError{Code: "precondition_failed", Message: bin + " lỗi: " + msg}
	}
	if rerr != nil {
		return backup.Summary{}, rerr
	}
	s, err := r.summary(code, out, stderr)
	if err != nil {
		return s, err
	}
	meta.Databases = []string{string(db.Name)}
	meta.Manifest = map[string]string{fname: hw.Sum()}
	return s, nil
}

// backupConfig: danh sách cố định dưới / (ADR 0031 §3); mục không tồn tại được bỏ qua.
func (d *Deps) backupConfig(ctx context.Context, r *resticRun, base []string, meta *backup.Meta) (backup.Summary, error) {
	var targets []string
	for _, p := range backup.ConfigPaths {
		if fi, err := d.FS.Lstat("/" + p); err == nil && fi.IsDir() {
			targets = append(targets, p)
		}
	}
	if len(targets) == 0 {
		return backup.Summary{}, &registry.OpError{Code: "not_found", Message: "không có thư mục cấu hình nào để backup"}
	}
	if res, err := d.Run.Run(ctx, platform.Cmd{Bin: "dpkg-query", Args: []string{"-W", "-f", "${Package}\t${Version}\n"}}); err == nil && res.ExitCode == 0 {
		meta.Packages = strings.Split(strings.TrimSpace(string(res.Stdout)), "\n")
	}
	args := append(append([]string{}, base...), "--one-file-system", "--")
	args = append(args, targets...)
	code, out, stderr, err := r.restic(ctx, "/", nil, nil, args...)
	if err != nil {
		return backup.Summary{}, err
	}
	return r.summary(code, out, stderr)
}
