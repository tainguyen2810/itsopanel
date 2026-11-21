// Package backup là phần logic thuần của op backup.* (D-82…D-87, ADR 0029–0033): đích kiểu hóa → URL repo restic,
// file bí mật 0600, argv restic cố định, đọc kết quả JSON, phân loại lỗi. Không chạy lệnh: handler ở internal/ops
// chạy qua platform.Runner/Streamer.
package backup

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Đường dẫn cố định trên máy chủ (ADR 0029–0032).
const (
	LocalRoot   = "/var/backups/itso/repos"
	RunDir      = "/run/itso/backup"
	KeyDir      = "/etc/itso/backup/keys"
	CacheDir    = "/var/cache/itso/restic"
	StagingRoot = "/var/lib/itso/restore"
	SSHBin      = "/usr/bin/ssh"
)

var (
	reUUID      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reRepoPath  = regexp.MustCompile(`^itso/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(acct-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|server)$`)
	reHostname  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	reUser      = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	reBucket    = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	reRegion    = regexp.MustCompile(`^[a-z0-9-]{2,32}$`)
	reAccessKey = regexp.MustCompile(`^[A-Za-z0-9/+=]{8,128}$`)
	rePrintable = regexp.MustCompile(`^[\x21-\x7e]+$`)
	reHTTPS     = regexp.MustCompile(`^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$`)
	reAbsPath   = regexp.MustCompile(`^/[^\x00-\x1f]*$`)
	reHostKey   = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)
	reSnapshot  = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
	reTag       = regexp.MustCompile(`^(itso|type:(files|db|config|panel)|account:[0-9a-f-]{36}|website:[0-9a-f-]{36}|db:[a-z][a-z0-9_]{0,63}|policy:[0-9a-f-]{36}|manual|pre-restore|final)$`)
	reExclude   = regexp.MustCompile(`^[A-Za-z0-9._*?/@+-]+$`)
)

// Error là lỗi kiểm tham số/thao tác, Code là mã lỗi agent (errors.json).
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

func bad(format string, a ...any) error {
	return &Error{Code: "invalid_params", Msg: fmt.Sprintf(format, a...)}
}

// Dest là đích kiểu hóa (oneOf theo type trong defs.schema.json#/$defs/BackupDestination).
type Dest struct {
	Type            string  `json:"type"`
	DestinationUUID string  `json:"destination_uuid"`
	Host            string  `json:"host,omitempty"`
	Port            int     `json:"port,omitempty"`
	User            string  `json:"user,omitempty"`
	Path            string  `json:"path,omitempty"`
	HostKeySHA256   *string `json:"host_key_sha256,omitempty"`
	Endpoint        string  `json:"endpoint,omitempty"`
	Bucket          string  `json:"bucket,omitempty"`
	Region          *string `json:"region,omitempty"`
	AccessKeyID     string  `json:"access_key_id,omitempty"`
	SecretAccessKey string  `json:"secret_access_key,omitempty"`
	URL             string  `json:"url,omitempty"`
	Password        string  `json:"password,omitempty"`
}

// ParseDest đọc và kiểm lại đích (schema đã kiểm một lần; agent kiểm lại theo quy tắc của mình).
func ParseDest(raw json.RawMessage) (Dest, error) {
	var d Dest
	if err := json.Unmarshal(raw, &d); err != nil {
		return d, bad("destination: %v", err)
	}
	return d, d.Validate()
}

