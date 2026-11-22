package ops

// uptime.probe (Phase 11, D-104, ADR 0049): agent tự gọi HTTP(S) tới website do chính node phục vụ.
// Luôn dial địa chỉ cố định của node (127.0.0.1:80/443, bỏ qua DNS, không proxy) với Host/SNI = domain website,
// nên không thể bị dùng để quét mạng nội bộ (chống SSRF). Redirect chỉ theo trong cùng host, tối đa 3 lần.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{contracts.OpUptimeProbe: d.uptimeProbe}
	})
}

const (
	uptimeMaxTargets   = 50
	uptimeParallel     = 8
	uptimeBodyLimit    = 64 << 10
	uptimeMaxRedirects = 3
)

var (
	reUptimePath    = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$`)
	reUptimePathBad = regexp.MustCompile(`(^|/)\.{1,2}(/|\?|$)|%2[eEfF]|//|%0[aAdD]`)
)

// CheckUptimePath kiểm lại UptimePath như contract (agent không tin panel).
func CheckUptimePath(p string) error {
	if len(p) > 200 || !reUptimePath.MatchString(p) || reUptimePathBad.MatchString(p) {
		return invalid("path không hợp lệ")
	}
	return nil
}

// uptimeKeyword giải mã keyword (null hoặc chuỗi 1–100 ký tự, không ký tự điều khiển).
func uptimeKeyword(raw json.RawMessage) (string, bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", false, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false, invalid("keyword không hợp lệ")
	}
	if n := len([]rune(s)); n < 1 || n > 100 {
		return "", false, invalid("keyword phải dài 1–100 ký tự")
	}
	for _, c := range s {
		if c < 0x20 || c == 0x7f {
			return "", false, invalid("keyword chứa ký tự điều khiển")
		}
	}
	return s, true, nil
}

type uptimeTarget struct {
	uuid, host, path, scheme string
	keyword                  string
	hasKeyword               bool
}

func (d *Deps) uptimeProbe(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.UptimeProbeParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if len(p.Targets) < 1 || len(p.Targets) > uptimeMaxTargets {
		return nil, invalidOp("targets phải có 1–50 phần tử")
	}
	if p.TimeoutSec < 1 || p.TimeoutSec > 10 {
		return nil, invalidOp("timeout_sec phải trong 1–10")
	}
	ts := make([]uptimeTarget, 0, len(p.Targets))
	for _, t := range p.Targets {
		if !reUUIDStr(string(t.CheckUUID)) {
			return nil, invalidOp("check_uuid không hợp lệ")
		}
		if err := validate.Domain(string(t.Host)); err != nil {
			return nil, opErr(err)
		}
		if err := CheckUptimePath(string(t.Path)); err != nil {
			return nil, opErr(err)
		}
		if t.Scheme != "http" && t.Scheme != "https" {
			return nil, invalidOp("scheme phải là http hoặc https")
		}
		kw, has, err := uptimeKeyword(t.Keyword)
		if err != nil {
			return nil, opErr(err)
		}
		ts = append(ts, uptimeTarget{uuid: string(t.CheckUUID), host: string(t.Host), path: string(t.Path), scheme: t.Scheme, keyword: kw, hasKeyword: has})
	}
	timeout := time.Duration(p.TimeoutSec) * time.Second
	out := make([]contracts.UptimeProbeResultResultsItem, len(ts))
	if d.Sandbox && d.HTTPAddrs == nil {
		c := d.metricsControl()
		for i, t := range ts {
			out[i] = d.simUptime(t, c)
		}
		return toData(contracts.UptimeProbeResult{Results: out})
	}
	sem := make(chan struct{}, uptimeParallel)
	var wg sync.WaitGroup
	for i, t := range ts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				out[i] = uptimeFail(t.uuid, "hết deadline của op", nil, nil)
				return
			}
			defer func() { <-sem }()
			out[i] = d.probeOne(ctx, t, timeout)
		}()
	}
	wg.Wait()
	return toData(contracts.UptimeProbeResult{Results: out})
}

func invalidOp(msg string) error {
	return &registry.OpError{Code: "invalid_params", Message: msg}
}

func uptimeFail(uuid, msg string, status, dur *int64) contracts.UptimeProbeResultResultsItem {
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return contracts.UptimeProbeResultResultsItem{CheckUUID: contracts.UUID(uuid), Status: status, DurationMs: dur, Error: &msg}
}

