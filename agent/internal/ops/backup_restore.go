package ops

// Khôi phục, kiểm chứng, forget, backup panel (Phase 8.3; ADR 0031 §4, ADR 0032, ADR 0033 §3).

import (
	"archive/tar"
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpBackupRestore:     d.backupRestore,
			contracts.OpBackupCheck:       d.backupCheck,
			contracts.OpBackupRestoreTest: d.backupRestoreTest,
			contracts.OpBackupForget:      d.backupForget,
		}
	})
}

// Giới hạn khôi phục qua helper (quota đĩa của account vẫn chặn ở tầng filesystem).
const (
	restoreMaxBytes   = 500 << 30
	restoreMaxEntries = 2_000_000
)

type restoreItem struct {
	Kind       string              `json:"kind"`
	Path       string              `json:"path,omitempty"`
	SiteDir    string              `json:"site_dir,omitempty"`
	DB         *contracts.BackupDB `json:"db,omitempty"`
	TargetName string              `json:"target_name,omitempty"`
}

func dbEngine(e contracts.DBEngine) engine {
	if e == "postgresql" {
		return engPG
	}
	return engMy
}

// staging tạo /var/lib/itso/restore/<uuid> (root 0700) và trả đường dẫn thật + hàm dọn.
func (d *Deps) staging(name string) (string, func(), error) {
	sys := backup.StagingRoot + "/" + name
	if err := d.ensureTree(backup.StagingRoot, 0o700); err != nil {
		return "", nil, opErr(err)
	}
	_ = d.FS.RemoveTree(sys)
	if err := d.ensureTree(sys, 0o700); err != nil {
		return "", nil, opErr(err)
	}
	real, _ := d.FS.Path(sys)
	return real, func() { _ = d.FS.RemoveTree(sys) }, nil
}

