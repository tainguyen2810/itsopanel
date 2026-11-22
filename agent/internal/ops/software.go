package ops

import (
	"bytes"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// Software Manager (D-100, ADR 0045): catalog trong agent là nguồn sự thật; panel seed bảng software_catalog từ
// software.catalog. Gói lấy từ validate.Recipes (allowlist); ở đây là siêu dữ liệu: nhóm, kho, dịch vụ, xung đột,
// phụ thuộc, thành phần lõi.

type recipeMeta struct {
	Name, Category, Source, Service string
	Core                            bool
	Conflicts, Requires             []string
}

var catalog = map[string]recipeMeta{
	"acl":         {Name: "ACL (setfacl/getfacl)", Category: "base", Source: "ubuntu", Core: true},
	"quota":       {Name: "Disk quota", Category: "base", Source: "ubuntu", Core: true},
	"nftables":    {Name: "nftables", Category: "security", Source: "ubuntu", Core: true},
	"restic":      {Name: "restic", Category: "base", Source: "ubuntu", Core: true},
	"stress-ng":   {Name: "stress-ng", Category: "tools", Source: "ubuntu"},
	"nginx":       {Name: "Nginx", Category: "web", Source: "ubuntu", Service: "nginx", Core: true},
	"php8.3":      {Name: "PHP 8.3 (FPM)", Category: "php", Source: "ubuntu", Core: true},
	"lego":        {Name: "lego (ACME)", Category: "web", Source: "ubuntu"},
	"fail2ban":    {Name: "Fail2ban", Category: "security", Source: "ubuntu", Service: "fail2ban", Core: true},
	"clamav":      {Name: "ClamAV", Category: "security", Source: "ubuntu", Service: "clamav-daemon"},
	"yara":        {Name: "YARA", Category: "security", Source: "ubuntu"},
	"modsecurity": {Name: "ModSecurity + CRS", Category: "security", Source: "ubuntu"},
	"php8.1":      {Name: "PHP 8.1 (FPM)", Category: "php", Source: "ppa-ondrej-php"},
	"php8.2":      {Name: "PHP 8.2 (FPM)", Category: "php", Source: "ppa-ondrej-php"},
	"php8.4":      {Name: "PHP 8.4 (FPM)", Category: "php", Source: "ppa-ondrej-php"},
	"redis":       {Name: "Redis", Category: "cache", Source: "ubuntu", Service: "redis-server", Conflicts: []string{"valkey"}},
	"valkey":      {Name: "Valkey", Category: "cache", Source: "ubuntu", Service: "valkey-server", Conflicts: []string{"redis"}},
	"memcached":   {Name: "Memcached", Category: "cache", Source: "ubuntu", Service: "memcached"},
	"nodejs":      {Name: "Node.js (runtime)", Category: "runtime", Source: "ubuntu"},
	"composer":    {Name: "Composer", Category: "tools", Source: "ubuntu", Requires: []string{"php8.3"}},
	"wp-cli":      {Name: "WP-CLI", Category: "tools", Source: "itso", Requires: []string{"php8.3"}},
	"docker":      {Name: "Docker Engine + Compose", Category: "docker", Source: "ubuntu", Service: "docker"},
}

// WP-CLI ghim (ADR 0044): tải từ bản phát hành GitHub, kiểm sha512 trước khi đặt vào /usr/local/lib/itso.
const (
	WPCLIVersion = "2.11.0"
	wpcliURL     = "https://github.com/wp-cli/wp-cli/releases/download/v" + WPCLIVersion + "/wp-cli-" + WPCLIVersion + ".phar"
	wpcliSHA512  = "adb12146bab8d829621efed41124dcd0012f9027f47e0228be7080296167566070e4a026a09c3989907840b21de94b7a35f3bfbd5f827c12f27c5803546d1bba"
	// WPCLIPath là phar mà các op wp.* gọi bằng php<phiên bản> (không có `wp` trên PATH).
	WPCLIPath = "/usr/local/lib/itso/wp-cli-" + WPCLIVersion + ".phar"
	wpcliMax  = 16 << 20
)

const (
	autoUpgradesPath = "/etc/apt/apt.conf.d/20auto-upgrades"
	unattendedPath   = "/etc/apt/apt.conf.d/52itso-unattended-upgrades"
	composeRoot      = "/var/lib/itso/compose"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpSoftwareInstall: d.softwareInstall,
			contracts.OpSoftwareRemove:  d.softwareRemove,
			contracts.OpSoftwareCatalog: d.softwareCatalog,
			contracts.OpSoftwareStatus:  d.softwareStatus,
			contracts.OpSoftwareUpgrade: d.softwareUpgrade,
			contracts.OpOSAutoUpdates:   d.osAutoUpdates,
		}
	})
}

