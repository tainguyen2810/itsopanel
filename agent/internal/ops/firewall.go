package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Tường lửa nftables (D-76, ADR 0023): panel chỉ quản lý `table inet itso`, không flush bảng khác
// (Docker, fail2ban). Ruleset sinh từ tham số kiểu hóa; bất biến chống tự khóa kiểm lại ở agent.

const (
	FirewallDir    = "/var/lib/itso/firewall"
	FirewallTable  = "itso"
	maxRuleComment = 200
)

var (
	reApplyID   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reUUID      = reApplyID
	reFwComment = regexp.MustCompile(`^[^\x00-\x1f\x7f"\\]*$`)

	firewallKind = safeKind{name: "firewall", dir: FirewallDir, unit: "itso-fw-rollback", restore: restoreFirewall}
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpFirewallApply:   d.firewallApply,
			contracts.OpFirewallConfirm: d.firewallConfirm,
			contracts.OpFirewallStatus:  d.firewallStatus,
		}
	})
}

// PortRange là một khoảng cổng [Lo, Hi].
type PortRange struct{ Lo, Hi uint16 }

// FwRule là rule đã chuẩn hóa.
type FwRule struct {
	Priority  int64
	Action    string      // accept|drop|reject
	Direction string      // in|out
	Protocol  string      // tcp|udp|icmp|any
	Ports     []PortRange // rỗng = mọi cổng
	Source    netip.Prefix
	AnySource bool // 0.0.0.0/0 hoặc ::/0
	Comment   string
}

// AntiLockout là dữ kiện chống tự khóa: cổng SSH, cổng panel và IP của người đang áp dụng.
type AntiLockout struct {
	SSHPort, PanelPort uint16
	ClientIP           netip.Addr
}

func fwInvalid(f string, a ...any) error {
	return &registry.OpError{Code: "invalid_params", Message: fmt.Sprintf(f, a...)}
}

// ParsePorts đọc "80,443,1000-2000" (đã qua pattern schema) và kiểm 1–65535, lo ≤ hi, tối đa 50 phần.
func ParsePorts(s string) ([]PortRange, error) {
	if s == "" {
		return nil, fwInvalid("ports rỗng")
	}
	parts := strings.Split(s, ",")
	if len(parts) > 50 {
		return nil, fwInvalid("ports: quá 50 phần")
	}
	out := make([]PortRange, 0, len(parts))
	for _, p := range parts {
		lo, hi, isRange := strings.Cut(p, "-")
		a, err1 := strconv.ParseUint(lo, 10, 32)
		b := a
		var err2 error
		if isRange {
			b, err2 = strconv.ParseUint(hi, 10, 32)
		}
		if err1 != nil || err2 != nil || a < 1 || b > 65535 || a > b {
			return nil, fwInvalid("ports: %q ngoài 1–65535 hoặc sai thứ tự", p)
		}
		out = append(out, PortRange{uint16(a), uint16(b)})
	}
	return out, nil
}

// ParseSource đọc CIDR/IP nguồn bằng net/netip: octet > 255, prefix sai, có bit host → từ chối.
func ParseSource(s string) (netip.Prefix, error) {
	if !strings.Contains(s, "/") {
		a, err := netip.ParseAddr(s)
		if err != nil || a.Zone() != "" {
			return netip.Prefix{}, fwInvalid("source: %q không phải IP/CIDR hợp lệ", s)
		}
		return netip.PrefixFrom(a, a.BitLen()), nil
	}
	p, err := netip.ParsePrefix(s)
	if err != nil {
		return netip.Prefix{}, fwInvalid("source: %q không phải CIDR hợp lệ", s)
	}
	if p.Masked() != p {
		return netip.Prefix{}, fwInvalid("source: %q có bit host (dùng %s)", s, p.Masked())
	}
	return p, nil
}

func (r FwRule) coversPort(port uint16) bool {
	if r.Protocol == "icmp" {
		return false
	}
	if len(r.Ports) == 0 {
		return true
	}
	for _, pr := range r.Ports {
		if pr.Lo <= port && port <= pr.Hi {
			return true
		}
	}
	return false
}

func (r FwRule) matchesAddr(a netip.Addr) bool {
	if r.AnySource {
		return true
	}
	return r.Source.Contains(a.Unmap())
}

