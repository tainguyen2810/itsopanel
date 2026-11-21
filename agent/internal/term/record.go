package term

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

// Ghi phiên (ADR 0028): asciicast v2, một file /var/lib/itso/recordings/<session_uuid>.cast (root 0600) mỗi phiên.
// Chỉ ghi output ("o"); không ghi phím gõ (mật khẩu gõ không hiện thì không bị ghi). Vượt giới hạn → ghi
// marker "m" = TruncatedMarker và báo ErrRecordLimit để phiên đóng (lý do "limit").

// RecordLimit là dung lượng tối đa một bản ghi (50 MB).
const RecordLimit int64 = 50 << 20

// TruncatedMarker là nhãn sự kiện "m" cuối file khi bản ghi bị cắt.
const TruncatedMarker = "itso:truncated"

// ErrRecordLimit: bản ghi đã chạm giới hạn, phiên phải đóng.
var ErrRecordLimit = errors.New("term: bản ghi phiên vượt giới hạn dung lượng")

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// RecordingPath trả đường dẫn bản ghi trong dir (uuid đã kiểm định dạng).
func RecordingPath(dir, uuid string) (string, error) {
	if !uuidRe.MatchString(uuid) {
		return "", fmt.Errorf("session uuid không hợp lệ: %q", uuid)
	}
	return filepath.Join(dir, uuid+".cast"), nil
}

// Recorder ghi một phiên.
type Recorder struct {
	f     *os.File
	w     *bufio.Writer
	start time.Time
	now   func() time.Time
	limit int64
	n     atomic.Int64
	carry []byte
	full  bool
	// mu: Output (goroutine đọc shell) và Close (Serve kết thúc) có thể chạy song song.
	mu     sync.Mutex
	closed bool
}

// ErrRecorderClosed: Output sau khi Close.
var ErrRecorderClosed = errors.New("term: bản ghi đã đóng")

type castHeader struct {
	Version   int               `json:"version"`
	Width     int               `json:"width"`
	Height    int               `json:"height"`
	Timestamp int64             `json:"timestamp"`
	Env       map[string]string `json:"env"`
}

// NewRecorder tạo file mới (O_EXCL|O_NOFOLLOW, 0600) và ghi header asciicast v2.
func NewRecorder(dir string, s *Session, limit int64, now func() time.Time) (*Recorder, error) {
	p, err := RecordingPath(dir, s.UUID)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = RecordLimit
	}
	if now == nil {
		now = time.Now
	}
	r := &Recorder{f: f, w: bufio.NewWriterSize(f, 32<<10), start: now(), now: now, limit: limit}
	h, _ := json.Marshal(castHeader{Version: 2, Width: s.Cols, Height: s.Rows, Timestamp: r.start.Unix(),
		Env: map[string]string{"TERM": "xterm-256color", "SHELL": "/bin/bash"}})
	if err := r.line(h); err != nil {
		_ = f.Close()
		return nil, err
	}
	return r, nil
}

// Bytes là số byte đã ghi (gồm header).
func (r *Recorder) Bytes() int64 { return r.n.Load() }

func (r *Recorder) line(b []byte) error {
	b = append(b, '\n')
	if _, err := r.w.Write(b); err != nil {
		return err
	}
	r.n.Add(int64(len(b)))
	return nil
}

func (r *Recorder) event(code, data string) []byte {
	t := float64(r.now().Sub(r.start).Microseconds()) / 1e6
	b, _ := json.Marshal([]any{t, code, data})
	return b
}

// Output ghi một khối output; giữ lại phần UTF-8 dở dang cho lần sau. Vượt giới hạn → marker + ErrRecordLimit.
func (r *Recorder) Output(p []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return ErrRecorderClosed
	}
	if r.full {
		return ErrRecordLimit
	}
	buf := append(r.carry, p...)
	cut := len(buf)
	for i := 1; i <= 3 && i <= len(buf); i++ { // rune dở dang ở cuối (tối đa 3 byte của rune 4 byte)
		c := buf[len(buf)-i]
		if c < 0x80 {
			break
		}
		if c >= 0xC0 { // byte đầu rune
			if !utf8.FullRune(buf[len(buf)-i:]) {
				cut = len(buf) - i
			}
			break
		}
	}
	r.carry = append([]byte(nil), buf[cut:]...)
	if cut == 0 {
		return nil
	}
	ev := r.event("o", string(bytes.ToValidUTF8(buf[:cut], []byte("�"))))
	if r.n.Load()+int64(len(ev))+1 > r.limit {
		r.full = true
		_ = r.line(r.event("m", TruncatedMarker))
		_ = r.w.Flush()
		return ErrRecordLimit
	}
	if err := r.line(ev); err != nil {
		return err
	}
	return r.w.Flush() // mỗi khối một lần ghi: pty.recording.read đọc được phiên đang mở
}