var aptOpts = []string{"-y", "-q", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"}

func recipeOf(r contracts.Recipe) ([]string, recipeMeta, error) {
	pkgs, err := validate.Recipe(string(r))
	if err != nil {
		return nil, recipeMeta{}, opErr(err)
	}
	m, ok := catalog[string(r)]
	if !ok {
		return nil, recipeMeta{}, &registry.OpError{Code: "invalid_params", Message: "recipe " + string(r) + " thiếu siêu dữ liệu catalog"}
	}
	return pkgs, m, nil
}

// installedVersion trả bản đã cài của recipe (gói đầu tiên; wp-cli: phar khớp sha512).
func (d *Deps) installedVersion(ctx context.Context, recipe string) (*string, error) {
	if recipe == "wp-cli" {
		b, err := d.FS.ReadFile(WPCLIPath)
		if err != nil || !sha512Is(b, wpcliSHA512) {
			return nil, nil //nolint:nilerr // chưa cài hoặc phar bị sửa → coi như chưa cài, cài lại sẽ ghi đè
		}
		v := WPCLIVersion
		return &v, nil
	}
	pkgs, err := validate.Recipe(recipe)
	if err != nil || len(pkgs) == 0 {
		return nil, opErr(err)
	}
	return d.pkgVersion(ctx, pkgs[0])
}

func sha512Is(b []byte, want string) bool {
	sum := sha512.Sum512(b)
	return hex.EncodeToString(sum[:]) == want
}

func (d *Deps) softwareCatalog(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareCatalogParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(validate.Recipes))
	for k := range validate.Recipes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := contracts.SoftwareCatalogResult{Recipes: []contracts.SoftwareCatalogResultRecipesItem{}}
	for _, k := range keys {
		m := catalog[k]
		item := contracts.SoftwareCatalogResultRecipesItem{Recipe: contracts.Recipe(k), Name: m.Name, Category: m.Category,
			Packages: append([]string{}, validate.Recipes[k]...), Source: m.Source, Core: m.Core,
			Conflicts: recipes(m.Conflicts), Requires: recipes(m.Requires)}
		if m.Service != "" {
			s := m.Service
			item.Service = &s
		}
		out.Recipes = append(out.Recipes, item)
	}
	return toData(out)
}

func recipes(l []string) []contracts.Recipe {
	out := []contracts.Recipe{}
	for _, s := range l {
		out = append(out, contracts.Recipe(s))
	}
	return out
}

// checkInstallable: xung đột đã cài → precondition_failed (panel 409 conflict); thiếu phụ thuộc → precondition_failed.
func (d *Deps) checkInstallable(ctx context.Context, recipe string, m recipeMeta) error {
	for _, c := range m.Conflicts {
		v, err := d.installedVersion(ctx, c)
		if err != nil {
			return err
		}
		if v != nil {
			return &registry.OpError{Code: "precondition_failed", Message: "xung đột: " + c + " đang cài, gỡ trước khi cài " + recipe}
		}
	}
	for _, r := range m.Requires {
		v, err := d.installedVersion(ctx, r)
		if err != nil {
			return err
		}
		if v == nil {
			return &registry.OpError{Code: "precondition_failed", Message: "thiếu phụ thuộc: cài " + r + " trước " + recipe}
		}
	}
	return nil
}

func (d *Deps) softwareInstall(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareInstallParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	pkgs, m, err := recipeOf(p.Recipe)
	if err != nil {
		return nil, err
	}
	recipe := string(p.Recipe)
	ver, err := d.installedVersion(ctx, recipe)
	if err != nil {
		return nil, err
	}
	if ver != nil {
		return toData(contracts.SoftwareInstallResult{Installed: true, Version: ver, Changed: false})
	}
	if err := d.checkInstallable(ctx, recipe, m); err != nil {
		return nil, err
	}
	if recipe == "wp-cli" {
		if err := d.installWPCLI(ctx); err != nil {
			return nil, err
		}
	} else {
		if m.Source == "ppa-ondrej-php" {
			if _, err := d.ensurePPA(ctx); err != nil {
				return nil, err
			}
		}
		if _, err := d.aptEnsure(ctx, pkgs); err != nil {
			return nil, err
		}
		if strings.HasPrefix(recipe, "php") {
			// Master mặc định của gói không dùng: mỗi account có master riêng itso-php@<ver>-<user> (D-68).
			if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "disable", "--now", pkgs[0]+".service"); err != nil {
				return nil, err
			}
		}
	}
	if ver, err = d.installedVersion(ctx, recipe); err != nil {
		return nil, err
	}
	return toData(contracts.SoftwareInstallResult{Installed: ver != nil, Version: ver, Changed: true})
}

