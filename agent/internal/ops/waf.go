package ops

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// WAF ModSecurity v3 + OWASP CRS theo website (D-78, ADR 0025). Vhost (D-67) luôn có
// `include /etc/itso/waf/<uuid>.nginx*;` (glob: không có file thì nginx bỏ qua); waf.apply tạo/xóa file include đó
// và file rule /etc/itso/waf/<uuid>.conf từ tham số kiểu hóa. Không có ô cấu hình tự do.

const (
	WafDir      = "/etc/itso/waf"
	WafAuditLog = "/var/log/itso/waf/audit.log"
	// Gói kho Ubuntu 24.04 (recipe modsecurity). Thiếu → available=false.
	CrsSetup     = "/etc/modsecurity/crs/crs-setup.conf"
	CrsRules     = "/usr/share/modsecurity-crs/rules"
	ModsecModule = "/etc/nginx/modules-enabled/50-mod-http-modsecurity.conf"
	wafMaxRead   = 4 << 20
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpWAFApply:  d.wafApply,
			contracts.OpWAFEvents: d.wafEvents,
		}
	})
}

// WafIncludePath là file include nginx của website (vhost tham chiếu bằng glob).
func WafIncludePath(websiteUUID string) string { return WafDir + "/" + websiteUUID + ".nginx" }

// WafRulesPath là file rule ModSecurity của website.
func WafRulesPath(websiteUUID string) string { return WafDir + "/" + websiteUUID + ".conf" }

// WafRules sinh file rule ModSecurity. Thứ tự: engine → audit log JSON → paranoia (trước crs-setup) → CRS → loại trừ.
func WafRules(websiteUUID, mode string, paranoia int64, excl []contracts.WAFRuleID) string {
	var b strings.Builder
	b.WriteString("# Sinh bởi itso-agent (waf.apply, D-78). Không sửa tay.\n")
	fmt.Fprintf(&b, "# website %s\n", websiteUUID)
	fmt.Fprintf(&b, "SecRuleEngine %s\n", mode)
	b.WriteString("SecRequestBodyAccess On\nSecRequestBodyLimit 13107200\nSecRequestBodyNoFilesLimit 131072\n")
	b.WriteString("SecResponseBodyAccess Off\nSecTmpDir /tmp\nSecDataDir /var/cache/modsecurity\n")
	b.WriteString("SecAuditEngine RelevantOnly\nSecAuditLogRelevantStatus \"^(?:5|4(?!04))\"\n")
	fmt.Fprintf(&b, "SecAuditLogParts ABHZ\nSecAuditLogType Serial\nSecAuditLogFormat JSON\nSecAuditLog %s\n", WafAuditLog)
	fmt.Fprintf(&b, "SecAction \"id:900000,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=%d\"\n", paranoia)
	fmt.Fprintf(&b, "Include %s\nInclude %s/*.conf\n", CrsSetup, CrsRules)
	ids := make([]int64, 0, len(excl))
	for _, id := range excl {
		ids = append(ids, int64(id))
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		fmt.Fprintf(&b, "SecRuleRemoveById %d\n", id)
	}
	return b.String()
}

// WafInclude là khối nginx đặt trong server của website.
func WafInclude(websiteUUID string) string {
	return "# Sinh bởi itso-agent (waf.apply). Không sửa tay.\nmodsecurity on;\nmodsecurity_rules_file " + WafRulesPath(websiteUUID) + ";\n"
}

func (d *Deps) wafAvailable() bool {
	return d.FS.Exists(CrsSetup) && d.FS.Exists(CrsRules) && d.FS.Exists(ModsecModule)
}

