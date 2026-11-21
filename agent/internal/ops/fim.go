package ops

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// FIM + security.audit (D-80, ADR 0027). Danh sách đường dẫn CỐ ĐỊNH trong code; baseline nằm ở agent
// (/var/lib/itso/fim/baseline.json, root 0600) — panel không có op ghi baseline từ dữ liệu của nó.

const (
	FimBaseline  = "/var/lib/itso/fim/baseline.json"
	fimMaxFiles  = 20000
	fimMaxHashMB = 256
)

// FimWatched là gốc được theo dõi. Mục kết thúc bằng "*" là tiền tố tên trong thư mục cha.
var FimWatched = []string{
	"/etc/ssh", "/etc/nginx", "/etc/itso", "/etc/sudoers", "/etc/sudoers.d", "/etc/passwd", "/etc/group",
	"/etc/systemd/system/itso*", "/opt/itso/current/bin", "/opt/itso/current/share", "/usr/local/bin",
}

// FimIgnored: thư mục do chính agent thay đổi thường xuyên theo thao tác hợp lệ (chứng chỉ gia hạn, WAF, khóa
// SSH của account, vhost — vhost đã có kiểm drift riêng ở nginx.vhost.inspect).
var FimIgnored = []string{"/etc/itso/certs", "/etc/itso/waf", "/etc/itso/ssh", "/etc/ssh/itso_authorized_keys",
	"/etc/nginx/sites-enabled"}

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpFimBaseline:   d.fimBaseline,
			contracts.OpFimCheck:      d.fimCheck,
			contracts.OpSecurityAudit: d.securityAudit,
		}
	})
}

// FimEntry là dữ kiện của một đường dẫn.
type FimEntry struct {
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
	Owner  string `json:"owner"`
}

type fimBaseline struct {
	CreatedAt string              `json:"created_at"`
	Files     map[string]FimEntry `json:"files"`
}

func fimIgnored(p string) bool {
	for _, ig := range FimIgnored {
		if p == ig || strings.HasPrefix(p, ig+"/") {
			return true
		}
	}
	return false
}

func (d *Deps) fimEntry(p string, fi fs.FileInfo) (FimEntry, error) {
	e := FimEntry{Mode: uint32(fi.Mode().Perm()) | uint32(fi.Mode()&(fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky))}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		e.Owner = fmt.Sprintf("%d:%d", st.Uid, st.Gid)
	}
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		t, err := d.FS.Readlink(p)
		if err != nil {
			return e, err
		}
		s := sha256.Sum256([]byte("symlink:" + t))
		e.SHA256 = hex.EncodeToString(s[:])
	case fi.Mode().IsRegular():
		if fi.Size() > fimMaxHashMB<<20 {
			s := sha256.Sum256([]byte(fmt.Sprintf("large:%d:%d", fi.Size(), fi.ModTime().Unix())))
			e.SHA256 = hex.EncodeToString(s[:])
			break
		}
		b, err := d.FS.ReadFile(p)
		if err != nil {
			return e, err
		}
		s := sha256.Sum256(b)
		e.SHA256 = hex.EncodeToString(s[:])
	case fi.IsDir():
		e.SHA256 = "" // thư mục: chỉ theo dõi quyền/chủ
	default:
		s := sha256.Sum256([]byte("special:" + fi.Mode().Type().String()))
		e.SHA256 = hex.EncodeToString(s[:])
	}
	return e, nil
}

