package ops_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/ops"
)

const (
	upA = "0193e011-0001-7000-8000-0000000000a1"
	upB = "0193e011-0001-7000-8000-0000000000b2"
)

func upTarget(uuid, host, path, scheme string, keyword any) map[string]any {
	return map[string]any{"check_uuid": uuid, "host": host, "path": path, "scheme": scheme, "keyword": keyword}
}

func upProbe(targets ...map[string]any) map[string]any {
	ts := make([]any, len(targets))
	for i, t := range targets {
		ts[i] = t
	}
	return map[string]any{"targets": ts, "timeout_sec": 1}
}

func upResults(t *testing.T, d map[string]any) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, r := range d["results"].([]any) {
		out = append(out, r.(map[string]any))
	}
	return out
}

func TestUptimeProbe(t *testing.T) {
	e := newEnv(t)
	var mu sync.Mutex
	var hosts []string
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hosts = append(hosts, r.Host)
		mu.Unlock()
		switch r.URL.Path {
		case "/":
			_, _ = w.Write([]byte("<html>Xin chào An Phát</html>"))
		case "/err":
			w.WriteHeader(http.StatusInternalServerError)
		case "/slow":
			time.Sleep(1500 * time.Millisecond)
		case "/evil":
			http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
		case "/port":
			http.Redirect(w, r, "http://anphat.vn:2222/", http.StatusFound)
		case "/same":
			http.Redirect(w, r, "/?from=same", http.StatusMovedPermanently)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		}
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	tlsSrv := httptest.NewTLSServer(h)
	defer tlsSrv.Close()
	e.d.HTTPAddrs = map[string]string{"http": srv.Listener.Addr().String(), "https": tlsSrv.Listener.Addr().String()}

	d := e.h.OK(contracts.OpUptimeProbe, upProbe(
		upTarget(upA, "anphat.vn", "/", "http", "An Phát"),
		upTarget(upB, "anphat.vn", "/", "http", "không có"),
		upTarget(upA, "anphat.vn", "/err", "http", nil),
		upTarget(upA, "anphat.vn", "/slow", "http", nil),
		upTarget(upA, "anphat.vn", "/evil", "http", nil),
		upTarget(upA, "anphat.vn", "/port", "http", nil),
		upTarget(upA, "anphat.vn", "/same", "http", nil),
		upTarget(upA, "anphat.vn", "/loop", "http", nil),
		upTarget(upA, "anphat.vn", "/?q=1&x=a", "https", nil),
	))
	r := upResults(t, d)
	if len(r) != 9 || r[0]["ok"] != true || r[0]["keyword_found"] != true || r[0]["status"] != float64(200) || r[0]["error"] != nil ||
		r[0]["cert_expires_at"] != nil || r[0]["check_uuid"] != upA {
		t.Fatal(r[0])
	}
	if r[1]["ok"] != false || r[1]["keyword_found"] != false || r[1]["error"] != "không thấy từ khóa" || r[1]["check_uuid"] != upB {
		t.Fatal(r[1])
	}
	if r[2]["ok"] != false || r[2]["status"] != float64(500) || r[2]["keyword_found"] != nil {
		t.Fatal(r[2])
	}
	if r[3]["ok"] != false || r[3]["status"] != nil || r[3]["error"] != "quá thời gian chờ" {
		t.Fatal("timeout_sec áp cho từng URL", r[3])
	}
	for _, i := range []int{4, 5, 7} {
		if r[i]["ok"] != false || r[i]["status"] != nil || !strings.Contains(r[i]["error"].(string), "redirect") {
			t.Fatal("redirect ra host khác / cổng lạ / quá 3 lần bị chặn", i, r[i])
		}
	}
	if r[6]["ok"] != true || r[6]["status"] != float64(200) {
		t.Fatal("redirect cùng host được theo", r[6])
	}
	if r[8]["ok"] != true || r[8]["cert_expires_at"] == nil {
		t.Fatal("https trả hạn chứng chỉ", r[8])
	}
	exp, err := time.Parse(time.RFC3339, r[8]["cert_expires_at"].(string))
	if err != nil || !exp.Equal(tlsSrv.Certificate().NotAfter.UTC().Truncate(time.Second)) {
		t.Fatal(exp, err)
	}
	mu.Lock()
	for _, h := range hosts {
		if h != "anphat.vn" {
			t.Fatal("chỉ gọi tới địa chỉ của node với Host là domain website", hosts)
		}
	}
	mu.Unlock()

	// Không kết nối được → ok=false, không lỗi op.
	e.d.HTTPAddrs = map[string]string{"http": "127.0.0.1:1"}
	if r := upResults(t, e.h.OK(contracts.OpUptimeProbe, upProbe(upTarget(upA, "anphat.vn", "/", "http", nil)))); r[0]["ok"] != false || r[0]["error"] != "không kết nối được" {
		t.Fatal(r)
	}
}