// Validate kiểm từng loại đích; trường thừa của loại khác bị từ chối.
func (d Dest) Validate() error {
	if !reUUID.MatchString(d.DestinationUUID) {
		return bad("destination_uuid không hợp lệ")
	}
	extra := func(fields map[string]bool) error {
		for name, set := range fields {
			if set {
				return bad("đích %s không nhận trường %s", d.Type, name)
			}
		}
		return nil
	}
	switch d.Type {
	case "local":
		return extra(map[string]bool{"host": d.Host != "", "path": d.Path != "", "endpoint": d.Endpoint != "", "url": d.URL != "",
			"password": d.Password != "", "secret_access_key": d.SecretAccessKey != ""})
	case "sftp":
		if !validHost(d.Host) {
			return bad("host không hợp lệ")
		}
		if d.Port < 1 || d.Port > 65535 {
			return bad("port ngoài 1–65535")
		}
		if !reUser.MatchString(d.User) {
			return bad("user không hợp lệ")
		}
		if !reAbsPath.MatchString(d.Path) || hasDotSeg(d.Path) || strings.ContainsAny(d.Path, " \t'\"\\") {
			return bad("path phải là đường dẫn tuyệt đối không khoảng trắng, không ..")
		}
		if d.HostKeySHA256 != nil && !reHostKey.MatchString(*d.HostKeySHA256) {
			return bad("host_key_sha256 không hợp lệ")
		}
		return extra(map[string]bool{"endpoint": d.Endpoint != "", "url": d.URL != "", "password": d.Password != ""})
	case "s3":
		if !reHTTPS.MatchString(d.Endpoint) || !validURLPort(d.Endpoint) {
			return bad("endpoint phải là HTTPS")
		}
		if !reBucket.MatchString(d.Bucket) || strings.Contains(d.Bucket, "..") {
			return bad("bucket không hợp lệ")
		}
		if d.Region != nil && !reRegion.MatchString(*d.Region) {
			return bad("region không hợp lệ")
		}
		if !reAccessKey.MatchString(d.AccessKeyID) || len(d.SecretAccessKey) < 8 || len(d.SecretAccessKey) > 256 || !rePrintable.MatchString(d.SecretAccessKey) {
			return bad("credential S3 không hợp lệ")
		}
		return extra(map[string]bool{"host": d.Host != "", "url": d.URL != "", "password": d.Password != ""})
	case "rest":
		if !reHTTPS.MatchString(d.URL) || !validURLPort(d.URL) {
			return bad("url phải là HTTPS")
		}
		if !reUser.MatchString(d.User) || len(d.Password) < 8 || len(d.Password) > 256 || !rePrintable.MatchString(d.Password) {
			return bad("credential rest-server không hợp lệ")
		}
		return extra(map[string]bool{"host": d.Host != "", "endpoint": d.Endpoint != "", "secret_access_key": d.SecretAccessKey != ""})
	}
	return bad("loại đích %q không hỗ trợ", d.Type)
}

func validHost(h string) bool {
	if ip := net.ParseIP(h); ip != nil {
		return true
	}
	return len(h) <= 253 && reHostname.MatchString(h)
}

func validURLPort(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		return err == nil && n >= 1 && n <= 65535
	}
	return true
}

func hasDotSeg(p string) bool {
	for _, s := range strings.Split(p, "/") {
		if s == "." || s == ".." {
			return true
		}
	}
	return false
}

// Immutable cho biết loại đích có thể bất biến (để tính prune/locked_until ở panel); kết quả thật do Test phát hiện.
func (d Dest) Remote() bool { return d.Type != "local" }

// KeyPath là khóa SSH riêng của đích SFTP (0600, root).
func (d Dest) KeyPath() string { return KeyDir + "/" + d.DestinationUUID }

// KnownHostsPath là known_hosts riêng của đích SFTP (host key đã ghim).
func (d Dest) KnownHostsPath() string { return KeyDir + "/" + d.DestinationUUID + ".known_hosts" }

// Repo là repo đã kiểm: đích + đường dẫn cố định + mật khẩu.
type Repo struct {
	UUID     string
	Path     string
	Dest     Dest
	Password string
}

// RepoParams là dạng JSON của BackupRepo trong params.
type RepoParams struct {
	RepoUUID    string          `json:"repo_uuid"`
	Path        string          `json:"path"`
	Destination json.RawMessage `json:"destination"`
	Password    string          `json:"password"`
}

