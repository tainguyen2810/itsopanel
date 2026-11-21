// Package auth xác thực caller của agent (D-66): SO_PEERCRED (uid trong allowlist) và
// HMAC-SHA256 trên v1\n{method}\n{path}\n{ts}\n{nonce}\n{sha256(body)}.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Header của chữ ký.
const (
	HeaderSignature = "X-ITSO-Signature"
	HeaderTimestamp = "X-ITSO-Timestamp"
	HeaderNonce     = "X-ITSO-Nonce"
	MaxSkew         = 60 * time.Second
	MinKeyBytes     = 32
)

// ErrUnauthorized là lỗi xác thực chung (không tiết lộ chi tiết cho caller).
var ErrUnauthorized = errors.New("unauthorized_caller")

// Canonical là chuỗi được ký.
func Canonical(method, path string, ts int64, nonce string, body []byte) string {
	h := sha256.Sum256(body)
	return "v1\n" + method + "\n" + path + "\n" + strconv.FormatInt(ts, 10) + "\n" + nonce + "\n" + hex.EncodeToString(h[:])
}

// Sign trả chữ ký hex.
func Sign(key []byte, method, path string, ts int64, nonce string, body []byte) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(Canonical(method, path, ts, nonce, body)))
	return hex.EncodeToString(m.Sum(nil))
}

// LoadKey đọc khóa HMAC: file thường, không phải symlink, quyền không cho "others" (≤ 0640), ≥ 32 byte.
// Nội dung có thể là hex hoặc nhị phân; khoảng trắng cuối bị bỏ.
func LoadKey(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("khóa agent %s phải là file thường", path)
	}
	if fi.Mode().Perm()&0o007 != 0 {
		return nil, fmt.Errorf("khóa agent %s có quyền %o: không được cho others đọc/ghi", path, fi.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	k := []byte(strings.TrimSpace(string(b)))
	if len(k) < MinKeyBytes {
		return nil, fmt.Errorf("khóa agent quá ngắn (%d byte, cần ≥ %d)", len(k), MinKeyBytes)
	}
	return k, nil
}

// Verifier kiểm chữ ký và chống replay theo nonce.
type Verifier struct {
	Key []byte
	Now func() time.Time

	mu     sync.Mutex
	nonces map[string]time.Time
}

// NewVerifier tạo verifier.
func NewVerifier(key []byte) *Verifier {
	return &Verifier{Key: key, Now: time.Now, nonces: map[string]time.Time{}}
}

// Verify kiểm request (body đã đọc sẵn).
func (v *Verifier) Verify(r *http.Request, body []byte) error {
	sig := r.Header.Get(HeaderSignature)
	tsStr := r.Header.Get(HeaderTimestamp)
	nonce := r.Header.Get(HeaderNonce)
	if sig == "" || tsStr == "" || len(nonce) < 16 || len(nonce) > 64 {
		return fmt.Errorf("%w: thiếu chữ ký", ErrUnauthorized)
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return fmt.Errorf("%w: timestamp sai", ErrUnauthorized)
	}
	now := v.Now()
	if d := now.Sub(time.Unix(ts, 0)); d > MaxSkew || d < -MaxSkew {
		return fmt.Errorf("%w: lệch giờ", ErrUnauthorized)
	}
	want := Sign(v.Key, r.Method, r.URL.Path, ts, nonce, body)
	got, err := hex.DecodeString(sig)
	if err != nil || !hmac.Equal(got, mustHex(want)) {
		return fmt.Errorf("%w: chữ ký sai", ErrUnauthorized)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for n, t := range v.nonces {
		if now.Sub(t) > 2*MaxSkew {
			delete(v.nonces, n)
		}
	}
	if _, used := v.nonces[nonce]; used {
		return fmt.Errorf("%w: nonce lặp", ErrUnauthorized)
	}
	v.nonces[nonce] = now
	return nil
}

func mustHex(s string) []byte {
	b, _ := hex.DecodeString(s)
	return b
}

type ctxKey struct{}

// Peer là danh tính caller lấy từ SO_PEERCRED.
type Peer struct {
	UID, GID, PID int
	Known         bool // false khi không phải unix socket (tcp loopback dev)
}

// PeerFromContext lấy Peer đã gắn bởi ConnContext.
func PeerFromContext(ctx context.Context) Peer {
	p, _ := ctx.Value(ctxKey{}).(Peer)
	return p
}

// ConnContext gắn Peer (SO_PEERCRED) vào context của mọi request trên kết nối.
func ConnContext(ctx context.Context, c net.Conn) context.Context {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return context.WithValue(ctx, ctxKey{}, Peer{})
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return context.WithValue(ctx, ctxKey{}, Peer{})
	}
	var cred *syscall.Ucred
	var cerr error
	_ = raw.Control(func(fd uintptr) {
		cred, cerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if cerr != nil || cred == nil {
		return context.WithValue(ctx, ctxKey{}, Peer{})
	}
	return context.WithValue(ctx, ctxKey{}, Peer{UID: int(cred.Uid), GID: int(cred.Gid), PID: int(cred.Pid), Known: true})
}

// UIDAllow là allowlist uid của caller. Rỗng = không kiểm (chỉ dùng cho dev/sandbox).
type UIDAllow map[int]bool

// Allowed cho biết peer có được gọi không.
func (a UIDAllow) Allowed(p Peer) bool {
	if len(a) == 0 {
		return true
	}
	return p.Known && a[p.UID]
}
