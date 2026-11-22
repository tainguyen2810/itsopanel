package relay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// ErrNotConnected: node chưa/không kết nối (Laravel đổi thành job waiting_agent, D-91).
var ErrNotConnected = errors.New("node không kết nối")

// Hub giữ kết nối của các node (một kết nối mỗi server_uuid) và danh sách fingerprint bị thu hồi.
type Hub struct {
	Log       *slog.Logger
	StateFile string // lưu danh sách thu hồi (JSON); rỗng = chỉ trong bộ nhớ
	Now       func() time.Time

	mu      sync.Mutex
	nodes   map[string]*nodeConn
	revoked map[string]bool
}

type nodeConn struct {
	uuid, fp, remote string
	notAfter         time.Time
	since            time.Time
	conn             *websocket.Conn
	cancel           context.CancelFunc
	sem              chan struct{}
	writeMu          sync.Mutex

	mu       sync.Mutex
	lastSeen time.Time
	pending  map[string]chan Frame
	closed   bool
}

// NodeStatus là một dòng của GET /v1/status.
type NodeStatus struct {
	ServerUUID  string    `json:"server_uuid"`
	Connected   bool      `json:"connected"`
	Since       time.Time `json:"since"`
	LastSeen    time.Time `json:"last_seen"`
	Fingerprint string    `json:"fingerprint_sha256"`
	NotAfter    time.Time `json:"cert_not_after"`
	Remote      string    `json:"remote_addr"`
}

// NewHub tạo hub và nạp danh sách thu hồi đã lưu.
func NewHub(stateFile string, log *slog.Logger) (*Hub, error) {
	h := &Hub{Log: log, StateFile: stateFile, nodes: map[string]*nodeConn{}, revoked: map[string]bool{}}
	if stateFile != "" {
		if b, err := os.ReadFile(stateFile); err == nil {
			var st struct {
				Revoked []string `json:"revoked"`
			}
			if err := json.Unmarshal(b, &st); err != nil {
				return nil, err
			}
			for _, f := range st.Revoked {
				h.revoked[f] = true
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	return h, nil
}

func (h *Hub) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// IsRevoked cho biết fingerprint đã bị thu hồi.
func (h *Hub) IsRevoked(fp string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.revoked[fp]
}

// SetRevoked thay danh sách thu hồi, cắt ngay kết nối dùng fingerprint bị thu hồi và lưu xuống đĩa.
func (h *Hub) SetRevoked(fps []string) error {
	h.mu.Lock()
	h.revoked = map[string]bool{}
	for _, f := range fps {
		h.revoked[f] = true
	}
	var cut []*nodeConn
	for _, n := range h.nodes {
		if h.revoked[n.fp] {
			cut = append(cut, n)
		}
	}
	list := make([]string, 0, len(h.revoked))
	for f := range h.revoked {
		list = append(list, f)
	}
	h.mu.Unlock()
	sort.Strings(list)
	for _, n := range cut {
		n.close(websocket.StatusPolicyViolation, "chứng chỉ bị thu hồi")
	}
	if h.StateFile == "" {
		return nil
	}
	b, _ := json.Marshal(map[string]any{"revoked": list})
	tmp := h.StateFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, h.StateFile)
}

// Accept nhận kết nối WebSocket của node. Caller đã kiểm chứng chỉ client (chuỗi CA, hạn); hàm này kiểm
// CN = server_uuid và thu hồi, rồi phục vụ tới khi kết nối đóng.
func (h *Hub) Accept(w http.ResponseWriter, r *http.Request) {
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "cần chứng chỉ client do CA nội bộ cấp", http.StatusUnauthorized)
		return
	}
	cert := r.TLS.PeerCertificates[0]
	uuid := cert.Subject.CommonName
	sum := sha256.Sum256(cert.Raw)
	fp := hex.EncodeToString(sum[:])
	if !ValidUUID(uuid) {
		http.Error(w, "CN chứng chỉ không phải server_uuid", http.StatusForbidden)
		return
	}
	if h.IsRevoked(fp) {
		h.logWarn("từ chối node: chứng chỉ bị thu hồi", "server", uuid, "fp", fp)
		http.Error(w, "chứng chỉ bị thu hồi", http.StatusForbidden)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(MaxResult + 4096)
	ctx, cancel := context.WithCancel(context.Background())
	now := h.now()
	n := &nodeConn{uuid: uuid, fp: fp, remote: r.RemoteAddr, notAfter: cert.NotAfter, since: now, lastSeen: now,
		conn: c, cancel: cancel, sem: make(chan struct{}, MaxInflight), pending: map[string]chan Frame{}}
	h.mu.Lock()
	old := h.nodes[uuid]
	h.nodes[uuid] = n
	h.mu.Unlock()
	if old != nil {
		old.close(websocket.StatusGoingAway, "kết nối mới thay thế")
	}
	h.logInfo("node kết nối", "server", uuid, "remote", r.RemoteAddr)
	n.readLoop(ctx)
	h.mu.Lock()
	if h.nodes[uuid] == n {
		delete(h.nodes, uuid)
	}
	h.mu.Unlock()
	n.close(websocket.StatusNormalClosure, "")
	h.logInfo("node ngắt kết nối", "server", uuid)
}

func (n *nodeConn) readLoop(ctx context.Context) {
	for {
		typ, b, err := n.conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var f Frame
		if json.Unmarshal(b, &f) != nil {
			continue
		}
		n.mu.Lock()
		n.lastSeen = time.Now()
		ch := n.pending[f.ID]
		if f.T == "res" && ch != nil {
			delete(n.pending, f.ID)
		}
		n.mu.Unlock()
		if f.T == "res" && ch != nil {
			ch <- f
		}
	}
}

func (n *nodeConn) close(code websocket.StatusCode, reason string) {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return
	}
	n.closed = true
	for id, ch := range n.pending {
		close(ch)
		delete(n.pending, id)
	}
	n.mu.Unlock()
	_ = n.conn.Close(code, reason)
	n.cancel()
}