// fimScan đi qua danh sách cố định (không theo symlink) và trả dữ kiện từng đường dẫn.
func (d *Deps) fimScan() (map[string]FimEntry, error) {
	out := map[string]FimEntry{}
	var walk func(p string) error
	walk = func(p string) error {
		if fimIgnored(p) {
			return nil
		}
		if len(out) >= fimMaxFiles {
			return &registry.OpError{Code: "quota_exceeded", Message: fmt.Sprintf("FIM: quá %d đường dẫn", fimMaxFiles)}
		}
		fi, err := d.FS.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return opErr(err)
		}
		e, err := d.fimEntry(p, fi)
		if err != nil {
			return opErr(err)
		}
		out[p] = e
		if !fi.IsDir() {
			return nil
		}
		names, err := d.FS.ReadDir(p)
		if err != nil {
			return opErr(err)
		}
		for _, n := range names {
			if err := walk(p + "/" + n); err != nil {
				return err
			}
		}
		return nil
	}
	for _, w := range FimWatched {
		if prefix, ok := strings.CutSuffix(w, "*"); ok {
			dir, base := prefix[:strings.LastIndex(prefix, "/")], prefix[strings.LastIndex(prefix, "/")+1:]
			names, err := d.FS.ReadDir(dir)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, opErr(err)
			}
			for _, n := range names {
				if strings.HasPrefix(n, base) {
					if err := walk(dir + "/" + n); err != nil {
						return nil, err
					}
				}
			}
			continue
		}
		if err := walk(w); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (d *Deps) fimBaseline(_ context.Context, _ *envelope.Envelope) (map[string]any, error) {
	files, err := d.fimScan()
	if err != nil {
		return nil, err
	}
	b := fimBaseline{CreatedAt: d.now().UTC().Format(time.RFC3339), Files: files}
	raw, err := json.Marshal(b)
	if err != nil {
		return nil, err
	}
	if err := d.mkdirs("/var/lib/itso/fim"); err != nil {
		return nil, err
	}
	if _, err := d.FS.WriteAtomic(FimBaseline, raw, 0o600, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	sum := sha256.Sum256(raw)
	return toData(contracts.FimBaselineResult{Files: int64(len(files)), SHA256: contracts.SHA256(hex.EncodeToString(sum[:])), CreatedAt: b.CreatedAt})
}

func rawStr(s string) json.RawMessage {
	if s == "" {
		return json.RawMessage("null")
	}
	b, _ := json.Marshal(s)
	return b
}

func modeStr(m uint32) json.RawMessage { return rawStr(fmt.Sprintf("0%03o", m&0o777)) }

// FimDiff so sánh dữ kiện hiện tại với baseline. Thứ tự: theo đường dẫn.
func FimDiff(base, cur map[string]FimEntry) []contracts.FimCheckResultChangesItem {
	var out []contracts.FimCheckResultChangesItem
	keys := map[string]bool{}
	for k := range base {
		keys[k] = true
	}
	for k := range cur {
		keys[k] = true
	}
	paths := make([]string, 0, len(keys))
	for k := range keys {
		paths = append(paths, k)
	}
	sort.Strings(paths)
	for _, p := range paths {
		b, inB := base[p]
		c, inC := cur[p]
		item := contracts.FimCheckResultChangesItem{Path: contracts.AbsPath(p), OldSHA256: rawStr(b.SHA256), NewSHA256: rawStr(c.SHA256),
			Mode: json.RawMessage("null")}
		switch {
		case !inB:
			item.Change, item.OldSHA256, item.Mode = "added", json.RawMessage("null"), modeStr(c.Mode)
			o := c.Owner
			item.Owner = &o
		case !inC:
			item.Change, item.NewSHA256 = "removed", json.RawMessage("null")
		case b.SHA256 != c.SHA256:
			item.Change, item.Mode = "modified", modeStr(c.Mode)
			o := c.Owner
			item.Owner = &o
		case b.Mode != c.Mode || b.Owner != c.Owner:
			item.Change, item.Mode = "metadata", modeStr(c.Mode)
			o := c.Owner
			item.Owner = &o
		default:
			continue
		}
		out = append(out, item)
		if len(out) >= 5000 {
			break
		}
	}
	return out
}

func (d *Deps) loadFimBaseline() (*fimBaseline, error) {
	var b fimBaseline
	found, err := d.safeReadJSON(FimBaseline, &b)
	if err != nil || !found {
		return nil, err
	}
	return &b, nil
}

func (d *Deps) fimCheckResult() (contracts.FimCheckResult, error) {
	out := contracts.FimCheckResult{Changes: []contracts.FimCheckResultChangesItem{}}
	cur, err := d.fimScan()
	if err != nil {
		return out, err
	}
	out.Checked = int64(len(cur))
	b, err := d.loadFimBaseline()
	if err != nil {
		return out, err
	}
	if b == nil {
		return out, nil // chưa có baseline: không có gì để so
	}
	at := b.CreatedAt
	out.BaselineAt = &at
	if c := FimDiff(b.Files, cur); c != nil {
		out.Changes = c
	}
	return out, nil
}

func (d *Deps) fimCheck(_ context.Context, _ *envelope.Envelope) (map[string]any, error) {
	out, err := d.fimCheckResult()
	if err != nil {
		return nil, err
	}
	return toData(out)
}

// ---------- security.audit ----------

// ParseSshdT đọc `sshd -T` (khóa chữ thường, cách giá trị bằng dấu cách).
func ParseSshdT(out string) contracts.SecurityAuditResultSshd {
	r := contracts.SecurityAuditResultSshd{Port: 22, PermitRootLogin: "unknown", PasswordAuthentication: true}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, _ := strings.Cut(strings.TrimSpace(sc.Text()), " ")
		switch k {
		case "port":
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
				r.Port = contracts.Port(n)
			}
		case "permitrootlogin":
			if len(v) <= 32 {
				r.PermitRootLogin = v
			}
		case "passwordauthentication":
			r.PasswordAuthentication = v == "yes"
		case "maxauthtries":
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				r.MaxAuthTries = int64(n)
			}
		}
	}
	return r
}

