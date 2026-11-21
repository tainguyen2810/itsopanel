package ops

// Op backup.* (Phase 8, D-82…D-87, ADR 0029–0033): restic chạy qua platform.Streamer (máy thật: systemd-run trong
// itso-maint.slice), repo/mật khẩu/credential chỉ qua file 0600 dưới /run/itso/backup/<op>/, một tác vụ một repo.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpBackupDestinationTest: d.backupDestTest,
			contracts.OpBackupRepoInit:        d.backupRepoInit,
			contracts.OpBackupRun:             d.backupRun,
			contracts.OpBackupSnapshots:       d.backupSnapshots,
			contracts.OpBackupBrowse:          d.backupBrowse,
			contracts.OpBackupStats:           d.backupStats,
		}
	})
}

// SimRemoteRoot: ở sandbox, đích SFTP/S3/rest được mô phỏng bằng repo local dưới thư mục này (ADR 0030 không đổi:
// argv/env thật được kiểm bằng golden test với runner giả).
const SimRemoteRoot = "/var/backups/itso/sim"

var repoLocks sync.Map // repo_uuid → *sync.Mutex

func bkErr(err error) error {
	var be *backup.Error
	if errors.As(err, &be) {
		return &registry.OpError{Code: be.Code, Message: be.Msg, Retryable: be.Code == "repo_locked" || be.Code == "dependency_unavailable"}
	}
	return opErr(err)
}

// resticRun là một repo đã mở: file bí mật đã ghi, khóa repo đang giữ.
type resticRun struct {
	d    *Deps
	repo backup.Repo
	sess backup.Session
}

func opDirName(opID string) string {
	return strings.NewReplacer(":", "-").Replace(opID)
}

// ensureTree tạo các thư mục cha (0755) rồi thư mục cuối với mode, chủ root.
func (d *Deps) ensureTree(p string, mode uint32) error {
	if err := d.FS.MkdirAll(path.Dir(p)); err != nil {
		return err
	}
	_, err := d.FS.EnsureDir(p, fs.FileMode(mode), platform.Owner{})
	return err
}

func (d *Deps) openRepo(env *envelope.Envelope, rp backup.RepoParams) (*resticRun, func(), error) {
	repo, err := backup.ParseRepo(rp)
	if err != nil {
		return nil, nil, bkErr(err)
	}
	mu, _ := repoLocks.LoadOrStore(repo.UUID, &sync.Mutex{})
	lock := mu.(*sync.Mutex)
	if !lock.TryLock() {
		return nil, nil, &registry.OpError{Code: "repo_locked", Message: "repo đang có tác vụ khác", Retryable: true}
	}
	release := func() { lock.Unlock() }
	sess, cleanup, err := d.writeSession(env, repo)
	if err != nil {
		release()
		return nil, nil, err
	}
	return &resticRun{d: d, repo: repo, sess: sess}, func() { cleanup(); release() }, nil
}

// writeSession ghi repository/password/env (0600) vào /run/itso/backup/<op>/ (0700).
func (d *Deps) writeSession(env *envelope.Envelope, repo backup.Repo) (backup.Session, func(), error) {
	dir := backup.RunDir + "/" + opDirName(env.OpID)
	if err := d.ensureTree(dir, 0o700); err != nil {
		return backup.Session{}, nil, opErr(err)
	}
	cleanup := func() { _ = d.FS.RemoveTree(dir) }
	if err := d.ensureTree(backup.CacheDir, 0o700); err != nil {
		cleanup()
		return backup.Session{}, nil, opErr(err)
	}
	localRoot := backup.LocalRoot
	if d.Sandbox && repo.Dest.Type != "local" {
		localRoot = SimRemoteRoot + "/" + repo.Dest.DestinationUUID
		repo.Dest = backup.Dest{Type: "local", DestinationUUID: repo.Dest.DestinationUUID}
	}
	if err := d.ensureTree(localRoot, 0o700); err != nil {
		cleanup()
		return backup.Session{}, nil, opErr(err)
	}
	realLocal, _ := d.FS.Path(localRoot)
	files := backup.Files(repo, realLocal)
	for name, data := range files {
		if _, err := d.FS.WriteAtomic(dir+"/"+name, data, 0o600, platform.Owner{}); err != nil {
			cleanup()
			return backup.Session{}, nil, opErr(err)
		}
	}
	real := func(p string) string { r, _ := d.FS.Path(p); return r }
	s := backup.Session{Dir: dir, RepoFile: real(dir + "/repository"), PasswordFile: real(dir + "/password"),
		LocalRoot: realLocal, CacheDir: real(backup.CacheDir)}
	if _, ok := files["env"]; ok {
		s.EnvFile = real(dir + "/env")
	}
	if repo.Dest.Type == "sftp" {
		if !d.FS.Exists(repo.Dest.KeyPath()) || !d.FS.Exists(repo.Dest.KnownHostsPath()) {
			cleanup()
			return backup.Session{}, nil, &registry.OpError{Code: "precondition_failed",
				Message: "đích SFTP chưa được kiểm tra (chưa có khóa SSH hoặc host key ghim)"}
		}
		s.KeyPath, s.KnownHosts = real(repo.Dest.KeyPath()), real(repo.Dest.KnownHostsPath())
	}
	return s, cleanup, nil
}

