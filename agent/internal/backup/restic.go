package backup

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Session là bộ file bí mật của một lần gọi restic, dưới RunDir/<op> (0700), file 0600. Đường dẫn là đường dẫn thật.
type Session struct {
	Dir          string // đường dẫn hệ thống (RunDir/<op>)
	RepoFile     string // thật
	PasswordFile string // thật
	EnvFile      string // thật; "" khi không có credential env
	Env          []string
	LocalRoot    string // thật
	CacheDir     string // thật
	KeyPath      string // thật (SFTP)
	KnownHosts   string // thật (SFTP)
}

// Files trả nội dung các file bí mật cần ghi: tên trong Dir → nội dung.
func Files(r Repo, localRoot string) map[string][]byte {
	out := map[string][]byte{
		"repository": []byte(r.URL(localRoot) + "\n"),
		"password":   []byte(r.Password + "\n"),
	}
	if env := r.Dest.EnvLines(); len(env) > 0 {
		out["env"] = []byte(strings.Join(env, "\n") + "\n")
	}
	return out
}

// Global là các cờ chung: repo và mật khẩu chỉ qua file, cache cố định, không hỏi gì.
func (s Session) Global(d Dest) []string {
	a := []string{"--repository-file", s.RepoFile, "--password-file", s.PasswordFile, "--cache-dir", s.CacheDir}
	if d.Type == "sftp" {
		a = append(a, "-o", "sftp.command="+d.SFTPCommand(s.KeyPath, s.KnownHosts))
	}
	return a
}

// Wrap trả (bin, argv) để chạy restic. Máy thật: systemd-run --wait --pipe trong itso-maint.slice (CPUQuota 50 %,
// IOWeight 10, Nice 10; ADR 0031 §5), credential S3 qua EnvironmentFile 0600. Sandbox: chạy restic trực tiếp.
func (s Session) Wrap(sandbox bool, workDir string, args []string) (string, []string) {
	if sandbox {
		return "restic", args
	}
	w := []string{"--wait", "--pipe", "--collect", "--quiet", "--service-type=exec", "--slice=itso-maint.slice",
		"-p", "CPUQuota=50%", "-p", "IOWeight=10", "-p", "Nice=10", "-p", "PrivateTmp=yes", "-p", "NoNewPrivileges=yes"}
	if s.EnvFile != "" {
		w = append(w, "-p", "EnvironmentFile="+s.EnvFile)
	}
	if workDir != "" {
		w = append(w, "--working-directory="+workDir)
	}
	w = append(w, "--", "/usr/bin/restic")
	return "systemd-run", append(w, args...)
}

// FixedExcludes là loại trừ cố định trong home (ADR 0031 §1), tương đối với home.
var FixedExcludes = []string{"tmp", ".cache", ".trash", ".local/share/Trash", ".itso-upload", "*.sock"}

// ExcludeArgs đổi loại trừ (cố định + policy) thành cờ --exclude. restic so mẫu với đường dẫn TUYỆT ĐỐI của file
// nguồn: mẫu có `/` (và các thư mục cố định ở gốc home) được neo dưới home (đường dẫn thật), mẫu không có `/`
// khớp tên ở mọi cấp.
func ExcludeArgs(home string, policy []string) []string {
	anchored := map[string]bool{"tmp": true, ".cache": true, ".trash": true, ".itso-upload": true}
	all := append(append([]string{}, FixedExcludes...), policy...)
	out := make([]string, 0, len(all))
	seen := map[string]bool{}
	for _, e := range all {
		p := e
		if strings.Contains(e, "/") || anchored[e] {
			p = strings.TrimSuffix(home, "/") + "/" + strings.TrimPrefix(e, "/")
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, "--exclude="+p)
		}
	}
	return out
}

// ConfigPaths là danh sách cố định của backup cấu hình máy chủ (ADR 0031 §3), tương đối với "/".
var ConfigPaths = []string{"etc/itso", "etc/nginx", "etc/php", "etc/ssh/sshd_config.d", "etc/nftables.d",
	"etc/systemd/system", "etc/pure-ftpd", "etc/fail2ban/jail.d"}

// Summary là dòng tổng kết của `restic backup --json --quiet`.
type Summary struct {
	MessageType  string  `json:"message_type"`
	SnapshotID   string  `json:"snapshot_id"`
	FilesNew     int64   `json:"files_new"`
	DataAdded    int64   `json:"data_added"`
	TotalBytes   int64   `json:"total_bytes_processed"`
	TotalSeconds float64 `json:"total_duration"`
}

// ParseSummary tìm dòng summary trong stdout.
func ParseSummary(out []byte) (Summary, error) {
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		var s Summary
		if json.Unmarshal(sc.Bytes(), &s) == nil && s.MessageType == "summary" && ValidSnapshotID(s.SnapshotID) {
			return s, nil
		}
	}
	return Summary{}, &Error{Code: "internal", Msg: "restic không trả summary"}
}

// Snapshot là một snapshot trong `restic snapshots --json`.
type Snapshot struct {
	ID       string    `json:"id"`
	Time     time.Time `json:"time"`
	Tags     []string  `json:"tags"`
	Paths    []string  `json:"paths"`
	Hostname string    `json:"hostname"`
	Summary  *struct {
		TotalBytes int64 `json:"total_bytes_processed"`
	} `json:"summary,omitempty"`
}

// MetaTag đánh dấu snapshot kèm itso-meta.json của snapshot `of:<id8>` (ADR 0029 §5); không hiện cho panel.
const MetaTag = "itso-meta"