func TestUptimeProbeRejectsEvil(t *testing.T) {
	e := newEnv(t)
	for _, bad := range []map[string]any{
		upTarget(upA, "127.0.0.1", "/", "http", nil),
		upTarget(upA, "localhost", "/", "http", nil),
		upTarget(upA, "anphat.vn:22", "/", "http", nil),
		upTarget(upA, "anphat.vn", "/../etc/passwd", "http", nil),
		upTarget(upA, "anphat.vn", "/a/..", "http", nil),
		upTarget(upA, "anphat.vn", "/a/%2e%2e/b", "http", nil),
		upTarget(upA, "anphat.vn", "//evil.example/", "http", nil),
		upTarget(upA, "anphat.vn", "/a%0d%0aSet-Cookie:x", "http", nil),
		upTarget(upA, "anphat.vn", "http://evil/", "http", nil),
		upTarget(upA, "anphat.vn", "/", "gopher", nil),
		upTarget(upA, "anphat.vn", "/", "http", "a\nb"),
		upTarget(upA, "anphat.vn", "/", "http", ""),
		upTarget(upA, "anphat.vn", "/", "http", strings.Repeat("x", 101)),
		upTarget("not-a-uuid", "anphat.vn", "/", "http", nil),
	} {
		e.h.Fail(contracts.OpUptimeProbe, upProbe(bad), "invalid_params")
	}
	many := make([]map[string]any, 51)
	for i := range many {
		many[i] = upTarget(upA, "anphat.vn", "/", "http", nil)
	}
	e.h.Fail(contracts.OpUptimeProbe, upProbe(many...), "invalid_params")
	p := upProbe(upTarget(upA, "anphat.vn", "/", "http", nil))
	p["timeout_sec"] = 11
	e.h.Fail(contracts.OpUptimeProbe, p, "invalid_params")
}

func TestUptimeProbeSandbox(t *testing.T) {
	e := newEnv(t)
	e.d.Sandbox = true
	write(t, e.fs.Root, ops.SimMetricsControl, `{"uptime_down": ["down.vn"], "cert_days": {"soon.vn": 5}}`)
	r := upResults(t, e.h.OK(contracts.OpUptimeProbe, upProbe(
		upTarget(upA, "anphat.vn", "/", "https", "x"),
		upTarget(upA, "down.vn", "/", "http", nil),
		upTarget(upA, "soon.vn", "/", "https", nil),
	)))
	if r[0]["ok"] != true || r[0]["keyword_found"] != true || r[0]["cert_expires_at"] == nil {
		t.Fatal(r[0])
	}
	if r[1]["ok"] != false || r[1]["status"] != float64(503) {
		t.Fatal(r[1])
	}
	exp, _ := time.Parse(time.RFC3339, r[2]["cert_expires_at"].(string))
	if d := exp.Sub(e.d.Now()); d < 4*24*time.Hour || d > 6*24*time.Hour {
		t.Fatal("cert_days điều khiển hạn chứng chỉ", r[2])
	}
}
