package ops

import (
	"bytes"
	"context"
	"fmt"
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

// Fail2ban (D-77, ADR 0024): jail.d/itso.conf từ template với 3 jail cố định, banaction nftables.

const (
	Fail2banJailConf    = "/etc/fail2ban/jail.d/itso.conf"
	Fail2banPanelFilter = "/etc/fail2ban/filter.d/itso-panel.conf"
	PanelAuthLog        = "/var/log/itso/auth.log"
)

// jailDefs: log/filter/cổng của từng jail cố định (thứ tự hiển thị).
var jailDefs = []struct{ name, filter, logpath, port string }{
	{"sshd", "sshd", "", "ssh"},
	{"itso-panel", "itso-panel", PanelAuthLog, "http,https,8443"},
	{"pure-ftpd", "pure-ftpd", "", "ftp,ftp-data,ftps,ftps-data"},
}

// PanelFilterConf: Laravel ghi một dòng cho mỗi lần đăng nhập sai: "<ISO8601> itso-auth failed ip=<IP>".
const PanelFilterConf = "# Sinh bởi itso-agent (fail2ban.apply). Không sửa tay.\n[Definition]\n" +
	"failregex = ^\\S+ itso-auth failed ip=<HOST>$\nignoreregex =\ndatepattern = ^%%Y-%%m-%%dT%%H:%%M:%%S\n"

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpFail2banApply:  d.fail2banApply,
			contracts.OpFail2banStatus: d.fail2banStatus,
			contracts.OpFail2banUnban:  d.fail2banUnban,
		}
	})
}

func validJail(name string) bool {
	for _, j := range jailDefs {
		if j.name == name {
			return true
		}
	}
	return false
}

// Fail2banConf sinh jail.d/itso.conf. Jail không có trong tham số → tắt.
func Fail2banConf(p contracts.Fail2banApplyParams) (string, int64, error) {
	if len(p.Jails) > len(jailDefs) || len(p.Ignoreip) > 100 {
		return "", 0, fwInvalid("quá nhiều jail hoặc ignoreip")
	}
	byName := map[string]contracts.Fail2banApplyParamsJailsItem{}
	for _, j := range p.Jails {
		n := string(j.Name)
		if !validJail(n) {
			return "", 0, fwInvalid("jail %q ngoài allowlist", n)
		}
		if _, dup := byName[n]; dup {
			return "", 0, fwInvalid("jail %q trùng", n)
		}
		if j.BantimeSec < 60 || j.BantimeSec > 2592000 || j.FindtimeSec < 60 || j.FindtimeSec > 86400 ||
			j.Maxretry < 1 || j.Maxretry > 100 {
			return "", 0, fwInvalid("jail %q: tham số ngoài miền", n)
		}
		byName[n] = j
	}
	ignore := []string{"127.0.0.1/8", "::1"}
	for _, c := range p.Ignoreip {
		pr, err := ParseSource(string(c))
		if err != nil {
			return "", 0, fwInvalid("ignoreip: %s", err.(*registry.OpError).Message)
		}
		ignore = append(ignore, pr.String())
	}
	var b strings.Builder
	b.WriteString("# Sinh bởi itso-agent (fail2ban.apply). Không sửa tay.\n[DEFAULT]\n")
	b.WriteString("banaction = nftables-multiport\nbanaction_allports = nftables-allports\n")
	fmt.Fprintf(&b, "ignoreip = %s\n", strings.Join(ignore, " "))
	var active int64
	for _, def := range jailDefs {
		j, has := byName[def.name]
		on := has && j.Enabled && p.Enabled
		fmt.Fprintf(&b, "\n[%s]\nenabled = %t\n", def.name, on)
		if !has {
			continue
		}
		if on {
			active++
		}
		fmt.Fprintf(&b, "filter = %s\nport = %s\n", def.filter, def.port)
		if def.logpath != "" {
			fmt.Fprintf(&b, "logpath = %s\nbackend = auto\n", def.logpath)
		} else {
			b.WriteString("backend = systemd\n")
		}
		fmt.Fprintf(&b, "bantime = %d\nfindtime = %d\nmaxretry = %d\n", j.BantimeSec, j.FindtimeSec, j.Maxretry)
	}
	return b.String(), active, nil
}