// ParseRepo kiểm repo.
func ParseRepo(p RepoParams) (Repo, error) {
	if !reUUID.MatchString(p.RepoUUID) {
		return Repo{}, bad("repo_uuid không hợp lệ")
	}
	if !reRepoPath.MatchString(p.Path) {
		return Repo{}, bad("đường dẫn repo không đúng mẫu itso/<server>/acct-<account>|server")
	}
	if len(p.Password) < 16 || len(p.Password) > 256 || !rePrintable.MatchString(p.Password) {
		return Repo{}, bad("mật khẩu repo không hợp lệ")
	}
	d, err := ParseDest(p.Destination)
	if err != nil {
		return Repo{}, err
	}
	return Repo{UUID: p.RepoUUID, Path: p.Path, Dest: d, Password: p.Password}, nil
}

// AccountUUID trả uuid account trong đường dẫn repo ("" với repo server).
func (r Repo) AccountUUID() string {
	_, after, ok := strings.Cut(r.Path, "/acct-")
	if !ok {
		return ""
	}
	return after
}

// URL dựng chuỗi repo restic. localRoot là đường dẫn thật của LocalRoot (sandbox: dưới gốc giả).
// URL rest có credential nên chỉ được ghi vào file 0600 (--repository-file), không bao giờ vào argv.
func (r Repo) URL(localRoot string) string {
	d := r.Dest
	switch d.Type {
	case "local":
		return localRoot + "/" + r.Path
	case "sftp":
		// sftp.command (SFTPCommand) quyết định kết nối; URL chỉ còn đường dẫn trên máy đích.
		return "sftp:" + d.User + "@" + hostForURL(d.Host) + ":" + strings.TrimSuffix(d.Path, "/") + "/" + r.Path
	case "s3":
		return "s3:" + strings.TrimSuffix(d.Endpoint, "/") + "/" + d.Bucket + "/" + r.Path
	case "rest":
		u, _ := url.Parse(strings.TrimSuffix(d.URL, "/") + "/" + r.Path + "/")
		u.User = url.UserPassword(d.User, d.Password)
		return "rest:" + u.String()
	}
	return ""
}

func hostForURL(h string) string {
	if strings.Contains(h, ":") {
		return "[" + h + "]"
	}
	return h
}

// SFTPCommand là lệnh ssh restic dùng cho đích SFTP: khóa riêng của đích, host key ghim, không tương tác.
// keyPath/knownHosts là đường dẫn thật. restic tách chuỗi theo khoảng trắng và chạy trực tiếp (không shell);
// mọi thành phần đã được kiểm không có khoảng trắng/nháy.
func (d Dest) SFTPCommand(keyPath, knownHosts string) string {
	return strings.Join([]string{SSHBin, "-i", keyPath, "-p", strconv.Itoa(d.Port),
		"-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + knownHosts, "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
		"-l", d.User, "--", d.Host, "-s", "sftp"}, " ")
}

// EnvFile là nội dung EnvironmentFile (0600) cho credential S3; rỗng với loại khác.
func (d Dest) EnvLines() []string {
	if d.Type != "s3" {
		return nil
	}
	out := []string{"AWS_ACCESS_KEY_ID=" + d.AccessKeyID, "AWS_SECRET_ACCESS_KEY=" + d.SecretAccessKey}
	if d.Region != nil {
		out = append(out, "AWS_DEFAULT_REGION="+*d.Region)
	}
	return out
}

// ValidSnapshotID kiểm id snapshot restic (không nhận `latest`).
func ValidSnapshotID(s string) bool { return reSnapshot.MatchString(s) }

// ValidTag kiểm tag theo danh sách cố định.
func ValidTag(s string) bool { return reTag.MatchString(s) }

// ValidExclude kiểm mẫu loại trừ tương đối.
func ValidExclude(s string) bool {
	return len(s) >= 1 && len(s) <= 200 && reExclude.MatchString(s) && !strings.HasPrefix(s, "/") &&
		!strings.HasPrefix(s, "-") && !hasDotSeg(s)
}
