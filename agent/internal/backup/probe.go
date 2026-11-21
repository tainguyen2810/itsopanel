package backup

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// GenerateSSHKey sinh khóa ed25519 cho đích SFTP (ADR 0030 §1): trả khóa riêng PEM (OpenSSH) và dòng authorized_keys.
func GenerateSSHKey(comment string) (priv []byte, pub string, err error) {
	pk, sk, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	block, err := ssh.MarshalPrivateKey(sk, comment)
	if err != nil {
		return nil, "", err
	}
	spub, err := ssh.NewPublicKey(pk)
	if err != nil {
		return nil, "", err
	}
	return pem.EncodeToMemory(block), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(spub))) + " " + comment, nil
}

// PublicFromPrivate đọc lại dòng authorized_keys từ khóa riêng đã lưu.
func PublicFromPrivate(priv []byte, comment string) (string, error) {
	s, err := ssh.ParsePrivateKey(priv)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey()))) + " " + comment, nil
}

// SFTPProbe là kết quả ProbeSFTP: kết nối SSH bằng khóa của đích, kiểm host key (ghim nếu chưa có), mở subsystem sftp.
// Trả fingerprint host key và dòng known_hosts để ghim.
type SFTPProbe struct {
	Fingerprint string
	KnownHosts  string
}

// ProbeSFTP: pinned rỗng = lần đầu (ghi nhận host key); khác rỗng mà lệch → host_key_mismatch.
func ProbeSFTP(ctx context.Context, d Dest, priv []byte, pinned string, timeout time.Duration) (SFTPProbe, error) {
	signer, err := ssh.ParsePrivateKey(priv)
	if err != nil {
		return SFTPProbe{}, &Error{Code: "internal", Msg: "khóa SSH của đích hỏng"}
	}
	var got ssh.PublicKey
	cfg := &ssh.ClientConfig{
		User: d.User, Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, Timeout: timeout,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			got = key
			if pinned != "" && ssh.FingerprintSHA256(key) != pinned {
				return errHostKey
			}
			return nil
		},
	}
	addr := net.JoinHostPort(d.Host, strconv.Itoa(d.Port))
	dl := net.Dialer{Timeout: timeout}
	conn, err := dl.DialContext(ctx, "tcp", addr)
	if err != nil {
		return SFTPProbe{}, &Error{Code: "dependency_unavailable", Msg: "không kết nối được " + addr + ": " + err.Error()}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		if errors.Is(err, errHostKey) {
			return SFTPProbe{}, &Error{Code: "host_key_mismatch", Msg: "host key khác bản đã ghim " + pinned}
		}
		if got != nil && strings.Contains(err.Error(), "unable to authenticate") {
			return SFTPProbe{}, &Error{Code: "repo_auth_failed", Msg: "máy đích chưa nhận khóa công khai của đích (authorized_keys)"}
		}
		return SFTPProbe{}, &Error{Code: "dependency_unavailable", Msg: err.Error()}
	}
	client := ssh.NewClient(c, chans, reqs)
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return SFTPProbe{}, &Error{Code: "dependency_unavailable", Msg: err.Error()}
	}
	defer sess.Close()
	if err := sess.RequestSubsystem("sftp"); err != nil {
		return SFTPProbe{}, &Error{Code: "precondition_failed", Msg: "máy đích không mở subsystem sftp"}
	}
	hostField := d.Host
	if d.Port != 22 {
		hostField = "[" + d.Host + "]:" + strconv.Itoa(d.Port)
	}
	return SFTPProbe{Fingerprint: ssh.FingerprintSHA256(got),
		KnownHosts: hostField + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(got)))}, nil
}

var errHostKey = errors.New("host key mismatch")

