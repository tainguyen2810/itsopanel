// Package term là phần terminal USER của agent (D-75): ticket một lần, phiên pty và giao thức khung trên socket
// stream /run/itso/agent-stream.sock. itso-gateway chỉ dùng bộ mã khung (frame.go); quyền quyết ở panel + agent.
package term

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Loại khung: [1 byte loại][4 byte độ dài big-endian][payload].
const (
	FrameData   byte = 0 // byte terminal (hai chiều)
	FrameResize byte = 1 // client → agent: {"cols","rows"}
	FrameExit   byte = 2 // agent → client: {"reason"} rồi đóng
)

// MaxFrame là payload tối đa của một khung.
const MaxFrame = 64 << 10

// ErrFrame khi khung sai định dạng.
var ErrFrame = errors.New("term: khung không hợp lệ")

// WriteFrame ghi một khung.
func WriteFrame(w io.Writer, typ byte, payload []byte) error {
	if len(payload) > MaxFrame {
		return ErrFrame
	}
	hdr := [5]byte{typ}
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(append(hdr[:], payload...)); err != nil {
		return err
	}
	return nil
}

// ReadFrame đọc một khung.
func ReadFrame(r io.Reader) (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxFrame || hdr[0] > FrameExit {
		return 0, nil, ErrFrame
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return hdr[0], buf, nil
}

// Resize là payload khung FrameResize (cũng là khung text JSON từ trình duyệt qua gateway).
type Resize struct {
	Type string `json:"type,omitempty"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// Valid kiểm miền kích thước (như pty.open).
func (r Resize) Valid() bool { return r.Cols >= 20 && r.Cols <= 500 && r.Rows >= 5 && r.Rows <= 200 }

// Exit là payload khung FrameExit.
type Exit struct {
	Reason string `json:"reason"` // exited | idle | expired | closed
}

// ExitFrame mã hóa Exit.
func ExitFrame(reason string) []byte {
	b, _ := json.Marshal(Exit{Reason: reason})
	return b
}

// Handshake: client gửi "ATTACH <ticket>\n"; agent trả "OK\n" hoặc "ERR <mã>\n" rồi đóng.

// WriteAttach gửi dòng ATTACH.
func WriteAttach(w io.Writer, ticket string) error {
	if !ValidTicket(ticket) {
		return ErrTicket
	}
	_, err := fmt.Fprintf(w, "ATTACH %s\n", ticket)
	return err
}

// ReadAttachReply đọc phản hồi handshake; lỗi mang mã agent (ticket_invalid, ticket_expired…).
func ReadAttachReply(r *bufio.Reader) error {
	line, err := readLine(r)
	if err != nil {
		return err
	}
	if line == "OK" {
		return nil
	}
	if code, ok := strings.CutPrefix(line, "ERR "); ok {
		return &AttachError{Code: code}
	}
	return ErrFrame
}

// AttachError là từ chối handshake.
type AttachError struct{ Code string }

func (e *AttachError) Error() string { return "term: agent từ chối phiên: " + e.Code }

// readLine đọc một dòng tối đa 128 byte.
func readLine(r *bufio.Reader) (string, error) {
	var b []byte
	for len(b) <= 128 {
		c, err := r.ReadByte()
		if err != nil {
			return "", err
		}
		if c == '\n' {
			return string(b), nil
		}
		b = append(b, c)
	}
	return "", ErrFrame
}