func (d *Deps) fail2banApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.Fail2banApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	conf, active, err := Fail2banConf(p)
	if err != nil {
		return nil, err
	}
	changed := false
	for _, f := range []struct{ path, body string }{{Fail2banPanelFilter, PanelFilterConf}, {Fail2banJailConf, conf}} {
		old, _ := d.FS.ReadFile(f.path)
		if bytes.Equal(old, []byte(f.body)) {
			continue
		}
		if err := d.mkdirs(f.path[:strings.LastIndex(f.path, "/")]); err != nil {
			return nil, err
		}
		if _, err := d.FS.WriteAtomic(f.path, []byte(f.body), 0o644, platform.Owner{}); err != nil {
			return nil, opErr(err)
		}
		changed = true
	}
	if !changed {
		return toData(contracts.Fail2banApplyResult{Changed: false, Reloaded: false, JailsActive: active})
	}
	if _, err := d.must(ctx, "config_test_failed", "fail2ban-client", "-t"); err != nil {
		return nil, err
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload-or-restart", "fail2ban.service"); err != nil {
		return nil, err
	}
	return toData(contracts.Fail2banApplyResult{Changed: true, Reloaded: true, JailsActive: active})
}

// ParseBanList đọc `fail2ban-client get <jail> banip --with-time`:
// "203.0.113.45 \t2026-11-20 08:15:00 + 3600 = 2026-11-20 09:15:00". Dòng lạ bị bỏ qua.
func ParseBanList(out string, loc *time.Location) []contracts.Fail2banStatusResultJailsItemBannedItem {
	var res []contracts.Fail2banStatusResultJailsItemBannedItem
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		ip, err := netip.ParseAddr(f[0])
		if err != nil {
			continue
		}
		at, err := time.ParseInLocation("2006-01-02 15:04:05", f[1]+" "+f[2], loc)
		if err != nil {
			continue
		}
		item := contracts.Fail2banStatusResultJailsItemBannedItem{IP: contracts.IPAddress(ip.String()), BannedAt: at.Format(time.RFC3339)}
		if len(f) >= 8 && f[3] == "+" && f[5] == "=" {
			if until, err := time.ParseInLocation("2006-01-02 15:04:05", f[6]+" "+f[7], loc); err == nil && f[4] != "-1" {
				s := until.Format(time.RFC3339)
				item.ExpiresAt = &s
			}
		}
		res = append(res, item)
		if len(res) >= 1000 {
			break
		}
	}
	sort.SliceStable(res, func(a, b int) bool { return res[a].BannedAt > res[b].BannedAt })
	return res
}

// parseJailList đọc dòng "`- Jail list:\tsshd, itso-panel" của `fail2ban-client status`.
func parseJailList(out string) map[string]bool {
	m := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		if _, rest, ok := strings.Cut(line, "Jail list:"); ok {
			for _, j := range strings.Split(rest, ",") {
				if j = strings.TrimSpace(j); j != "" {
					m[j] = true
				}
			}
		}
	}
	return m
}

func parseTotalBanned(out string) int64 {
	for _, line := range strings.Split(out, "\n") {
		if _, rest, ok := strings.Cut(line, "Total banned:"); ok {
			n, _ := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			return n
		}
	}
	return 0
}

func (d *Deps) fail2banStatus(ctx context.Context, _ *envelope.Envelope) (map[string]any, error) {
	out := contracts.Fail2banStatusResult{Jails: []contracts.Fail2banStatusResultJailsItem{}}
	res, err := d.run(ctx, "fail2ban-client", "status")
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return toData(out) // dịch vụ không chạy
	}
	out.Running = true
	enabled := parseJailList(string(res.Stdout))
	for _, def := range jailDefs {
		item := contracts.Fail2banStatusResultJailsItem{Name: contracts.Fail2banJail(def.name), Enabled: enabled[def.name],
			Banned: []contracts.Fail2banStatusResultJailsItemBannedItem{}}
		if item.Enabled {
			st, err := d.run(ctx, "fail2ban-client", "status", def.name)
			if err != nil {
				return nil, err
			}
			item.TotalBanned = parseTotalBanned(string(st.Stdout))
			bl, err := d.run(ctx, "fail2ban-client", "get", def.name, "banip", "--with-time")
			if err != nil {
				return nil, err
			}
			if b := ParseBanList(string(bl.Stdout), time.Local); b != nil {
				item.Banned = b
			}
		}
		out.Jails = append(out.Jails, item)
	}
	return toData(out)
}

func (d *Deps) fail2banUnban(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.Fail2banUnbanParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !validJail(string(p.Jail)) {
		return nil, fwInvalid("jail %q ngoài allowlist", p.Jail)
	}
	ip, err := netip.ParseAddr(string(p.IP))
	if err != nil || ip.Zone() != "" {
		return nil, fwInvalid("ip %q không hợp lệ", p.IP)
	}
	res, err := d.must(ctx, "dependency_unavailable", "fail2ban-client", "set", string(p.Jail), "unbanip", ip.String())
	if err != nil {
		return nil, err
	}
	return toData(contracts.Fail2banUnbanResult{Unbanned: strings.TrimSpace(string(res.Stdout)) != "0"})
}