func (d *Deps) backupRestore(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo           backup.RepoParams `json:"repo"`
		SnapshotID     string            `json:"snapshot_id"`
		RestoreUUID    string            `json:"restore_uuid"`
		Account        contracts.Account `json:"account"`
		Mode           string            `json:"mode"`
		Items          []json.RawMessage `json:"items"`
		PreRestoreTags []string          `json:"pre_restore_tags"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !backup.ValidSnapshotID(p.SnapshotID) || !reUUIDStr(p.RestoreUUID) {
		return nil, bkInvalid("snapshot_id hoặc restore_uuid không hợp lệ")
	}
	for _, t := range p.PreRestoreTags {
		if !backup.ValidTag(t) {
			return nil, bkInvalid("tag không hợp lệ: " + t)
		}
	}
	items := make([]restoreItem, 0, len(p.Items))
	for _, raw := range p.Items {
		var it restoreItem
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&it); err != nil {
			return nil, bkInvalid("item: " + err.Error())
		}
		switch it.Kind {
		case "files":
			if err := checkRelPath(it.Path); err != nil || it.Path == "." {
				return nil, bkInvalid("item files: path không hợp lệ")
			}
			if p.Mode == "overwrite" {
				return nil, bkInvalid("file lẻ luôn khôi phục vào backups/restore-<ts>/ (chế độ new)")
			}
		case "website":
			if !validDomain(it.SiteDir) {
				return nil, bkInvalid("site_dir không hợp lệ")
			}
		case "database":
			if it.DB == nil {
				return nil, bkInvalid("thiếu db")
			}
			e := dbEngine(it.DB.Engine)
			if err := CheckDBName(e, p.Account, string(it.DB.Name)); err != nil {
				return nil, err
			}
			if err := CheckDBName(e, p.Account, it.TargetName); err != nil {
				return nil, err
			}
			if (p.Mode == "overwrite") != (it.TargetName == string(it.DB.Name)) {
				return nil, bkInvalid("ghi đè: target_name = tên DB; bản mới: target_name khác tên DB")
			}
		default:
			return nil, bkInvalid("loại item không hợp lệ")
		}
		items = append(items, it)
	}
	if len(items) == 0 || (p.Mode == "overwrite" && len(items) != 1) {
		return nil, bkInvalid("ghi đè: mỗi lần đúng một website hoặc một database")
	}
	repo, err := backup.ParseRepo(p.Repo)
	if err != nil {
		return nil, bkErr(err)
	}
	if repo.AccountUUID() == "" {
		return nil, bkInvalid("khôi phục dữ liệu account cần repo account")
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	ts := d.now().UTC().Format("20060102-150405")
	res := contracts.BackupRestoreResult{RestoredPaths: []contracts.RelPath{}, Databases: []contracts.DBName{},
		Skipped: []contracts.BackupRestoreResultSkippedItem{}}
	var files []string
	for _, it := range items {
		if it.Kind == "files" {
			files = append(files, it.Path)
		}
	}
	if len(files) > 0 {
		target := "backups/restore-" + ts
		if err := d.restoreTree(ctx, r, p.SnapshotID, p.RestoreUUID, p.Account, files, "", target, &res); err != nil {
			return nil, err
		}
		res.RestoredPaths = append(res.RestoredPaths, contracts.RelPath(target))
	}
	for _, it := range items {
		switch it.Kind {
		case "website":
			if err := d.restoreWebsite(ctx, r, &p.Account, p.SnapshotID, p.RestoreUUID, it.SiteDir, p.Mode, ts, p.PreRestoreTags, &res); err != nil {
				return nil, err
			}
		case "database":
			if err := d.restoreDatabase(ctx, r, &p.Account, p.SnapshotID, it, p.Mode, p.PreRestoreTags, &res); err != nil {
				return nil, err
			}
		}
	}
	return toData(res)
}

// restoreTree: restic restore vào staging root 0700 → tar từ staging/<sub> → helper uid account giải vào target mới.
func (d *Deps) restoreTree(ctx context.Context, r *resticRun, snap, restoreUUID string, a contracts.Account, includes []string,
	sub, target string, res *contracts.BackupRestoreResult) error {
	stage, clean, err := d.staging(restoreUUID)
	if err != nil {
		return err
	}
	defer clean()
	args := []string{"restore", snap, "--target", stage}
	for _, inc := range includes {
		args = append(args, "--include", "/"+inc)
	}
	code, _, stderr, err := r.restic(ctx, "", nil, nil, args...)
	if err != nil {
		return err
	}
	if code != 0 {
		return r.fail(code, stderr)
	}
	src := stage
	if sub != "" {
		src = filepath.Join(stage, filepath.FromSlash(sub))
	}
	if fi, err := os.Lstat(src); err != nil || !fi.IsDir() {
		return &registry.OpError{Code: "not_found", Message: "snapshot không có " + strings.Join(includes, ", ")}
	}
	pr, pw := io.Pipe()
	go func() { _ = pw.CloseWithError(stagingTar(pw, src)) }()
	raw, herr := d.callFS(ctx, fsReq{acct: a, op: "restore_tar", stdin: pr,
		params: map[string]any{"target": target, "max_total_bytes": restoreMaxBytes, "max_entries": restoreMaxEntries}})
	_ = pr.Close()
	if herr != nil {
		return herr
	}
	var rr fsx.RestoreResult
	if err := json.Unmarshal(raw, &rr); err != nil {
		return opErr(err)
	}
	for _, s := range rr.Skipped {
		if len(res.Skipped) < 1000 {
			res.Skipped = append(res.Skipped, contracts.BackupRestoreResultSkippedItem{Path: contracts.RelPath(target + "/" + s.Path), Reason: s.Reason})
		}
	}
	return nil
}

// stagingTar ghi cây src (staging do agent sở hữu) thành tar: thư mục, file thường (giữ bit đặc biệt để helper báo
// "setuid" rồi bỏ), symlink và thiết bị chỉ ghi header để helper ghi nhận và bỏ qua. Không theo symlink.
func stagingTar(w io.Writer, src string) error {
	bw := bufio.NewWriterSize(w, 256<<10)
	tw := tar.NewWriter(bw)
	err := filepath.WalkDir(src, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil || rel == "." {
			return err
		}
		name := filepath.ToSlash(rel)
		info, err := de.Info()
		if err != nil {
			return err
		}
		mode := int64(info.Mode().Perm())
		if info.Mode()&fs.ModeSetuid != 0 {
			mode |= 0o4000
		}
		if info.Mode()&fs.ModeSetgid != 0 {
			mode |= 0o2000
		}
		switch {
		case de.IsDir():
			return tw.WriteHeader(&tar.Header{Name: name + "/", Typeflag: tar.TypeDir, Mode: mode, Format: tar.FormatPAX})
		case info.Mode().IsRegular():
			fd, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
			if err != nil {
				return err
			}
			defer fd.Close()
			st, err := fd.Stat()
			if err != nil || !st.Mode().IsRegular() {
				return fmt.Errorf("%s đổi loại trong lúc khôi phục", name)
			}
			if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: mode, Size: st.Size(), ModTime: st.ModTime(), Format: tar.FormatPAX}); err != nil {
				return err
			}
			_, err = io.CopyN(tw, fd, st.Size())
			return err
		case info.Mode()&fs.ModeSymlink != 0:
			return tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeSymlink, Linkname: "x", Format: tar.FormatPAX})
		default:
			return tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeFifo, Format: tar.FormatPAX})
		}
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return bw.Flush()
}

// restoreWebsite (ADR 0032 §3–4): luôn giải vào sites/<domain>.restore-<ts>; ghi đè = snapshot pre-restore của bản
// đang chạy rồi hoán đổi nguyên tử (bản cũ giữ ở .restore-<ts>).
func (d *Deps) restoreWebsite(ctx context.Context, r *resticRun, a *contracts.Account, snap, restoreUUID, site, mode, ts string,
	tags []string, res *contracts.BackupRestoreResult) error {
	cur := "sites/" + site
	target := cur + ".restore-" + ts
	home := homeOf(a.Username)
	exists := false
	if fi, err := d.FS.Lstat(home + "/" + cur); err == nil {
		if !fi.IsDir() {
			return &registry.OpError{Code: "precondition_failed", Message: cur + " không phải thư mục (symlink?)"}
		}
		exists = true
	}
	if mode == "overwrite" && exists {
		id, err := d.preRestoreFiles(ctx, r, a, site, tags)
		if err != nil {
			return err
		}
		res.PreRestoreSnapshotID = rawStr(string(*id))
	}
	if err := d.restoreTree(ctx, r, snap, restoreUUID, *a, []string{cur}, cur, target, res); err != nil {
		return err
	}
	if mode != "overwrite" {
		res.RestoredPaths = append(res.RestoredPaths, contracts.RelPath(target))
		return nil
	}
	op, params := "exchange", map[string]any{"from": cur, "to": target}
	if !exists {
		op, params = "rename", map[string]any{"from": target, "to": cur}
	}
	if _, err := d.callFS(ctx, fsReq{acct: *a, op: op, params: params}); err != nil {
		return err
	}
	res.RestoredPaths = append(res.RestoredPaths, contracts.RelPath(cur))
	return nil
}

func preTags(tags []string, extra ...string) []string {
	out := []string{"--tag", "itso", "--tag", "pre-restore"}
	for _, t := range append(extra, tags...) {
		out = append(out, "--tag", t)
	}
	return dedupTags(out)
}

func (d *Deps) preRestoreFiles(ctx context.Context, r *resticRun, a *contracts.Account, site string, tags []string) (*contracts.ResticSnapshotID, error) {
	base := append([]string{"backup", "--json", "--quiet", "--host", r.repo.ServerUUID()}, preTags(tags, "type:files")...)
	rp := &backupRunParams{Account: a, SiteDir: &site}
	m := backup.Meta{}
	s, err := d.backupFiles(ctx, r, rp, base, &m)
	if err != nil {
		return nil, err
	}
	id := contracts.ResticSnapshotID(s.SnapshotID)
	return &id, nil
}

// restoreDatabase: restic dump → nhập dưới uid account (danh tính chủ). Bản mới: DB đích chưa tồn tại, tạo mới.
// Ghi đè: dump bản hiện tại vào snapshot pre-restore, xóa + tạo lại DB rồi nhập.
func (d *Deps) restoreDatabase(ctx context.Context, r *resticRun, a *contracts.Account, snap string, it restoreItem, mode string,
	tags []string, res *contracts.BackupRestoreResult) error {
	e := dbEngine(it.DB.Engine)
	if err := d.dbAccount(*a); err != nil {
		return err
	}
	if _, err := d.ownerEnsure(ctx, e, *a); err != nil {
		return err
	}
	exists, err := d.dbExists(ctx, e, it.TargetName)
	if err != nil {
		return err
	}
	switch {
	case mode == "new" && exists:
		return &registry.OpError{Code: "already_exists", Message: "database " + it.TargetName + " đã tồn tại"}
	case mode == "overwrite" && exists:
		rp := &backupRunParams{Account: a, Databases: []contracts.BackupDB{*it.DB}}
		base := append([]string{"backup", "--json", "--quiet", "--host", "itso"}, preTags(tags, "type:db")...)
		m := backup.Meta{}
		s, err := d.backupDB(ctx, r, rp, base, &m)
		if err != nil {
			return err
		}
		res.PreRestoreSnapshotID = rawStr(s.SnapshotID)
		drop := fmt.Sprintf("DROP DATABASE IF EXISTS %s;\n", myIdent(it.TargetName))
		if e == engPG {
			drop = fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE);\n", pgIdent(it.TargetName))
		}
		if _, err := d.sql(ctx, e, drop); err != nil {
			return err
		}
	}
	if _, err := d.sql(ctx, e, CreateSQL(e, string(a.Username), it.TargetName, "utf8mb4")); err != nil {
		return err
	}
	_, _, fname := backupDump(e, string(a.Username), string(it.DB.Name))
	cred, _, err := d.helperCred(*a)
	if err != nil {
		return err
	}
	bin, args := restoreImportProc(e, string(a.Username), it.TargetName)
	if err := d.dumpInto(ctx, r, snap, "/"+fname, platform.Proc{Bin: bin, Args: args, As: cred}); err != nil {
		if !exists || mode == "new" {
			_, _ = d.sql(ctx, e, fmt.Sprintf("DROP DATABASE IF EXISTS %s;\n", map[engine]string{engMy: myIdent(it.TargetName), engPG: pgIdent(it.TargetName)}[e]))
		}
		return err
	}
	res.Databases = append(res.Databases, contracts.DBName(it.TargetName))
	return nil
}

// restoreImportProc: MariaDB nhập SQL, PostgreSQL nhập định dạng custom (-Fc) bằng pg_restore.
func restoreImportProc(e engine, u, name string) (string, []string) {
	if e == engMy {
		return "mariadb", []string{"--user=" + u, "--batch", name}
	}
	return "pg_restore", []string{"-U", u, "--no-owner", "--no-acl", "--exit-on-error", "-d", name}
}

// dumpInto: `restic dump <snap> <file>` → stdin của tiến trình p.
func (d *Deps) dumpInto(ctx context.Context, r *resticRun, snap, file string, p platform.Proc) error {
	st, err := d.streamer()
	if err != nil {
		return err
	}
	ictx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	var ierr strings.Builder
	p.Stdin, p.Stderr = pr, &ierr
	type res struct {
		code int
		err  error
	}
	ch := make(chan res, 1)
	go func() {
		code, err := st.Stream(ictx, p)
		_ = pr.CloseWithError(io.ErrClosedPipe)
		if err != nil || code != 0 {
			cancel()
		}
		ch <- res{code, err}
	}()
	code, _, stderr, rerr := r.restic(ictx, "", nil, pw, "dump", snap, file)
	_ = pw.Close()
	ir := <-ch
	if rerr != nil {
		return rerr
	}
	if code != 0 && ir.code == 0 {
		return r.fail(code, stderr)
	}
	if ir.err != nil {
		return &registry.OpError{Code: "dependency_unavailable", Message: p.Bin + ": " + ir.err.Error(), Retryable: true}
	}
	if ir.code != 0 {
		msg := strings.TrimSpace(ierr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("%s lỗi (mã %d): %s", p.Bin, ir.code, msg)}
	}
	return nil
}

// ---------------------------------------------------------------- backup.check

func (d *Deps) backupCheck(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo            backup.RepoParams `json:"repo"`
		ReadDataPercent int               `json:"read_data_percent"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if p.ReadDataPercent < 0 || p.ReadDataPercent > 100 {
		return nil, bkInvalid("read_data_percent ngoài 0–100")
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	args := []string{"check"}
	if p.ReadDataPercent > 0 {
		args = append(args, fmt.Sprintf("--read-data-subset=%d%%", p.ReadDataPercent))
	}
	start := d.now()
	code, out, stderr, err := r.restic(ctx, "", nil, nil, args...)
	if err != nil {
		return nil, err
	}
	res := contracts.BackupCheckResult{OK: code == 0, Errors: []string{}, DurationMs: d.now().Sub(start).Milliseconds()}
	if code != 0 {
		if e := backup.Classify(code, stderr); e.Code == "repo_auth_failed" || e.Code == "repo_not_initialized" || e.Code == "repo_locked" || e.Code == "dependency_unavailable" {
			return nil, bkErr(e)
		}
		for _, l := range strings.Split(string(out)+"\n"+stderr, "\n") {
			l = strings.TrimSpace(backup.Redact(l))
			if l != "" && len(res.Errors) < 100 && (strings.Contains(strings.ToLower(l), "error") || strings.Contains(l, "Fatal") ||
				strings.Contains(l, "pack") || strings.Contains(l, "blob")) {
				if len(l) > 500 {
					l = l[:500]
				}
				res.Errors = append(res.Errors, l)
			}
		}
		if len(res.Errors) == 0 {
			res.Errors = append(res.Errors, fmt.Sprintf("restic check thoát mã %d", code))
		}
	}
	return toData(res)
}

// ---------------------------------------------------------------- backup.restore_test

// metaOf đọc itso-meta.json của snapshot (snapshot phụ tag of:<id8>).
func (d *Deps) metaOf(ctx context.Context, r *resticRun, snap string) (*backup.Meta, error) {
	code, out, stderr, err := r.restic(ctx, "", nil, nil, "snapshots", "--json", "--tag", backup.MetaTag)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	var all []backup.Snapshot
	if err := json.Unmarshal(out, &all); err != nil {
		return nil, opErr(err)
	}
	metaID := ""
	for _, s := range all {
		for _, t := range s.Tags {
			if t == "of:"+snap[:8] && backup.ValidSnapshotID(s.ID) {
				metaID = s.ID
			}
		}
	}
	if metaID == "" {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "snapshot không có itso-meta.json (không kiểm chứng được)"}
	}
	var b strings.Builder
	code, _, stderr, err = r.restic(ctx, "", nil, &stringWriter{&b, 4 << 20}, "dump", metaID, "/itso-meta.json")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	var m backup.Meta
	if err := json.Unmarshal([]byte(b.String()), &m); err != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "itso-meta.json hỏng"}
	}
	if m.SnapshotID != "" && m.SnapshotID != snap && !strings.HasPrefix(m.SnapshotID, snap) {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "itso-meta.json không thuộc snapshot này"}
	}
	return &m, nil
}