// restic chạy một lệnh restic. workDir là đường dẫn hệ thống ("" = "/"). stdout nil → gom tối đa 1 MiB.
func (r *resticRun) restic(ctx context.Context, workDir string, stdin io.Reader, stdout io.Writer, args ...string) (int, []byte, string, error) {
	st, err := r.d.streamer()
	if err != nil {
		return -1, nil, "", err
	}
	dest := r.repo.Dest
	if r.d.Sandbox && dest.Type != "local" {
		dest = backup.Dest{Type: "local", DestinationUUID: dest.DestinationUUID}
	}
	full := append(append([]string{}, args[:1]...), r.sess.Global(dest)...)
	full = append(full, args[1:]...)
	realWD := ""
	if workDir != "" {
		realWD, err = r.d.FS.Path(workDir)
		if err != nil {
			return -1, nil, "", opErr(err)
		}
	}
	bin, argv := r.sess.Wrap(r.d.Sandbox, realWD, full)
	var out bytes.Buffer
	w := stdout
	if w == nil {
		w = &limitedBuf{b: &out, max: 1 << 20}
	}
	var errb bytes.Buffer
	p := platform.Proc{Bin: bin, Args: argv, Stdin: stdin, Stdout: w, Stderr: &limitedBuf{b: &errb, max: 64 << 10}}
	if r.d.Sandbox {
		p.Dir = realWD
	}
	code, err := st.Stream(ctx, p)
	if err != nil {
		return code, nil, errb.String(), &registry.OpError{Code: "dependency_unavailable", Message: "restic: " + err.Error(), Retryable: true}
	}
	return code, out.Bytes(), errb.String(), nil
}

func (r *resticRun) fail(code int, stderr string) error {
	return bkErr(backup.Classify(code, stderr))
}