// NormalizeFirewall kiểm lại toàn bộ rule (không tin panel) và bất biến chống tự khóa.
func NormalizeFirewall(rules []contracts.FirewallRule, al AntiLockout) ([]FwRule, error) {
	if len(rules) > 500 {
		return nil, fwInvalid("quá 500 rule")
	}
	if al.SSHPort == 0 || al.PanelPort == 0 || !al.ClientIP.IsValid() {
		return nil, fwInvalid("anti_lockout thiếu cổng SSH/panel hoặc IP người áp dụng")
	}
	out := make([]FwRule, 0, len(rules))
	for i, in := range rules {
		r := FwRule{Priority: in.Priority, Action: in.Action, Direction: in.Direction, Protocol: in.Protocol, Comment: in.Comment}
		if r.Priority < 1 || r.Priority > 9999 {
			return nil, fwInvalid("rule %d: priority ngoài 1–9999", i)
		}
		switch r.Action {
		case "accept", "drop", "reject":
		default:
			return nil, fwInvalid("rule %d: action %q không hợp lệ", i, r.Action)
		}
		if r.Direction != "in" && r.Direction != "out" {
			return nil, fwInvalid("rule %d: direction %q không hợp lệ", i, r.Direction)
		}
		switch r.Protocol {
		case "tcp", "udp", "any", "icmp":
		default:
			return nil, fwInvalid("rule %d: protocol %q không hợp lệ", i, r.Protocol)
		}
		if len(r.Comment) > maxRuleComment || !reFwComment.MatchString(r.Comment) {
			return nil, fwInvalid("rule %d: comment chứa ký tự cấm", i)
		}
		if in.Ports != nil {
			if r.Protocol == "icmp" {
				return nil, fwInvalid("rule %d: icmp không có cổng", i)
			}
			p, err := ParsePorts(*in.Ports)
			if err != nil {
				return nil, fwInvalid("rule %d: %s", i, err.(*registry.OpError).Message)
			}
			r.Ports = p
		}
		src, err := ParseSource(string(in.Source))
		if err != nil {
			return nil, fwInvalid("rule %d: %s", i, err.(*registry.OpError).Message)
		}
		r.Source, r.AnySource = src, src.Bits() == 0
		if r.Direction == "in" && r.Action != "accept" && r.matchesAddr(al.ClientIP) &&
			(r.coversPort(al.SSHPort) || r.coversPort(al.PanelPort)) {
			return nil, &registry.OpError{Code: "would_lock_out", Message: fmt.Sprintf(
				"rule %d chặn cổng SSH %d/panel %d từ IP đang áp dụng %s", i, al.SSHPort, al.PanelPort, al.ClientIP)}
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Priority < out[b].Priority })
	return out, nil
}

func (r FwRule) render() string {
	var b strings.Builder
	b.WriteString("    ")
	if !r.AnySource {
		fam := "ip"
		if r.Source.Addr().Is6() {
			fam = "ip6"
		}
		if r.Direction == "in" {
			fmt.Fprintf(&b, "%s saddr %s ", fam, r.Source)
		} else {
			fmt.Fprintf(&b, "%s daddr %s ", fam, r.Source)
		}
	}
	ports := ""
	if len(r.Ports) > 0 {
		ps := make([]string, len(r.Ports))
		for i, p := range r.Ports {
			if p.Lo == p.Hi {
				ps[i] = strconv.Itoa(int(p.Lo))
			} else {
				ps[i] = fmt.Sprintf("%d-%d", p.Lo, p.Hi)
			}
		}
		ports = ps[0]
		if len(ps) > 1 {
			ports = "{ " + strings.Join(ps, ", ") + " }"
		}
	}
	switch {
	case r.Protocol == "icmp":
		b.WriteString("meta l4proto { icmp, ipv6-icmp } ")
	case ports != "" && r.Protocol == "any":
		b.WriteString("meta l4proto { tcp, udp } th dport " + ports + " ")
	case ports != "":
		b.WriteString(r.Protocol + " dport " + ports + " ")
	case r.Protocol != "any":
		b.WriteString("meta l4proto " + r.Protocol + " ")
	}
	b.WriteString(r.Action)
	if r.Comment != "" {
		fmt.Fprintf(&b, " comment %q", r.Comment)
	}
	b.WriteString("\n")
	return b.String()
}