// countSecurityUpgrades đếm gói từ kho -security trong `apt-get -s dist-upgrade` (chỉ mô phỏng, không đổi hệ thống).
func countSecurityUpgrades(out string) int64 {
	var n int64
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "Inst ") && strings.Contains(l, "-security") {
			n++
		}
	}
	return n
}

func (d *Deps) securityAudit(ctx context.Context, _ *envelope.Envelope) (map[string]any, error) {
	var out contracts.SecurityAuditResult
	res, err := d.run(ctx, "sshd", "-T")
	if err != nil {
		return nil, err
	}
	out.Sshd = ParseSshdT(string(res.Stdout))

	tbl, present, err := d.currentTable(ctx)
	if err != nil {
		return nil, err
	}
	out.Firewall = contracts.SecurityAuditResultFirewall{TablePresent: present, InputPolicy: "accept"}
	if present {
		if strings.Contains(tbl, "hook input priority filter; policy drop;") || strings.Contains(tbl, "hook input priority 0; policy drop;") {
			out.Firewall.InputPolicy = "drop"
		}
		for _, l := range strings.Split(tbl, "\n") {
			l = strings.TrimSpace(l)
			if strings.HasSuffix(l, " accept") || strings.HasSuffix(l, " drop") || strings.HasSuffix(l, " reject") ||
				strings.Contains(l, " comment \"") {
				out.Firewall.Rules++
			}
		}
	}

	f2b, err := d.run(ctx, "fail2ban-client", "status")
	if err != nil {
		return nil, err
	}
	if f2b.ExitCode == 0 {
		out.Fail2ban = contracts.SecurityAuditResultFail2ban{Running: true, Jails: int64(len(parseJailList(string(f2b.Stdout))))}
	}

	auto, _ := d.FS.ReadFile("/etc/apt/apt.conf.d/20auto-upgrades")
	out.Updates.UnattendedUpgrades = bytes.Contains(auto, []byte(`APT::Periodic::Unattended-Upgrade "1"`))
	out.Updates.RebootRequired = d.FS.Exists("/run/reboot-required") || d.FS.Exists("/var/run/reboot-required")
	if sim, err := d.run(ctx, "apt-get", "-s", "-q", "dist-upgrade"); err == nil && sim.ExitCode == 0 {
		out.Updates.PendingSecurity = countSecurityUpgrades(string(sim.Stdout))
	}

	has := func(pkg string) (bool, error) {
		v, err := d.pkgVersion(ctx, pkg)
		return v != nil, err
	}
	for _, x := range []struct {
		pkg string
		dst *bool
	}{{"libnginx-mod-http-modsecurity", &out.Packages.Modsecurity}, {"modsecurity-crs", &out.Packages.Crs},
		{"clamav-daemon", &out.Packages.Clamav}, {"yara", &out.Packages.Yara}} {
		ok, err := has(x.pkg)
		if err != nil {
			return nil, err
		}
		*x.dst = ok
	}

	fim, err := d.fimCheckResult()
	if err != nil {
		return nil, err
	}
	out.Fim = contracts.SecurityAuditResultFim{BaselinePresent: fim.BaselineAt != nil, Changes: int64(len(fim.Changes))}
	return toData(out)
}