func (d *Deps) wafApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WAFApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	id := string(p.WebsiteUUID)
	switch {
	case !reUUID.MatchString(id):
		return nil, fwInvalid("website_uuid không hợp lệ")
	case p.Mode != "DetectionOnly" && p.Mode != "On" && p.Mode != "Off":
		return nil, fwInvalid("mode %q không hợp lệ", p.Mode)
	case p.ParanoiaLevel < 1 || p.ParanoiaLevel > 4:
		return nil, fwInvalid("paranoia_level ngoài 1–4")
	case len(p.RuleExclusions) > 200:
		return nil, fwInvalid("quá 200 rule loại trừ")
	}
	seen := map[contracts.WAFRuleID]bool{}
	for _, r := range p.RuleExclusions {
		if r < 1 || r > 99999999 || seen[r] {
			return nil, fwInvalid("rule_exclusions: %d không hợp lệ hoặc trùng", r)
		}
		seen[r] = true
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	nginxMu.Lock()
	defer nginxMu.Unlock()
	inc := WafIncludePath(id)
	off := p.Mode == "Off" || !d.wafAvailable()
	if off {
		if !d.FS.Exists(inc) {
			_, _ = d.FS.Remove(WafRulesPath(id))
			return toData(contracts.WAFApplyResult{Available: d.wafAvailable(), Changed: false, NginxTest: "skipped"})
		}
		old, err := d.FS.ReadFile(inc)
		if err != nil {
			return nil, opErr(err)
		}
		if _, err := d.FS.Remove(inc); err != nil {
			return nil, opErr(err)
		}
		if err := d.nginxTest(ctx); err != nil {
			if _, rb := d.FS.WriteAtomic(inc, old, 0o644, platform.Owner{}); rb != nil {
				return nil, &registry.OpError{Code: "internal", Message: "nginx -t lỗi và hoàn tác thất bại: " + rb.Error()}
			}
			return nil, err
		}
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service"); err != nil {
			return nil, err
		}
		_, _ = d.FS.Remove(WafRulesPath(id))
		return toData(contracts.WAFApplyResult{Available: d.wafAvailable(), Changed: true, NginxTest: "ok"})
	}
	if err := d.mkdirs(WafDir); err != nil {
		return nil, err
	}
	if err := d.mkdirs("/var/log/itso/waf"); err != nil {
		return nil, err
	}
	rules := []byte(WafRules(id, string(p.Mode), p.ParanoiaLevel, p.RuleExclusions))
	oldRules, rerr := d.FS.ReadFile(WafRulesPath(id))
	if rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return nil, opErr(rerr)
	}
	incBody := []byte(WafInclude(id))
	oldInc, _ := d.FS.ReadFile(inc)
	if bytes.Equal(oldRules, rules) && bytes.Equal(oldInc, incBody) {
		return toData(contracts.WAFApplyResult{Available: true, Changed: false, NginxTest: "skipped"})
	}
	if _, err := d.FS.WriteAtomic(WafRulesPath(id), rules, 0o644, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	restoreRules := func() {
		if rerr == nil {
			_, _ = d.FS.WriteAtomic(WafRulesPath(id), oldRules, 0o644, platform.Owner{})
		} else {
			_, _ = d.FS.Remove(WafRulesPath(id))
		}
	}
	// applyNginxFile: ghi include → nginx -t (lỗi: hoàn tác include) → reload.
	changed, err := d.applyNginxFile(ctx, inc, incBody, true)
	if err != nil {
		restoreRules()
		return nil, err
	}
	if !changed { // include không đổi, chỉ rule đổi: vẫn cần kiểm và reload
		if err := d.nginxTest(ctx); err != nil {
			restoreRules()
			return nil, err
		}
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", "nginx.service"); err != nil {
			return nil, err
		}
	}
	return toData(contracts.WAFApplyResult{Available: true, Changed: true, NginxTest: "ok"})
}

// ---------- sự kiện ----------

type modsecAudit struct {
	Transaction struct {
		ClientIP  string `json:"client_ip"`
		TimeStamp string `json:"time_stamp"`
		Request   struct {
			Method  string            `json:"method"`
			URI     string            `json:"uri"`
			Headers map[string]string `json:"headers"`
		} `json:"request"`
		Response struct {
			HTTPCode int `json:"http_code"`
		} `json:"response"`
		Messages []struct {
			Message string `json:"message"`
			Details struct {
				RuleID   string `json:"ruleId"`
				Severity string `json:"severity"`
			} `json:"details"`
		} `json:"messages"`
	} `json:"transaction"`
}

func wafSeverity(s string) string {
	switch s {
	case "0", "1", "2":
		return "critical"
	case "3":
		return "high"
	case "4":
		return "medium"
	case "5":
		return "low"
	}
	return "info"
}

// isAnomalyRule: rule tổng hợp điểm của CRS (949xxx/959xxx/980xxx) — không mô tả tấn công cụ thể.
func isAnomalyRule(id int64) bool {
	return (id >= 949000 && id < 950000) || (id >= 959000 && id < 960000) || (id >= 980000 && id < 981000)
}

func cutRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }

