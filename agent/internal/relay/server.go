package relay

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"itso.local/agent/internal/auth"
)

// Header khi relay chuyển tiếp yêu cầu enroll tới Laravel (127.0.0.1). Laravel chỉ nhận enroll có chữ ký
// relay hợp lệ: chữ ký = hex(HMAC-SHA256(relay_key, "relay-enroll\n" + ts + "\n" + hex(sha256(body)))).
const (
	HeaderRelaySignature = "X-Itso-Relay-Signature"
	HeaderRelayTimestamp = "X-Itso-Relay-Timestamp"
	HeaderRelayClientIP  = "X-Itso-Relay-Client-Ip"
	EnrollLimit          = 10
	EnrollWindow         = 10 * time.Minute
)

// SignEnroll tính chữ ký relay cho body enroll (Laravel kiểm lại cùng công thức).
func SignEnroll(key []byte, ts int64, body []byte) string {
	sum := sha256.Sum256(body)
	m := hmac.New(sha256.New, key)
	m.Write([]byte("relay-enroll\n" + strconv.FormatInt(ts, 10) + "\n" + hex.EncodeToString(sum[:])))
	return hex.EncodeToString(m.Sum(nil))
}

// Server gom các handler của itso-relay.
type Server struct {
	Hub       *Hub
	CAPEM     []byte       // CA nội bộ (công khai, để installer ghim sha256)
	EnrollURL string       // http://127.0.0.1/api/v1/internal/nodes:enroll; rỗng = tắt enroll
	RelayKey  []byte       // khóa ký yêu cầu enroll chuyển tiếp
	Client    *http.Client // tới Laravel
	Now       func() time.Time
	CallTTL   time.Duration // thời gian tối đa chờ node trả kết quả (mặc định 15 phút)

	rlMu sync.Mutex
	rl   map[string][]time.Time
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// TLSConfig cho cổng công khai: TLS 1.3; chứng chỉ client được kiểm theo CA nội bộ nếu có gửi
// (GET /v1/ca và POST /v1/enroll không cần, /v1/agent bắt buộc — Hub.Accept từ chối khi thiếu).
func TLSConfig(serverCert tls.Certificate, caPEM []byte) (*tls.Config, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("CA PEM không hợp lệ")
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCert},
		ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: pool, NextProtos: []string{"http/1.1"}}, nil
}

// PublicHandler phục vụ cổng :28444.
func (s *Server) PublicHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/ca", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-pem-file")
		_, _ = w.Write(s.CAPEM)
	})
	mux.HandleFunc("POST /v1/enroll", s.enroll)
	mux.HandleFunc("GET "+AgentPath, s.Hub.Accept)
	return mux
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

// allow áp giới hạn EnrollLimit lần mỗi EnrollWindow theo IP.
func (s *Server) allow(ip string) bool {
	s.rlMu.Lock()
	defer s.rlMu.Unlock()
	if s.rl == nil {
		s.rl = map[string][]time.Time{}
	}
	now := s.now()
	keep := s.rl[ip][:0]
	for _, t := range s.rl[ip] {
		if now.Sub(t) < EnrollWindow {
			keep = append(keep, t)
		}
	}
	if len(keep) >= EnrollLimit {
		s.rl[ip] = keep
		return false
	}
	s.rl[ip] = append(keep, now)
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	if s.EnrollURL == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"code": "not_found"})
		return
	}
	ip := clientIP(r)
	if !s.allow(ip) {
		w.Header().Set("Retry-After", "600")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "rate_limited"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10+1))
	if err != nil || len(body) > 64<<10 || !json.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "validation_failed"})
		return
	}
	ts := s.now().Unix()
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.EnrollURL, bytes.NewReader(body))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"code": "panel_unavailable"})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set(HeaderRelayTimestamp, strconv.FormatInt(ts, 10))
	req.Header.Set(HeaderRelaySignature, SignEnroll(s.RelayKey, ts, body))
	req.Header.Set(HeaderRelayClientIP, ip)
	c := s.Client
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := c.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"code": "panel_unavailable"})
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 1<<20))
}

// SocketHandler phục vụ unix socket cho Laravel (quyền do mode/nhóm của socket quyết định).
func (s *Server) SocketHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/nodes/{uuid}/ops", s.forward)
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"nodes": s.Hub.Status()})
	})
	mux.HandleFunc("PUT /v1/revocations", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Fingerprints []string `json:"fingerprints"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "validation_failed"})
			return
		}
		for _, f := range in.Fingerprints {
			if len(f) != 64 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"code": "validation_failed"})
				return
			}
			if _, err := hex.DecodeString(f); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"code": "validation_failed"})
				return
			}
		}
		if err := s.Hub.SetRevoked(in.Fingerprints); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"code": "internal"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"revoked": len(in.Fingerprints)})
	})
	return mux
}

// forward chuyển nguyên byte envelope và header chữ ký của panel tới node; relay không đọc/sửa envelope.
func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	uuid := r.PathValue("uuid")
	if !ValidUUID(uuid) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "validation_failed"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxEnvelope+1))
	if err != nil || len(body) > MaxEnvelope {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"code": "payload_too_large"})
		return
	}
	ttl := s.CallTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), ttl)
	defer cancel()
	out, err := s.Hub.Call(ctx, uuid, r.Header.Get(auth.HeaderSignature), r.Header.Get(auth.HeaderTimestamp),
		r.Header.Get(auth.HeaderNonce), body)
	if err != nil {
		code := http.StatusServiceUnavailable
		if errors.Is(err, context.DeadlineExceeded) {
			code = http.StatusGatewayTimeout
		}
		writeJSON(w, code, map[string]string{"code": "agent_unreachable", "message": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}