// ProbeS3 kiểm credential (HEAD bucket) và Object Lock mặc định của bucket.
func ProbeS3(ctx context.Context, hc *http.Client, d Dest, now time.Time) (lockDays *int64, err error) {
	region := "us-east-1"
	if d.Region != nil {
		region = *d.Region
	}
	base := strings.TrimSuffix(d.Endpoint, "/") + "/" + d.Bucket
	resp, err := s3Do(ctx, hc, http.MethodHead, base+"/", "", d, region, now)
	if err != nil {
		return nil, &Error{Code: "dependency_unavailable", Msg: err.Error()}
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case 200:
	case 401, 403:
		return nil, &Error{Code: "repo_auth_failed", Msg: "S3 từ chối credential (" + resp.Status + ")"}
	case 404:
		return nil, &Error{Code: "not_found", Msg: "bucket không tồn tại"}
	default:
		return nil, &Error{Code: "dependency_unavailable", Msg: "S3 trả " + resp.Status}
	}
	resp, err = s3Do(ctx, hc, http.MethodGet, base+"/", "object-lock=", d, region, now)
	if err != nil {
		return nil, &Error{Code: "dependency_unavailable", Msg: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, nil // không cấu hình Object Lock (404 ObjectLockConfigurationNotFoundError) hoặc không hỗ trợ
	}
	var cfg struct {
		Enabled string `xml:"ObjectLockEnabled"`
		Days    int64  `xml:"Rule>DefaultRetention>Days"`
		Years   int64  `xml:"Rule>DefaultRetention>Years"`
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&cfg); err != nil || cfg.Enabled != "Enabled" {
		return nil, nil
	}
	days := cfg.Days + cfg.Years*365
	if days <= 0 {
		return nil, nil
	}
	return &days, nil
}

// s3Do ký request AWS SigV4 (path-style), không thân.
func s3Do(ctx context.Context, hc *http.Client, method, rawURL, query string, d Dest, region string, now time.Time) (*http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	u.RawQuery = query
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	amz := now.UTC().Format("20060102T150405Z")
	day := amz[:8]
	payload := hex.EncodeToString(sha256Sum(nil))
	req.Header.Set("x-amz-date", amz)
	req.Header.Set("x-amz-content-sha256", payload)
	canonQuery := query // chỉ dùng "" hoặc "object-lock=" (đã ở dạng chuẩn SigV4)
	signed := "host;x-amz-content-sha256;x-amz-date"
	canon := strings.Join([]string{method, u.EscapedPath(), canonQuery,
		"host:" + u.Host + "\nx-amz-content-sha256:" + payload + "\nx-amz-date:" + amz + "\n", signed, payload}, "\n")
	scope := day + "/" + region + "/s3/aws4_request"
	sts := "AWS4-HMAC-SHA256\n" + amz + "\n" + scope + "\n" + hex.EncodeToString(sha256Sum([]byte(canon)))
	k := hmacSHA([]byte("AWS4"+d.SecretAccessKey), day)
	k = hmacSHA(k, region)
	k = hmacSHA(k, "s3")
	k = hmacSHA(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA(k, sts))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		d.AccessKeyID, scope, signed, sig))
	return hc.Do(req)
}

func sha256Sum(b []byte) []byte { h := sha256.Sum256(b); return h[:] }

func hmacSHA(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

// ProbeRest kiểm credential rest-server và phát hiện append-only: xóa một khóa không tồn tại; rest-server
// `--append-only` trả 403 cho mọi DELETE ngoài locks, bản thường trả 404.
func ProbeRest(ctx context.Context, hc *http.Client, d Dest) (appendOnly bool, err error) {
	base := strings.TrimSuffix(d.URL, "/")
	do := func(method, u string) (int, error) {
		req, err := http.NewRequestWithContext(ctx, method, u, nil)
		if err != nil {
			return 0, err
		}
		req.SetBasicAuth(d.User, d.Password)
		resp, err := hc.Do(req)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	code, err := do(http.MethodGet, base+"/")
	if err != nil {
		return false, &Error{Code: "dependency_unavailable", Msg: err.Error()}
	}
	if code == 401 || code == 403 {
		return false, &Error{Code: "repo_auth_failed", Msg: "rest-server từ chối credential"}
	}
	code, err = do(http.MethodDelete, base+"/itso-probe/keys/"+strings.Repeat("0", 64))
	if err != nil {
		return false, &Error{Code: "dependency_unavailable", Msg: err.Error()}
	}
	return code == 403, nil
}