func (d *Deps) installWPCLI(ctx context.Context) error {
	fetch := d.Fetch
	if fetch == nil {
		fetch = httpFetch
	}
	b, err := fetch(ctx, wpcliURL, wpcliMax)
	if err != nil {
		return &registry.OpError{Code: "dependency_unavailable", Message: "tải wp-cli: " + err.Error(), Retryable: true}
	}
	if !sha512Is(b, wpcliSHA512) {
		return &registry.OpError{Code: "precondition_failed", Message: "wp-cli " + WPCLIVersion + " sai sha512 ghim, từ chối cài"}
	}
	if _, err := d.FS.WriteAtomic(WPCLIPath, b, 0o755, platform.Owner{}); err != nil {
		return opErr(err)
	}
	return nil
}

// httpFetch tải URL HTTPS với giới hạn kích thước và thời gian (chỉ dùng cho tệp có hash ghim).
func httpFetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(url, "https://") {
		return nil, errors.New("chỉ tải qua https")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("tệp vượt giới hạn kích thước")
	}
	return b, nil
}

// inUse: kiểm phía agent (panel cũng chặn theo DB): PHP còn pool, Docker còn compose project.
func (d *Deps) inUse(recipe string) string {
	if v, ok := strings.CutPrefix(recipe, "php"); ok {
		accts, _ := d.FS.ReadDir(phpConfBase + "/" + v)
		for _, a := range accts {
			if pools, err := d.FS.ReadDir(phpConfBase + "/" + v + "/" + a + "/pool.d"); err == nil && len(pools) > 0 {
				return "PHP " + v + " còn pool của account " + a
			}
		}
	}
	if recipe == "docker" {
		if l, err := d.FS.ReadDir(composeRoot); err == nil && len(l) > 0 {
			return fmt.Sprintf("còn %d compose project", len(l))
		}
	}
	return ""
}

func (d *Deps) softwareRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	pkgs, m, err := recipeOf(p.Recipe)
	if err != nil {
		return nil, err
	}
	recipe := string(p.Recipe)
	if m.Core {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "recipe " + recipe + " là thành phần lõi, không gỡ được"}
	}
	if why := d.inUse(recipe); why != "" {
		return nil, &registry.OpError{Code: "in_use", Message: why}
	}
	for k, o := range catalog { // recipe khác đang cài phụ thuộc vào recipe này
		if contains(o.Requires, recipe) {
			if v, err := d.installedVersion(ctx, k); err != nil {
				return nil, err
			} else if v != nil {
				return nil, &registry.OpError{Code: "in_use", Message: k + " phụ thuộc " + recipe}
			}
		}
	}
	ver, err := d.installedVersion(ctx, recipe)
	if err != nil {
		return nil, err
	}
	if ver == nil {
		return toData(contracts.SoftwareRemoveResult{Installed: false, Changed: false})
	}
	if recipe == "wp-cli" {
		if _, err := d.FS.Remove(WPCLIPath); err != nil {
			return nil, opErr(err)
		}
		return toData(contracts.SoftwareRemoveResult{Installed: false, Changed: true})
	}
	if _, err := d.must(ctx, "dependency_unavailable", "apt-get", append([]string{"remove", "-y", "-q"}, pkgs...)...); err != nil {
		return nil, err
	}
	return toData(contracts.SoftwareRemoveResult{Installed: false, Changed: true})
}

func (d *Deps) softwareUpgrade(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareUpgradeParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	pkgs, _, err := recipeOf(p.Recipe)
	if err != nil {
		return nil, err
	}
	recipe := string(p.Recipe)
	from, err := d.installedVersion(ctx, recipe)
	if err != nil {
		return nil, err
	}
	if from == nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: recipe + " chưa cài"}
	}
	if recipe == "wp-cli" { // phar ghim theo bản agent: nâng cấp = nâng agent
		return toData(contracts.SoftwareUpgradeResult{FromVersion: from, Version: from, Changed: false})
	}
	args := append(append([]string{"install", "--only-upgrade"}, aptOpts...), pkgs...)
	if _, err := d.must(ctx, "dependency_unavailable", "apt-get", args...); err != nil {
		return nil, err
	}
	to, err := d.installedVersion(ctx, recipe)
	if err != nil {
		return nil, err
	}
	return toData(contracts.SoftwareUpgradeResult{FromVersion: from, Version: to, Changed: to != nil && *to != *from})
}