// ParseWafLine chuẩn hóa một dòng audit log JSON thành sự kiện. hosts: Host → website uuid. ok=false nếu bỏ qua.
func ParseWafLine(line []byte, hosts map[string]string, loc *time.Location) (contracts.WAFEventsResultEventsItem, bool) {
	var a modsecAudit
	if err := json.Unmarshal(line, &a); err != nil || len(a.Transaction.Messages) == 0 {
		return contracts.WAFEventsResultEventsItem{}, false
	}
	t := a.Transaction
	host := ""
	for k, v := range t.Request.Headers {
		if strings.EqualFold(k, "host") {
			host = strings.ToLower(v)
		}
	}
	if h, _, err := splitHostPort(host); err == nil {
		host = h
	}
	site, ok := hosts[host]
	if !ok {
		return contracts.WAFEventsResultEventsItem{}, false
	}
	ip, err := netip.ParseAddr(t.ClientIP)
	if err != nil {
		return contracts.WAFEventsResultEventsItem{}, false
	}
	best, bestSev := -1, 99
	for i, m := range t.Messages {
		id, err := strconv.ParseInt(m.Details.RuleID, 10, 64)
		if err != nil || id < 1 || id > 99999999 || isAnomalyRule(id) {
			continue
		}
		sev, err := strconv.Atoi(m.Details.Severity)
		if err != nil {
			sev = 9
		}
		if sev < bestSev {
			best, bestSev = i, sev
		}
	}
	if best < 0 {
		return contracts.WAFEventsResultEventsItem{}, false
	}
	m := t.Messages[best]
	id, _ := strconv.ParseInt(m.Details.RuleID, 10, 64)
	at, err := time.ParseInLocation("Mon Jan _2 15:04:05 2006", t.TimeStamp, loc)
	if err != nil {
		return contracts.WAFEventsResultEventsItem{}, false
	}
	action := "detected"
	if t.Response.HTTPCode == 403 {
		action = "blocked"
	}
	method := t.Request.Method
	if len(method) > 16 {
		method = method[:16]
	}
	return contracts.WAFEventsResultEventsItem{WebsiteUUID: contracts.UUID(site), RuleID: contracts.WAFRuleID(id),
		Message: cutRunes(m.Message, 500), Severity: wafSeverity(m.Details.Severity), ClientIP: contracts.IPAddress(ip.String()),
		Method: method, URI: cutRunes(t.Request.URI, 2048), Action: action, At: at.Format(time.RFC3339)}, true
}

func splitHostPort(h string) (string, string, error) {
	if i := strings.LastIndexByte(h, ':'); i > 0 && !strings.Contains(h[:i], ":") {
		return h[:i], h[i+1:], nil
	}
	return h, "", errors.New("không có cổng")
}

// wafHosts đọc server_name của các vhost do agent sinh (dòng "# website <uuid>" + "server_name …;").
func (d *Deps) wafHosts() (map[string]string, error) {
	names, err := d.FS.ReadDir(VhostDir)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, opErr(err)
	}
	out := map[string]string{}
	for _, n := range names {
		if !strings.HasPrefix(n, "itso-") || !strings.HasSuffix(n, ".conf") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(n, "itso-"), ".conf")
		if !reUUID.MatchString(id) {
			continue
		}
		b, err := d.FS.ReadFile(VhostDir + "/" + n)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(bytes.NewReader(b))
		for sc.Scan() {
			l := strings.TrimSpace(sc.Text())
			if rest, ok := strings.CutPrefix(l, "server_name "); ok {
				for _, h := range strings.Fields(strings.TrimSuffix(rest, ";")) {
					out[h] = id
				}
			}
		}
	}
	return out, nil
}

func (d *Deps) wafEvents(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.WAFEventsParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if p.Limit < 1 || p.Limit > 1000 {
		return nil, fwInvalid("limit ngoài 1–1000")
	}
	var ino uint64
	var off int64
	if p.Cursor != nil {
		a, b, ok := strings.Cut(*p.Cursor, ":")
		i, err1 := strconv.ParseUint(a, 10, 64)
		o, err2 := strconv.ParseInt(b, 10, 64)
		if !ok || err1 != nil || err2 != nil || o < 0 {
			return nil, fwInvalid("cursor không hợp lệ")
		}
		ino, off = i, o
	}
	out := contracts.WAFEventsResult{Events: []contracts.WAFEventsResultEventsItem{}}
	_, curIno, size, err := d.FS.ReadChunk(WafAuditLog, 0, 0)
	if errors.Is(err, fs.ErrNotExist) {
		out.NextCursor = "0:0"
		return toData(out)
	}
	if err != nil {
		return nil, opErr(err)
	}
	if curIno != ino || off > size { // log đã xoay vòng/bị cắt: đọc lại từ đầu file hiện tại
		off = 0
	}
	hosts, err := d.wafHosts()
	if err != nil {
		return nil, err
	}
	chunk, _, _, err := d.FS.ReadChunk(WafAuditLog, off, wafMaxRead)
	if err != nil {
		return nil, opErr(err)
	}
	pos := off
	for len(chunk) > 0 && int64(len(out.Events)) < p.Limit {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			if len(chunk) == wafMaxRead { // một dòng quá dài: bỏ qua phần đã đọc
				pos += int64(len(chunk))
			}
			break // dòng chưa ghi xong: lần sau đọc tiếp
		}
		if ev, ok := ParseWafLine(chunk[:i], hosts, time.Local); ok {
			out.Events = append(out.Events, ev)
		}
		pos += int64(i + 1)
		chunk = chunk[i+1:]
	}
	out.NextCursor = fmt.Sprintf("%d:%d", curIno, pos)
	return toData(out)
}