// probeOne gọi một website. Lỗi kết nối/timeout/redirect ra ngoài → ok=false kèm error ngắn (không lộ nội dung).
func (d *Deps) probeOne(ctx context.Context, t uptimeTarget, timeout time.Duration) contracts.UptimeProbeResultResultsItem {
	dialer := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, a string) (net.Conn, error) {
			_, port, _ := net.SplitHostPort(a)
			scheme := "http"
			if port == "443" {
				scheme = "https"
			}
			return dialer.DialContext(ctx, network, d.httpAddr(scheme)) // luôn là địa chỉ của node, bỏ qua DNS
		},
		// Đích là 127.0.0.1 của chính node; hạn chứng chỉ được đọc ra để cảnh báo, không chặn kết nối.
		TLSClientConfig:       tlsProbeConfig(t.host),
		ResponseHeaderTimeout: timeout,
		DisableKeepAlives:     true,
		Proxy:                 nil,
	}
	defer tr.CloseIdleConnections()
	errRedirect := errors.New("redirect ra ngoài host hoặc quá 3 lần")
	cl := &http.Client{Transport: tr, Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > uptimeMaxRedirects || !strings.EqualFold(req.URL.Hostname(), t.host) {
				return errRedirect
			}
			if p := req.URL.Port(); p != "" && p != "80" && p != "443" {
				return errRedirect
			}
			return nil
		}}
	u := &url.URL{Scheme: t.scheme, Host: t.host}
	full, err := url.Parse(u.String() + t.path)
	if err != nil {
		return uptimeFail(t.uuid, "path không hợp lệ", nil, nil)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full.String(), nil)
	if err != nil {
		return uptimeFail(t.uuid, "không tạo được request", nil, nil)
	}
	req.Header.Set("User-Agent", "itso-agent/"+Version+" (uptime)")
	start := time.Now()
	resp, err := cl.Do(req)
	dur := time.Since(start).Milliseconds()
	if err != nil {
		msg := "không kết nối được"
		var ne net.Error
		switch {
		case errors.Is(err, errRedirect):
			msg = errRedirect.Error()
		case errors.As(err, &ne) && ne.Timeout(), errors.Is(err, context.DeadlineExceeded):
			msg = "quá thời gian chờ"
		case strings.Contains(err.Error(), "tls:"):
			msg = "lỗi TLS"
		}
		return uptimeFail(t.uuid, msg, nil, &dur)
	}
	defer resp.Body.Close()
	st := int64(resp.StatusCode)
	res := contracts.UptimeProbeResultResultsItem{CheckUUID: contracts.UUID(t.uuid), Status: &st, DurationMs: &dur}
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		exp := resp.TLS.PeerCertificates[0].NotAfter.UTC().Format(time.RFC3339)
		res.CertExpiresAt = &exp
	}
	res.OK = st >= 200 && st < 400
	if t.hasKeyword {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, uptimeBodyLimit))
		found := strings.Contains(string(body), t.keyword)
		res.KeywordFound = &found
		if !found {
			res.OK = false
		}
	}
	if !res.OK {
		msg := "HTTP " + http.StatusText(resp.StatusCode)
		if res.KeywordFound != nil && !*res.KeywordFound && st >= 200 && st < 400 {
			msg = "không thấy từ khóa"
		}
		res.Error = &msg
	}
	return res
}

// simUptime: sandbox không có nginx; kết quả theo file điều khiển (uptime_down, cert_days).
func (d *Deps) simUptime(t uptimeTarget, c simMetricsControl) contracts.UptimeProbeResultResultsItem {
	dur := int64(40 + len(t.host)*7%120)
	for _, h := range c.UptimeDown {
		if strings.EqualFold(h, t.host) {
			st := int64(503)
			return uptimeFail(t.uuid, "HTTP Service Unavailable", &st, &dur)
		}
	}
	st := int64(200)
	res := contracts.UptimeProbeResultResultsItem{CheckUUID: contracts.UUID(t.uuid), OK: true, Status: &st, DurationMs: &dur}
	if t.scheme == "https" {
		days, ok := c.CertDays[t.host]
		if !ok {
			days = 60
		}
		exp := d.now().UTC().Add(time.Duration(days) * 24 * time.Hour).Truncate(time.Second).Format(time.RFC3339)
		res.CertExpiresAt = &exp
	}
	if t.hasKeyword {
		found := true
		res.KeywordFound = &found
	}
	return res
}

func tlsProbeConfig(host string) *tls.Config {
	return &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12} //nolint:gosec // xem chú thích ở probeOne
}