// ParseSnapshots đọc danh sách, bỏ snapshot meta, mới nhất trước, tối đa limit.
func ParseSnapshots(out []byte, limit int) ([]Snapshot, error) {
	var all []Snapshot
	if err := json.Unmarshal(out, &all); err != nil {
		return nil, &Error{Code: "internal", Msg: "đọc snapshots: " + err.Error()}
	}
	var res []Snapshot
	for _, s := range all {
		if !ValidSnapshotID(s.ID) || hasTag(s.Tags, MetaTag) {
			continue
		}
		res = append(res, s)
	}
	sort.SliceStable(res, func(i, j int) bool { return res[i].Time.After(res[j].Time) })
	if len(res) > limit {
		res = res[:limit]
	}
	return res, nil
}

func hasTag(tags []string, t string) bool {
	for _, x := range tags {
		if x == t {
			return true
		}
	}
	return false
}

// Node là một mục `restic ls --json`.
type Node struct {
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	Mode       uint32    `json:"mode"`
	MTime      time.Time `json:"mtime"`
	StructType string    `json:"struct_type"`
}

// ReadNodes đọc luồng `restic ls --json <id> <dir>` và trả các mục con TRỰC TIẾP của dir (đường dẫn trong cây
// bắt đầu bằng "/"; dir là RelPath, "." = gốc). Dừng khi đủ limit (+1 để biết truncated).
func ReadNodes(r io.Reader, dir string, limit int) ([]Node, bool, error) {
	prefix := "/"
	if dir != "." {
		prefix = "/" + strings.Trim(dir, "/") + "/"
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	var out []Node
	for sc.Scan() {
		var n Node
		if json.Unmarshal(sc.Bytes(), &n) != nil || n.StructType != "node" {
			continue
		}
		rest, ok := strings.CutPrefix(n.Path, prefix)
		if !ok || rest == "" || strings.Contains(rest, "/") {
			continue
		}
		if len(out) == limit {
			return out, true, nil
		}
		out = append(out, n)
	}
	return out, false, sc.Err()
}

// FileType đổi loại restic sang FileType của contracts.
func FileType(t string) string {
	switch t {
	case "file", "dir", "symlink":
		return t
	}
	return "other"
}

// RelPath đổi đường dẫn trong cây ("/sites/a") thành RelPath ("sites/a").
func RelPath(p string) string {
	p = strings.Trim(p, "/")
	if p == "" {
		return "."
	}
	return p
}

// Stats là kết quả `restic stats --json`.
type Stats struct {
	TotalSize      int64 `json:"total_size"`
	SnapshotsCount int64 `json:"snapshots_count"`
}

// ParseStats đọc stats.
func ParseStats(out []byte) (Stats, error) {
	var s Stats
	if err := json.Unmarshal(out, &s); err != nil {
		return s, &Error{Code: "internal", Msg: "đọc stats: " + err.Error()}
	}
	return s, nil
}

// Classify đổi stderr/mã thoát của restic thành mã lỗi agent. Thông điệp cắt 300 ký tự, không chứa bí mật
// (restic không in mật khẩu; URL rest được che bằng *** trước khi trả).
func Classify(code int, stderr string) *Error {
	low := strings.ToLower(stderr)
	msg := Redact(strings.TrimSpace(stderr))
	if len(msg) > 300 {
		msg = msg[:300]
	}
	switch {
	case strings.Contains(low, "already locked") || strings.Contains(low, "unable to create lock"):
		return &Error{Code: "repo_locked", Msg: msg}
	case strings.Contains(low, "wrong password") || strings.Contains(low, "no key found") ||
		strings.Contains(low, "access denied") || strings.Contains(low, "invalidaccesskeyid") ||
		strings.Contains(low, "signaturedoesnotmatch") || strings.Contains(low, "401 unauthorized") ||
		strings.Contains(low, "permission denied (publickey"):
		return &Error{Code: "repo_auth_failed", Msg: msg}
	case strings.Contains(low, "host key verification failed") || strings.Contains(low, "remote host identification has changed"):
		return &Error{Code: "host_key_mismatch", Msg: msg}
	case strings.Contains(low, "repository does not exist") || strings.Contains(low, "is there a repository at the following location") ||
		strings.Contains(low, "config: no such file") || code == 10:
		return &Error{Code: "repo_not_initialized", Msg: msg}
	case strings.Contains(low, "config file already exists"):
		return &Error{Code: "already_exists", Msg: msg}
	case strings.Contains(low, "no such host") || strings.Contains(low, "connection refused") ||
		strings.Contains(low, "timeout") || strings.Contains(low, "connection reset") || strings.Contains(low, "network is unreachable"):
		return &Error{Code: "dependency_unavailable", Msg: msg}
	}
	return &Error{Code: "precondition_failed", Msg: fmt.Sprintf("restic thoát mã %d: %s", code, msg)}
}

// Redact che phần user:password@ trong URL nếu có trong thông điệp.
func Redact(s string) string {
	out := s
	for {
		i := strings.Index(out, "://")
		if i < 0 {
			return out
		}
		rest := out[i+3:]
		at := strings.IndexByte(rest, '@')
		sp := strings.IndexAny(rest, " /\n\t")
		if at < 0 || (sp >= 0 && sp < at) {
			return out[:i+3] + Redact(rest)
		}
		return out[:i+3] + "***@" + Redact(rest[at+1:])
	}
}