func (d *Deps) softwareStatus(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareStatusParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	list := make([]string, 0, len(p.Recipes))
	for _, r := range p.Recipes {
		if _, _, err := recipeOf(r); err != nil {
			return nil, err
		}
		list = append(list, string(r))
	}
	if len(list) == 0 {
		for k := range validate.Recipes {
			list = append(list, k)
		}
		sort.Strings(list)
	}
	out := contracts.SoftwareStatusResult{Software: []contracts.SoftwareInfo{}}
	for _, r := range list {
		info := contracts.SoftwareInfo{Recipe: contracts.Recipe(r)}
		v, err := d.installedVersion(ctx, r)
		if err != nil {
			return nil, err
		}
		info.InstalledVersion = v
		if r == "wp-cli" {
			l := WPCLIVersion
			info.LatestVersion = &l
		} else if pk := validate.Recipes[r]; len(pk) > 0 {
			info.LatestVersion = d.candidate(ctx, pk[0])
		}
		if m := catalog[r]; m.Service != "" {
			s := m.Service
			info.Service = &s
			if v != nil {
				res, err := d.run(ctx, "systemctl", "is-active", m.Service)
				if err != nil {
					return nil, err
				}
				a := res.ExitCode == 0
				info.Active = &a
			}
		}
		out.Software = append(out.Software, info)
	}
	out.PendingSecurity = d.pendingSecurity(ctx)
	return toData(out)
}

// candidate đọc "Candidate:" của apt-cache policy (nil nếu không có trong kho).
func (d *Deps) candidate(ctx context.Context, pkg string) *string {
	res, err := d.run(ctx, "apt-cache", "policy", pkg)
	if err != nil || res.ExitCode != 0 {
		return nil
	}
	for _, l := range strings.Split(string(res.Stdout), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "Candidate:"); ok {
			v = strings.TrimSpace(v)
			if v == "" || v == "(none)" {
				return nil
			}
			return &v
		}
	}
	return nil
}

// pendingSecurity đếm gói sẽ nâng cấp từ kho -security (mô phỏng, không khóa apt).
func (d *Deps) pendingSecurity(ctx context.Context) int64 {
	res, err := d.run(ctx, "apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade")
	if err != nil || res.ExitCode != 0 {
		return 0
	}
	var n int64
	for _, l := range strings.Split(string(res.Stdout), "\n") {
		if strings.HasPrefix(l, "Inst ") && strings.Contains(l, "-security") {
			n++
		}
	}
	return n
}

// osAutoUpdates bật/tắt unattended-upgrades; luôn Automatic-Reboot "false" (D-100).
func (d *Deps) osAutoUpdates(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.OSAutoUpdatesParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	changed := false
	if p.Enabled {
		added, err := d.aptEnsure(ctx, []string{"unattended-upgrades"})
		if err != nil {
			return nil, err
		}
		changed = len(added) > 0
	}
	on := "0"
	if p.Enabled {
		on = "1"
	}
	var periodic bytes.Buffer
	fmt.Fprintf(&periodic, "// Quản lý bởi itso-agent (D-100). Không sửa tay.\nAPT::Periodic::Update-Package-Lists \"%s\";\nAPT::Periodic::Unattended-Upgrade \"%s\";\n", on, on)
	origins := "        \"${distro_id}:${distro_codename}-security\";\n        \"${distro_id}ESMApps:${distro_codename}-apps-security\";\n        \"${distro_id}ESM:${distro_codename}-infra-security\";\n"
	if !p.SecurityOnly {
		origins += "        \"${distro_id}:${distro_codename}\";\n        \"${distro_id}:${distro_codename}-updates\";\n"
	}
	conf := "// Quản lý bởi itso-agent (D-100). Không sửa tay. Không bao giờ tự reboot.\n" +
		"Unattended-Upgrade::Allowed-Origins {\n" + origins + "};\n" +
		"Unattended-Upgrade::Automatic-Reboot \"false\";\n" +
		"Unattended-Upgrade::Remove-Unused-Dependencies \"false\";\n"
	for _, f := range []struct {
		path string
		data []byte
	}{{autoUpgradesPath, periodic.Bytes()}, {unattendedPath, []byte(conf)}} {
		c, err := d.FS.WriteAtomic(f.path, f.data, 0o644, platform.Owner{})
		if err != nil {
			return nil, opErr(err)
		}
		changed = changed || c
	}
	return toData(contracts.OSAutoUpdatesResult{Enabled: p.Enabled, SecurityOnly: p.SecurityOnly, AutoReboot: false, Changed: changed})
}