type stringWriter struct {
	b   *strings.Builder
	max int
}

func (s *stringWriter) Write(p []byte) (int, error) {
	if room := s.max - s.b.Len(); room > 0 {
		if len(p) > room {
			s.b.Write(p[:room])
		} else {
			s.b.Write(p)
		}
	}
	return len(p), nil
}

func (d *Deps) backupRestoreTest(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo        backup.RepoParams    `json:"repo"`
		SnapshotID  string               `json:"snapshot_id"`
		SampleFiles int                  `json:"sample_files"`
		Databases   []contracts.BackupDB `json:"databases"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !backup.ValidSnapshotID(p.SnapshotID) || p.SampleFiles < 1 || p.SampleFiles > 1000 {
		return nil, bkInvalid("snapshot_id hoặc sample_files không hợp lệ")
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	meta, err := d.metaOf(ctx, r, p.SnapshotID)
	if err != nil {
		return nil, err
	}
	res := contracts.BackupRestoreTestResult{Mismatches: []contracts.BackupRestoreTestResultMismatchesItem{}}
	var keys []string
	for k := range meta.Manifest {
		if !strings.HasPrefix(k, "db/") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > p.SampleFiles {
		keys = keys[:p.SampleFiles]
	}
	if len(keys) > 0 {
		stage, clean, err := d.staging("test-" + opDirName(env.OpID))
		if err != nil {
			return nil, err
		}
		defer clean()
		args := []string{"restore", p.SnapshotID, "--target", stage}
		for _, k := range keys {
			args = append(args, "--include", "/"+k)
		}
		code, _, stderr, err := r.restic(ctx, "", nil, nil, args...)
		if err != nil {
			return nil, err
		}
		if code != 0 {
			return nil, r.fail(code, stderr)
		}
		for _, k := range keys {
			want := meta.Manifest[k]
			got, ok := backup.HashFile(filepath.Join(stage, filepath.FromSlash(k)))
			if ok && got == want {
				res.VerifiedFiles++
				continue
			}
			it := contracts.BackupRestoreTestResultMismatchesItem{Path: contracts.RelPath(k), ExpectedSHA256: contracts.SHA256(want)}
			if ok {
				it.ActualSHA256 = rawStr(got)
			} else {
				it.ActualSHA256 = rawStr("")
			}
			res.Mismatches = append(res.Mismatches, it)
		}
	}
	for _, db := range p.Databases {
		ok, err := d.testDB(ctx, r, p.SnapshotID, db, meta)
		if err != nil {
			return nil, err
		}
		if ok {
			res.DatabasesOK++
		} else {
			res.Mismatches = append(res.Mismatches, contracts.BackupRestoreTestResultMismatchesItem{Path: contracts.RelPath("db/" + string(db.Name)),
				ExpectedSHA256: contracts.SHA256(meta.Manifest[dbFile(db)])})
		}
	}
	res.OK = len(res.Mismatches) == 0 && (res.VerifiedFiles > 0 || res.DatabasesOK > 0 || len(meta.Manifest) == 0)
	return toData(res)
}

func dbFile(db contracts.BackupDB) string {
	_, _, f := backupDump(dbEngine(db.Engine), "x", string(db.Name))
	return f
}

// testDB: dump từ snapshot phải khớp sha256 trong manifest, rồi nạp được vào DB tạm itso_rt_<hex> (root/postgres),
// xóa DB tạm sau đó (ADR 0033 §3).
func (d *Deps) testDB(ctx context.Context, r *resticRun, snap string, db contracts.BackupDB, meta *backup.Meta) (bool, error) {
	fname := dbFile(db)
	want, ok := meta.Manifest[fname]
	if !ok {
		return false, &registry.OpError{Code: "not_found", Message: "snapshot không có " + fname}
	}
	hw := backup.NewHashingWriter(io.Discard)
	code, _, stderr, err := r.restic(ctx, "", nil, hw, "dump", snap, "/"+fname)
	if err != nil {
		return false, err
	}
	if code != 0 {
		return false, r.fail(code, stderr)
	}
	if hw.Sum() != want {
		return false, nil
	}
	e := dbEngine(db.Engine)
	rnd := make([]byte, 4)
	_, _ = rand.Read(rnd)
	tmp := "itso_rt_" + hex.EncodeToString(rnd)
	create := fmt.Sprintf("CREATE DATABASE %s;\n", myIdent(tmp))
	drop := fmt.Sprintf("DROP DATABASE IF EXISTS %s;\n", myIdent(tmp))
	proc := platform.Proc{Bin: "mariadb", Args: []string{"--batch", "--protocol=socket", tmp}}
	if e == engPG {
		create = fmt.Sprintf("CREATE DATABASE %s;\n", pgIdent(tmp))
		drop = fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE);\n", pgIdent(tmp))
		cred, err := d.systemCred("postgres")
		if err != nil {
			return false, err
		}
		proc = platform.Proc{Bin: "pg_restore", Args: []string{"--no-owner", "--no-acl", "--exit-on-error", "-d", tmp}, As: cred}
	}
	if _, err := d.sql(ctx, e, create); err != nil {
		return false, err
	}
	defer func() { _, _ = d.sql(context.WithoutCancel(ctx), e, drop) }()
	if err := d.dumpInto(ctx, r, snap, "/"+fname, proc); err != nil {
		var oe *registry.OpError
		if ok := asOpErr(err, &oe); ok && oe.Code == "precondition_failed" {
			return false, nil // dump không nạp được = kiểm chứng thất bại, không phải lỗi op
		}
		return false, err
	}
	return true, nil
}

func asOpErr(err error, out **registry.OpError) bool {
	oe, ok := err.(*registry.OpError)
	if ok {
		*out = oe
	}
	return ok
}

// ---------------------------------------------------------------- backup.forget (critical, tắt mặc định)

func (d *Deps) backupForget(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo        backup.RepoParams `json:"repo"`
		SnapshotIDs []string          `json:"snapshot_ids"`
		Prune       bool              `json:"prune"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if len(p.SnapshotIDs) == 0 || len(p.SnapshotIDs) > 1000 {
		return nil, bkInvalid("snapshot_ids rỗng hoặc quá 1000")
	}
	want := map[string]bool{}
	for _, id := range p.SnapshotIDs {
		if !backup.ValidSnapshotID(id) {
			return nil, bkInvalid("snapshot id không hợp lệ: " + id)
		}
		want["of:"+id[:8]] = true
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	ids := append([]string{}, p.SnapshotIDs...)
	if code, out, _, err := r.restic(ctx, "", nil, nil, "snapshots", "--json", "--tag", backup.MetaTag); err == nil && code == 0 {
		var all []backup.Snapshot
		if json.Unmarshal(out, &all) == nil {
			for _, s := range all {
				for _, t := range s.Tags {
					if want[t] && backup.ValidSnapshotID(s.ID) {
						ids = append(ids, s.ID) // snapshot meta đi kèm
					}
				}
			}
		}
	}
	args := append([]string{"forget"}, ids...)
	if p.Prune {
		args = append(args, "--prune")
	}
	code, _, stderr, err := r.restic(ctx, "", nil, nil, args...)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	return toData(contracts.BackupForgetResult{Forgotten: int64(len(p.SnapshotIDs)), Pruned: p.Prune})
}