type limitedBuf struct {
	b   *bytes.Buffer
	max int
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	if room := l.max - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

// ---------------------------------------------------------------- backup.destination.test

func (d *Deps) backupDestTest(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Destination json.RawMessage `json:"destination"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	dest, err := backup.ParseDest(p.Destination)
	if err != nil {
		return nil, bkErr(err)
	}
	start := d.now()
	res := contracts.BackupDestinationTestResult{}
	fail := func(e error) (map[string]any, error) {
		var be *backup.Error
		if errors.As(e, &be) && be.Code != "internal" {
			msg := be.Code + ": " + be.Msg
			res.Error = &msg
			res.LatencyMs = d.now().Sub(start).Milliseconds()
			return toData(res)
		}
		return nil, bkErr(e)
	}
	switch dest.Type {
	case "local":
		if err := d.ensureTree(backup.LocalRoot, 0o700); err != nil {
			return fail(&backup.Error{Code: "precondition_failed", Msg: "không tạo được " + backup.LocalRoot + ": " + err.Error()})
		}
	case "sftp":
		pub, priv, err := d.sftpKey(dest)
		if err != nil {
			return nil, err
		}
		res.SSHPublicKey = &pub
		pinned := ""
		if dest.HostKeySHA256 != nil {
			pinned = *dest.HostKeySHA256
		}
		var probe backup.SFTPProbe
		if d.Sandbox {
			fp := sha256.Sum256([]byte(dest.Host))
			probe = backup.SFTPProbe{Fingerprint: "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(fp[:]), "="),
				KnownHosts: dest.Host + " ssh-ed25519 AAAAsandbox"}
			if pinned != "" && pinned != probe.Fingerprint {
				return fail(&backup.Error{Code: "host_key_mismatch", Msg: "host key khác bản đã ghim"})
			}
		} else {
			probe, err = backup.ProbeSFTP(ctx, dest, priv, pinned, 20*time.Second)
			if err != nil {
				res.SSHPublicKey = &pub
				return fail(err)
			}
		}
		if _, err := d.FS.WriteAtomic(dest.KnownHostsPath(), []byte(probe.KnownHosts+"\n"), 0o600, platform.Owner{}); err != nil {
			return nil, opErr(err)
		}
		res.HostKeySHA256 = &probe.Fingerprint
	case "s3":
		if !d.Sandbox {
			days, err := backup.ProbeS3(ctx, &http.Client{Timeout: 20 * time.Second}, dest, d.now())
			if err != nil {
				return fail(err)
			}
			res.ObjectLockDays = days
		}
	case "rest":
		if !d.Sandbox {
			ao, err := backup.ProbeRest(ctx, &http.Client{Timeout: 20 * time.Second}, dest)
			if err != nil {
				return fail(err)
			}
			res.AppendOnly = ao
		}
	}
	res.OK = true
	res.LatencyMs = d.now().Sub(start).Milliseconds()
	return toData(res)
}

// sftpKey trả khóa SSH của đích, sinh lần đầu (ed25519, /etc/itso/backup/keys/<dest> 0600).
func (d *Deps) sftpKey(dest backup.Dest) (string, []byte, error) {
	comment := "itso-backup-" + dest.DestinationUUID[:8]
	if err := d.ensureTree(backup.KeyDir, 0o700); err != nil {
		return "", nil, opErr(err)
	}
	if b, err := d.FS.ReadFile(dest.KeyPath()); err == nil {
		pub, err := backup.PublicFromPrivate(b, comment)
		if err != nil {
			return "", nil, &registry.OpError{Code: "internal", Message: "khóa SSH của đích hỏng"}
		}
		return pub, b, nil
	}
	priv, pub, err := backup.GenerateSSHKey(comment)
	if err != nil {
		return "", nil, opErr(err)
	}
	if _, err := d.FS.WriteAtomic(dest.KeyPath(), priv, 0o600, platform.Owner{}); err != nil {
		return "", nil, opErr(err)
	}
	return pub, priv, nil
}

// ---------------------------------------------------------------- backup.repo.init

func (d *Deps) backupRepoInit(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo backup.RepoParams `json:"repo"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	// Đã có repo (cat config đọc được bằng đúng mật khẩu) → idempotent.
	code, _, stderr, err := r.restic(ctx, "", nil, io.Discard, "cat", "config")
	if err != nil {
		return nil, err
	}
	if code == 0 {
		return toData(contracts.BackupRepoInitResult{Initialized: true, AlreadyExisted: true})
	}
	if e := backup.Classify(code, stderr); e.Code != "repo_not_initialized" {
		return nil, bkErr(e)
	}
	if r.repo.Dest.Type == "local" || d.Sandbox {
		parent := backup.LocalRoot
		if d.Sandbox && r.repo.Dest.Type != "local" {
			parent = SimRemoteRoot + "/" + r.repo.Dest.DestinationUUID
		}
		if err := d.FS.MkdirAll(parent + "/" + path.Dir(r.repo.Path)); err != nil {
			return nil, opErr(err)
		}
	}
	code, _, stderr, err = r.restic(ctx, "", nil, nil, "init", "--repository-version", "2")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	return toData(contracts.BackupRepoInitResult{Initialized: true, AlreadyExisted: false})
}

// ---------------------------------------------------------------- backup.snapshots / stats / browse

func (d *Deps) backupSnapshots(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo  backup.RepoParams `json:"repo"`
		Tags  []string          `json:"tags"`
		Limit int               `json:"limit"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	for _, t := range p.Tags {
		if !backup.ValidTag(t) {
			return nil, &registry.OpError{Code: "invalid_params", Message: "tag không hợp lệ: " + t}
		}
	}
	if p.Limit < 1 || p.Limit > 1000 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "limit ngoài 1–1000"}
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	args := []string{"snapshots", "--json"}
	if len(p.Tags) > 0 {
		args = append(args, "--tag", strings.Join(p.Tags, ","))
	}
	code, out, stderr, err := r.restic(ctx, "", nil, nil, args...)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	list, err := backup.ParseSnapshots(out, p.Limit)
	if err != nil {
		return nil, bkErr(err)
	}
	res := contracts.BackupSnapshotsResult{Snapshots: []contracts.BackupSnapshotsResultSnapshotsItem{}}
	for _, s := range list {
		it := contracts.BackupSnapshotsResultSnapshotsItem{ID: contracts.ResticSnapshotID(s.ID), Time: s.Time.UTC().Format(time.RFC3339),
			Tags: nonNil(s.Tags), Paths: nonNil(s.Paths), Hostname: s.Hostname}
		if s.Summary != nil {
			v := s.Summary.TotalBytes
			it.SizeBytes = &v
		}
		res.Snapshots = append(res.Snapshots, it)
	}
	return toData(res)
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (d *Deps) backupStats(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo backup.RepoParams `json:"repo"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	stat := func(mode string) (backup.Stats, error) {
		code, out, stderr, err := r.restic(ctx, "", nil, nil, "stats", "--json", "--mode", mode)
		if err != nil {
			return backup.Stats{}, err
		}
		if code != 0 {
			return backup.Stats{}, r.fail(code, stderr)
		}
		s, err := backup.ParseStats(out)
		if err != nil {
			return s, bkErr(err)
		}
		return s, nil
	}
	raw, err := stat("raw-data")
	if err != nil {
		return nil, err
	}
	rs, err := stat("restore-size")
	if err != nil {
		return nil, err
	}
	return toData(contracts.BackupStatsResult{RawSizeBytes: contracts.Bytes(raw.TotalSize),
		RestoreSizeBytes: contracts.Bytes(rs.TotalSize), Snapshots: raw.SnapshotsCount})
}

func (d *Deps) backupBrowse(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo       backup.RepoParams `json:"repo"`
		SnapshotID string            `json:"snapshot_id"`
		Path       string            `json:"path"`
		Limit      int               `json:"limit"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !backup.ValidSnapshotID(p.SnapshotID) {
		return nil, &registry.OpError{Code: "invalid_params", Message: "snapshot_id không hợp lệ"}
	}
	if err := checkRelPath(p.Path); err != nil {
		return nil, err
	}
	if p.Limit < 1 || p.Limit > 5000 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "limit ngoài 1–5000"}
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	dir := "/"
	if p.Path != "." {
		dir = "/" + p.Path
	}
	pr, pw := io.Pipe()
	type res struct {
		nodes     []backup.Node
		truncated bool
		err       error
	}
	ch := make(chan res, 1)
	go func() {
		n, t, e := backup.ReadNodes(pr, p.Path, p.Limit)
		_, _ = io.Copy(io.Discard, pr) // xả phần còn lại để restic không bị chặn
		ch <- res{n, t, e}
	}()
	code, _, stderr, err := r.restic(ctx, "", nil, pw, "ls", "--json", p.SnapshotID, dir)
	pw.Close()
	got := <-ch
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	if got.err != nil {
		return nil, opErr(got.err)
	}
	out := contracts.BackupBrowseResult{Entries: []contracts.BackupBrowseResultEntriesItem{}, Truncated: got.truncated}
	for _, n := range got.nodes {
		out.Entries = append(out.Entries, contracts.BackupBrowseResultEntriesItem{Name: n.Name, Path: contracts.RelPath(backup.RelPath(n.Path)),
			Type: contracts.FileType(backup.FileType(n.Type)), Size: contracts.Bytes(n.Size), Mtime: n.MTime.UTC().Format(time.RFC3339),
			Mode: contracts.Mode(fmt.Sprintf("0%03o", n.Mode&0o777))})
	}
	return toData(out)
}

// checkRelPath kiểm RelPath như defs (không tuyệt đối, không `..`, không ký tự điều khiển).
func checkRelPath(p string) error {
	if p == "." {
		return nil
	}
	if p == "" || len(p) > 4096 || strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") || strings.Contains(p, "//") {
		return &registry.OpError{Code: "invalid_params", Message: "path không hợp lệ"}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return &registry.OpError{Code: "path_outside_home", Message: "path chứa . hoặc .."}
		}
		for _, c := range seg {
			if c < 0x20 || c == 0x7f {
				return &registry.OpError{Code: "invalid_params", Message: "path chứa ký tự điều khiển"}
			}
		}
	}
	return nil
}