// RenderNft sinh script nft thay thế nguyên tử bảng `inet itso`. Luôn có: loopback, established/related,
// ICMP giới hạn, cổng SSH và panel cho IP người áp dụng (đứng trước rule người dùng). Nếu không rule nào
// nhắc tới cổng SSH/panel thì mở cho mọi nguồn (máy mới cài không tự khóa).
func RenderNft(rules []FwRule, al AntiLockout) string {
	var in, out strings.Builder
	mentions := func(port uint16) bool {
		for _, r := range rules {
			if r.Direction == "in" && len(r.Ports) > 0 && r.coversPort(port) {
				return true
			}
		}
		return false
	}
	for _, r := range rules {
		if r.Direction == "in" {
			in.WriteString(r.render())
		} else {
			out.WriteString(r.render())
		}
	}
	fam := "ip"
	if al.ClientIP.Unmap().Is6() {
		fam = "ip6"
	}
	client := al.ClientIP.Unmap().String()
	var b strings.Builder
	b.WriteString("# Sinh bởi itso-agent (firewall.apply). Không sửa tay.\n")
	b.WriteString("table inet " + FirewallTable + "\ndelete table inet " + FirewallTable + "\n")
	b.WriteString("table inet " + FirewallTable + " {\n  chain input {\n    type filter hook input priority filter; policy drop;\n")
	b.WriteString("    iif \"lo\" accept\n    ct state established,related accept\n    ct state invalid drop\n")
	b.WriteString("    meta l4proto icmp icmp type { echo-request, destination-unreachable, time-exceeded } limit rate 10/second accept\n")
	b.WriteString("    meta l4proto ipv6-icmp accept\n")
	guard := fmt.Sprintf("{ %d, %d }", al.SSHPort, al.PanelPort)
	if al.SSHPort == al.PanelPort {
		guard = strconv.Itoa(int(al.SSHPort))
	}
	fmt.Fprintf(&b, "    %s saddr %s tcp dport %s accept comment \"itso: chống tự khóa\"\n", fam, client, guard)
	for _, p := range []struct {
		port uint16
		name string
	}{{al.SSHPort, "ssh"}, {al.PanelPort, "panel"}} {
		if !mentions(p.port) && (p.name == "ssh" || al.PanelPort != al.SSHPort) {
			fmt.Fprintf(&b, "    tcp dport %d accept comment \"itso: %s\"\n", p.port, p.name)
		}
	}
	b.WriteString(in.String())
	b.WriteString("  }\n  chain output {\n    type filter hook output priority filter; policy accept;\n")
	b.WriteString(out.String())
	b.WriteString("  }\n}\n")
	return b.String()
}

func antiLockout(p contracts.FirewallApplyParamsAntiLockout) (AntiLockout, error) {
	ip, err := netip.ParseAddr(string(p.ClientIP))
	if err != nil || ip.Zone() != "" {
		return AntiLockout{}, fwInvalid("anti_lockout.client_ip %q không hợp lệ", p.ClientIP)
	}
	if p.SSHPort < 1 || p.SSHPort > 65535 || p.PanelPort < 1 || p.PanelPort > 65535 {
		return AntiLockout{}, fwInvalid("anti_lockout: cổng ngoài 1–65535")
	}
	return AntiLockout{SSHPort: uint16(p.SSHPort), PanelPort: uint16(p.PanelPort), ClientIP: ip.Unmap()}, nil
}

const emptyTableScript = "table inet " + FirewallTable + "\ndelete table inet " + FirewallTable + "\n"

func (d *Deps) nftFile(ctx context.Context, path string, check bool) error {
	real, err := d.FS.Path(path)
	if err != nil {
		return opErr(err)
	}
	args := []string{"-f", real}
	if check {
		args = []string{"-c", "-f", real}
	}
	_, err = d.must(ctx, "config_test_failed", "nft", args...)
	return err
}

// currentTable trả ruleset hiện tại của bảng itso (dạng script thay thế); bảng chưa có → chỉ xóa.
func (d *Deps) currentTable(ctx context.Context) (string, bool, error) {
	res, err := d.run(ctx, "nft", "list", "table", "inet", FirewallTable)
	if err != nil {
		return "", false, err
	}
	if res.ExitCode != 0 || len(res.Stdout) == 0 {
		return emptyTableScript, false, nil
	}
	return emptyTableScript + string(res.Stdout), true, nil
}

func restoreFirewall(ctx context.Context, d *Deps, k safeKind, applyID string) error {
	if d.FS.Exists(k.prevPath(applyID)) {
		return d.nftFile(ctx, k.prevPath(applyID), false)
	}
	return &registry.OpError{Code: "internal", Message: "thiếu ruleset cũ để hoàn tác " + applyID}
}