// Call gửi envelope đã ký tới node và chờ kết quả (byte nguyên văn của agent).
func (h *Hub) Call(ctx context.Context, uuid, sig, ts, nonce string, body []byte) ([]byte, error) {
	h.mu.Lock()
	n := h.nodes[uuid]
	h.mu.Unlock()
	if n == nil {
		return nil, ErrNotConnected
	}
	select {
	case n.sem <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-n.sem }()
	idb := make([]byte, 12)
	_, _ = rand.Read(idb)
	id := hex.EncodeToString(idb)
	ch := make(chan Frame, 1)
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return nil, ErrNotConnected
	}
	n.pending[id] = ch
	n.mu.Unlock()
	msg, _ := Frame{T: "req", ID: id, Sig: sig, TS: ts, Nonce: nonce, Body: body}.marshal()
	n.writeMu.Lock()
	err := n.conn.Write(ctx, websocket.MessageText, msg)
	n.writeMu.Unlock()
	if err != nil {
		n.mu.Lock()
		delete(n.pending, id)
		n.mu.Unlock()
		return nil, ErrNotConnected
	}
	select {
	case f, ok := <-ch:
		if !ok {
			return nil, ErrNotConnected
		}
		return f.Body, nil
	case <-ctx.Done():
		n.mu.Lock()
		delete(n.pending, id)
		n.mu.Unlock()
		return nil, ctx.Err()
	}
}

// Status liệt kê node đang kết nối.
func (h *Hub) Status() []NodeStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]NodeStatus, 0, len(h.nodes))
	for _, n := range h.nodes {
		n.mu.Lock()
		out = append(out, NodeStatus{ServerUUID: n.uuid, Connected: !n.closed, Since: n.since, LastSeen: n.lastSeen,
			Fingerprint: n.fp, NotAfter: n.notAfter, Remote: n.remote})
		n.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ServerUUID < out[j].ServerUUID })
	return out
}

func (h *Hub) logInfo(msg string, kv ...any) {
	if h.Log != nil {
		h.Log.Info(msg, kv...)
	}
}

func (h *Hub) logWarn(msg string, kv ...any) {
	if h.Log != nil {
		h.Log.Warn(msg, kv...)
	}
}
