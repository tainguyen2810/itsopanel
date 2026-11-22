// Package relay là kênh agent từ xa (D-89, ADR 0035): itso-relay trên control plane nhận kết nối mTLS
// từ agent node (node quay số ra), Laravel gửi envelope đã ký qua unix socket của relay, relay chuyển
// nguyên byte tới node. Relay không có khóa HMAC của node nên không giả được op.
package relay

import (
	"encoding/json"
	"regexp"
)

// Giới hạn khung (ADR 0035 §1).
const (
	MaxEnvelope   = 1 << 20 // 1 MiB
	MaxResult     = 8 << 20 // 8 MiB
	MaxInflight   = 32
	AgentPath     = "/v1/agent"
	HeartbeatSecs = 20
)

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ValidUUID kiểm server_uuid (CN chứng chỉ node).
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

// Frame là một thông điệp JSON trên WebSocket. Body là byte nguyên văn (base64 khi mã hóa JSON) để
// chữ ký HMAC trên sha256(body) không đổi qua relay.
type Frame struct {
	T     string `json:"t"` // req | res | hb
	ID    string `json:"id,omitempty"`
	Sig   string `json:"sig,omitempty"`
	TS    string `json:"ts,omitempty"`
	Nonce string `json:"nonce,omitempty"`
	Body  []byte `json:"body,omitempty"`
}

func (f Frame) marshal() ([]byte, error) { return json.Marshal(f) }
