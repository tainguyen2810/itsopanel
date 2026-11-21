// Package audit ghi nhật ký cục bộ của agent dạng JSONL nối chuỗi băm
// (/var/log/itso/agent-audit.jsonl, root 0600; 06-AGENT-SECURITY §7). Panel đọc qua op audit.tail.
package audit

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Genesis là prev_hash của bản ghi đầu tiên.
var Genesis = strings.Repeat("0", 64)

// Entry là một dòng nhật ký.
type Entry struct {
	Seq         int64           `json:"seq"`
	TS          string          `json:"ts"`
	Op          string          `json:"op"`
	OpID        string          `json:"op_id"`
	CallerUID   int             `json:"caller_uid"`
	RequestedBy json.RawMessage `json:"requested_by,omitempty"`
	ParamsHash  string          `json:"params_hash"`
	Result      string          `json:"result"` // ok | error | rejected
	ErrorCode   *string         `json:"error_code"`
	PrevHash    string          `json:"prev_hash"`
	Hash        string          `json:"hash"`
}

// digest tính hash của entry (trường hash để trống).
func digest(e Entry) string {
	e.Hash = ""
	b, _ := json.Marshal(e)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// HashParams băm params thô (không lưu nội dung params để tránh lộ secret).
func HashParams(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

// Log là writer append-only.
type Log struct {
	path string
	now  func() time.Time

	mu   sync.Mutex
	f    *os.File
	seq  int64
	last string
}

// Open mở (tạo) file nhật ký, kiểm toàn chuỗi hiện có; chuỗi hỏng → lỗi (không ghi tiếp lên chuỗi hỏng).
func Open(path string) (*Log, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, err
	}
	res, err := Verify(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if !res.OK {
		return nil, fmt.Errorf("audit %s: chuỗi băm hỏng tại seq %d", path, res.BrokenSeq)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &Log{path: path, now: time.Now, f: f, seq: res.LastSeq, last: res.LastHash}, nil
}

// SetClock thay đồng hồ (test).
func (l *Log) SetClock(now func() time.Time) { l.now = now }

// Append ghi một bản ghi (điền seq, ts, prev_hash, hash) và fsync.
func (l *Log) Append(e Entry) (Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e.Seq = l.seq + 1
	e.TS = l.now().UTC().Format(time.RFC3339Nano)
	e.PrevHash = l.last
	e.Hash = digest(e)
	b, err := json.Marshal(e)
	if err != nil {
		return e, err
	}
	if _, err := l.f.Write(append(b, '\n')); err != nil {
		return e, err
	}
	if err := l.f.Sync(); err != nil {
		return e, err
	}
	l.seq, l.last = e.Seq, e.Hash
	return e, nil
}

// Close đóng file.
func (l *Log) Close() error { return l.f.Close() }

// Path trả đường dẫn file.
func (l *Log) Path() string { return l.path }

// VerifyResult là kết quả kiểm chuỗi.
type VerifyResult struct {
	OK        bool
	Count     int64
	LastSeq   int64
	LastHash  string
	BrokenSeq int64
}

// Verify đọc toàn bộ file và kiểm seq liên tục + hash + prev_hash.
func Verify(path string) (VerifyResult, error) {
	res := VerifyResult{OK: true, LastHash: Genesis}
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e Entry
		if err := json.Unmarshal(line, &e); err != nil || e.Seq != res.LastSeq+1 || e.PrevHash != res.LastHash || digest(e) != e.Hash {
			res.OK, res.BrokenSeq = false, res.LastSeq+1
			return res, nil
		}
		res.Count++
		res.LastSeq, res.LastHash = e.Seq, e.Hash
	}
	return res, sc.Err()
}

// Tail trả tối đa limit bản ghi có seq > after và kết quả kiểm chuỗi.
func Tail(path string, after int64, limit int) ([]Entry, VerifyResult, error) {
	v, err := Verify(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []Entry{}, VerifyResult{OK: true, LastHash: Genesis}, nil
	}
	if err != nil {
		return nil, v, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, v, err
	}
	defer f.Close()
	out := []Entry{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() && len(out) < limit {
		var e Entry
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Seq > after {
			out = append(out, e)
		}
	}
	return out, v, sc.Err()
}