func (d *Deps) firewallApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FirewallApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	id := string(p.ApplyID)
	if !reApplyID.MatchString(id) {
		return nil, fwInvalid("apply_id không hợp lệ")
	}
	if p.ConfirmWithinSec < 30 || p.ConfirmWithinSec > 600 {
		return nil, fwInvalid("confirm_within_sec ngoài 30–600")
	}
	al, err := antiLockout(p.AntiLockout)
	if err != nil {
		return nil, err
	}
	rules, err := NormalizeFirewall(p.Rules, al)
	if err != nil {
		return nil, err
	}
	script := RenderNft(rules, al)
	sum := sha256.Sum256([]byte(script))
	safeMu.Lock()
	defer safeMu.Unlock()
	if err := d.safeBegin(ctx, firewallKind); err != nil {
		return nil, err
	}
	prev, _, err := d.currentTable(ctx)
	if err != nil {
		return nil, err
	}
	next := FirewallDir + "/" + id + ".nft"
	if _, err := d.FS.WriteAtomic(next, []byte(script), 0o600, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	defer func() { _, _ = d.FS.Remove(next) }()
	if err := d.nftFile(ctx, next, true); err != nil {
		return nil, err
	}
	if _, err := d.FS.WriteAtomic(firewallKind.prevPath(id), []byte(prev), 0o600, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	// Ghi lần chờ TRƯỚC khi áp dụng: agent chết ngay sau `nft -f` thì lúc khởi động vẫn hoàn tác được.
	if err := d.safeWriteJSON(firewallKind.pendingPath(), safePending{ApplyID: id, RollbackAt: d.now().UTC().
		Add(time.Duration(p.ConfirmWithinSec) * time.Second).Format(time.RFC3339)}); err != nil {
		return nil, err
	}
	if err := d.nftFile(ctx, next, false); err != nil {
		_, _ = d.FS.Remove(firewallKind.pendingPath())
		_ = d.nftFile(ctx, firewallKind.prevPath(id), false)
		return nil, err
	}
	token, at, err := d.safeArm(ctx, firewallKind, id, p.ConfirmWithinSec)
	if err != nil {
		return nil, err
	}
	if err := d.safeWriteJSON(firewallKind.statePath(), safeState{State: "pending_confirm", ApplyID: id,
		At: d.now().UTC().Format(time.RFC3339), SHA256: hex.EncodeToString(sum[:]), Rules: int64(len(rules))}); err != nil {
		return nil, err
	}
	return toData(contracts.FirewallApplyResult{Token: contracts.ConfirmToken(token), RollbackAt: at.Format(time.RFC3339),
		RulesetSHA256: contracts.SHA256(hex.EncodeToString(sum[:])), RulesActive: int64(len(rules)), Changed: prev != script})
}

func (d *Deps) firewallConfirm(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FirewallConfirmParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !reApplyID.MatchString(string(p.ApplyID)) {
		return nil, fwInvalid("apply_id không hợp lệ")
	}
	ok, rb, err := d.safeConfirm(ctx, firewallKind, string(p.ApplyID), string(p.Token))
	if err != nil {
		return nil, err
	}
	return toData(contracts.FirewallConfirmResult{Confirmed: ok, RolledBack: rb})
}

func rawOrNull(s string) json.RawMessage {
	if s == "" {
		return json.RawMessage("null")
	}
	b, _ := json.Marshal(s)
	return b
}

func (d *Deps) firewallStatus(ctx context.Context, _ *envelope.Envelope) (map[string]any, error) {
	safeMu.Lock()
	defer safeMu.Unlock()
	if err := d.safeExpire(ctx, firewallKind); err != nil {
		return nil, err
	}
	st, err := d.safeState(firewallKind)
	if err != nil {
		return nil, err
	}
	p, err := d.safePending(firewallKind)
	if err != nil {
		return nil, err
	}
	_, present, err := d.currentTable(ctx)
	if err != nil {
		return nil, err
	}
	out := contracts.FirewallStatusResult{State: st.State, ApplyID: rawOrNull(st.ApplyID), RulesetSHA256: rawOrNull(st.SHA256),
		RulesActive: st.Rules, TablePresent: present}
	if p != nil {
		at := p.RollbackAt
		out.RollbackAt = &at
	}
	if st.State == "rolled_back" {
		out.RulesetSHA256, out.RulesActive = rawOrNull(""), 0
	}
	return toData(out)
}