// Close ghi nốt và đóng file.
func (r *Recorder) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	err := r.w.Flush()
	if e := r.f.Close(); err == nil {
		err = e
	}
	return err
}

// Page là một trang bản ghi đọc theo offset.
type Page struct {
	Width, Height int
	Events        []Event
	NextOffset    int64
	Truncated     bool
	EOF           bool
}

// Event là một sự kiện output.
type Event struct {
	T    float64
	Data string
}

// MaxLine là độ dài tối đa một dòng bản ghi khi đọc (một khối 16 KB escape JSON tối đa ~96 KB).
const MaxLine = 1 << 20

// ReadPage đọc các dòng trọn vẹn từ offset, tối đa maxBytes (ít nhất một dòng nếu dòng dài hơn maxBytes).
// offset phải là đầu một dòng (0 hoặc next_offset trước đó). live: phiên còn đang ghi → chưa EOF.
func ReadPage(path string, offset, maxBytes int64, live bool) (*Page, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errors.New("bản ghi không phải file thường")
	}
	size := fi.Size()
	hr := bufio.NewReaderSize(io.NewSectionReader(f, 0, size), 4096)
	hl, err := hr.ReadSlice('\n')
	if err != nil {
		return nil, errors.New("bản ghi thiếu header asciicast")
	}
	var h castHeader
	if json.Unmarshal(hl, &h) != nil || h.Version != 2 || h.Width < 1 || h.Height < 1 {
		return nil, errors.New("header asciicast không hợp lệ")
	}
	pg := &Page{Width: h.Width, Height: h.Height, Events: []Event{}}
	if offset < int64(len(hl)) {
		offset = int64(len(hl))
	}
	if offset > size {
		return nil, fmt.Errorf("offset %d vượt kích thước bản ghi %d", offset, size)
	}
	if offset > int64(len(hl)) { // offset phải ngay sau một dấu xuống dòng
		var prev [1]byte
		if _, err := f.ReadAt(prev[:], offset-1); err != nil || prev[0] != '\n' {
			return nil, errors.New("offset không nằm ở đầu dòng")
		}
	}
	window := maxBytes
	if window < MaxLine {
		window = MaxLine // đọc tối đa một dòng dài, nhưng chỉ nhận thêm dòng khi còn trong maxBytes
	}
	br := bufio.NewReaderSize(io.NewSectionReader(f, offset, min(window, size-offset)), 64<<10)
	pos := offset
	for {
		l, err := br.ReadBytes('\n')
		if err != nil { // dòng dở (đang ghi) hoặc hết cửa sổ
			break
		}
		if pos > offset && pos+int64(len(l))-offset > maxBytes {
			break
		}
		pos += int64(len(l))
		var ev []json.RawMessage
		if json.Unmarshal(l, &ev) != nil || len(ev) != 3 {
			return nil, fmt.Errorf("dòng bản ghi hỏng tại byte %d", pos-int64(len(l)))
		}
		var t float64
		var code, data string
		if json.Unmarshal(ev[0], &t) != nil || json.Unmarshal(ev[1], &code) != nil || json.Unmarshal(ev[2], &data) != nil {
			return nil, fmt.Errorf("dòng bản ghi hỏng tại byte %d", pos-int64(len(l)))
		}
		switch code {
		case "o":
			pg.Events = append(pg.Events, Event{T: t, Data: data})
		case "m":
			if data == TruncatedMarker {
				pg.Truncated = true
			}
		}
	}
	pg.NextOffset = pos
	pg.EOF = !live && pos >= size
	if !pg.Truncated && size > 0 { // marker luôn là dòng cuối
		tail := make([]byte, min(int64(256), size))
		if _, err := f.ReadAt(tail, size-int64(len(tail))); err == nil && bytes.Contains(tail, []byte(`"m","`+TruncatedMarker+`"`)) {
			pg.Truncated = true
		}
	}
	return pg, nil
}
