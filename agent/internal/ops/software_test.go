package ops_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/validate"
)

func hasLine(lines []string, prefix string) bool {
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return true
		}
	}
	return false
}

// Catalog phủ mọi recipe trong allowlist, có nhóm/kho hợp lệ (D-100).
func TestSoftwareCatalog(t *testing.T) {
	e := newEnv(t)
	d := e.h.OK(contracts.OpSoftwareCatalog, map[string]any{})
	items, _ := d["recipes"].([]any)
	if len(items) != len(validate.Recipes) {
		t.Fatalf("catalog %d mục, allowlist %d", len(items), len(validate.Recipes))
	}
	byKey := map[string]map[string]any{}
	for _, x := range items {
		m := x.(map[string]any)
		byKey[m["recipe"].(string)] = m
	}
	if byKey["php8.4"]["source"] != "ppa-ondrej-php" || byKey["redis"]["service"] != "redis-server" || byKey["restic"]["core"] != true {
		t.Fatal(byKey["php8.4"], byKey["redis"], byKey["restic"])
	}
	if c, _ := byKey["valkey"]["conflicts"].([]any); len(c) != 1 || c[0] != "redis" {
		t.Fatal(byKey["valkey"])
	}
	if len(e.fake.Lines()) != 0 {
		t.Fatal("catalog không được chạy lệnh", e.fake.Lines())
	}
}

// Xung đột và thiếu phụ thuộc bị chặn trước khi gọi apt; kho PPA chỉ thêm khi cài PHP bản PPA.
func TestSoftwareConflictsAndPPA(t *testing.T) {
	e := newEnv(t)
	e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "redis"})
	if e.exists("/etc/apt/sources.list.d/itso-ondrej-php.sources") {
		t.Fatal("cài redis không được thêm kho PPA")
	}
	e.fake.Reset()
	e.h.Fail(contracts.OpSoftwareInstall, map[string]any{"recipe": "valkey"}, "precondition_failed")
	if hasLine(e.fake.Lines(), "apt-get install") {
		t.Fatal("xung đột phải bị chặn trước apt-get", e.fake.Lines())
	}
	e.h.Fail(contracts.OpSoftwareInstall, map[string]any{"recipe": "composer"}, "precondition_failed") // thiếu php8.3

	e.fake.Reset()
	if d := e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "php8.4"}); d["changed"] != true {
		t.Fatal(d)
	}
	src := e.file("/etc/apt/sources.list.d/itso-ondrej-php.sources")
	if !strings.Contains(src, "Signed-By: /etc/apt/keyrings/itso-ondrej-php.asc") || !strings.Contains(src, "Suites: noble") {
		t.Fatal(src)
	}
	if !strings.Contains(e.file("/etc/apt/keyrings/itso-ondrej-php.asc"), "BEGIN PGP PUBLIC KEY BLOCK") {
		t.Fatal("thiếu khóa PPA")
	}
	l := e.fake.Lines()
	if !hasLine(l, "apt-get update -q") || !hasLine(l, "apt-get install -y -q --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold php8.4-fpm php8.4-cli php8.4-common") ||
		!hasLine(l, "systemctl disable --now php8.4-fpm.service") {
		t.Fatal(l)
	}
	// Cài bản PPA khác: kho đã có → không apt-get update lại; idempotent.
	e.fake.Reset()
	e.h.OK(contracts.OpPHPVersionInstall, map[string]any{"version": "8.2", "extensions": []any{}})
	if hasLine(e.fake.Lines(), "apt-get update") {
		t.Fatal("kho không đổi thì không update lại", e.fake.Lines())
	}
	if d := e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "php8.4"}); d["changed"] != false {
		t.Fatal(d)
	}
}

// Gỡ: thành phần lõi, PHP còn pool, Docker còn project, recipe khác phụ thuộc → bị chặn.
func TestSoftwareRemoveBlocked(t *testing.T) {
	e := newEnv(t)
	for _, r := range []string{"nginx", "restic", "php8.3"} {
		e.h.Fail(contracts.OpSoftwareRemove, map[string]any{"recipe": r}, "precondition_failed")
	}
	e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "php8.4"})
	if _, err := e.fs.WriteAtomic("/etc/itso/php/8.4/lehoa/pool.d/01938a06.conf", []byte("[x]\n"), 0o644, platform.Owner{}); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpSoftwareRemove, map[string]any{"recipe": "php8.4"}, "in_use")
	e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "docker"})
	if _, err := e.fs.WriteAtomic("/var/lib/itso/compose/01938a20-0001-7000-8000-000020000001/compose.yaml", []byte("services: {}\n"), 0o644, platform.Owner{}); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpSoftwareRemove, map[string]any{"recipe": "docker"}, "in_use")
	e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "memcached"})
	if d := e.h.OK(contracts.OpSoftwareRemove, map[string]any{"recipe": "memcached"}); d["changed"] != true {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpSoftwareRemove, map[string]any{"recipe": "memcached"}); d["changed"] != false {
		t.Fatal(d)
	}
}

// WP-CLI: phar sai sha512 ghim bị từ chối, không ghi file; lỗi mạng là lỗi tạm thời.
func TestWPCLIPinned(t *testing.T) {
	e := newEnv(t)
	e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "php8.3"})
	e.d.Fetch = func(_ context.Context, url string, _ int64) ([]byte, error) {
		if !strings.HasPrefix(url, "https://github.com/wp-cli/wp-cli/releases/download/v2.11.0/") {
			t.Fatalf("URL lạ: %s", url)
		}
		return []byte("<?php echo 'giả';"), nil
	}
	e.h.Fail(contracts.OpSoftwareInstall, map[string]any{"recipe": "wp-cli"}, "precondition_failed")
	if e.exists(ops.WPCLIPath) {
		t.Fatal("phar sai hash không được ghi")
	}
	e.d.Fetch = func(context.Context, string, int64) ([]byte, error) { return nil, errors.New("mạng lỗi") }
	e.h.Fail(contracts.OpSoftwareInstall, map[string]any{"recipe": "wp-cli"}, "dependency_unavailable")
}

func TestSoftwareUpgradeAndStatus(t *testing.T) {
	e := newEnv(t)
	e.h.Fail(contracts.OpSoftwareUpgrade, map[string]any{"recipe": "redis"}, "precondition_failed")
	e.h.OK(contracts.OpSoftwareInstall, map[string]any{"recipe": "redis"})
	e.fake.Reset()
	e.h.OK(contracts.OpSoftwareUpgrade, map[string]any{"recipe": "redis"})
	if !hasLine(e.fake.Lines(), "apt-get install --only-upgrade -y -q --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold redis-server") {
		t.Fatal(e.fake.Lines())
	}
	d := e.h.OK(contracts.OpSoftwareStatus, map[string]any{"recipes": []any{"redis", "memcached"}})
	sw, _ := d["software"].([]any)
	if len(sw) != 2 {
		t.Fatal(d)
	}
	r := sw[0].(map[string]any)
	if r["installed_version"] != "1.0-sandbox" || r["service"] != "redis-server" || r["active"] == nil {
		t.Fatal(r)
	}
	if m := sw[1].(map[string]any); m["installed_version"] != nil || m["active"] != nil {
		t.Fatal(m)
	}
	e.h.Fail(contracts.OpSoftwareStatus, map[string]any{"recipes": []any{"apache2"}}, "invalid_params")
}

// unattended-upgrades: chỉ bảo mật hoặc tất cả, không bao giờ tự reboot; idempotent.
func TestOSAutoUpdates(t *testing.T) {
	e := newEnv(t)
	d := e.h.OK(contracts.OpOSAutoUpdates, map[string]any{"enabled": true, "security_only": true})
	if d["changed"] != true || d["auto_reboot"] != false {
		t.Fatal(d)
	}
	c := e.file("/etc/apt/apt.conf.d/52itso-unattended-upgrades")
	if !strings.Contains(c, `Automatic-Reboot "false"`) || strings.Contains(c, "-updates") {
		t.Fatal(c)
	}
	if !strings.Contains(e.file("/etc/apt/apt.conf.d/20auto-upgrades"), `Unattended-Upgrade "1"`) {
		t.Fatal("chưa bật")
	}
	if d := e.h.OK(contracts.OpOSAutoUpdates, map[string]any{"enabled": true, "security_only": true}); d["changed"] != false {
		t.Fatal(d)
	}
	e.h.OK(contracts.OpOSAutoUpdates, map[string]any{"enabled": true, "security_only": false})
	if !strings.Contains(e.file("/etc/apt/apt.conf.d/52itso-unattended-upgrades"), "-updates") {
		t.Fatal("tất cả bản cập nhật phải gồm -updates")
	}
	e.h.OK(contracts.OpOSAutoUpdates, map[string]any{"enabled": false, "security_only": true})
	if !strings.Contains(e.file("/etc/apt/apt.conf.d/20auto-upgrades"), `Unattended-Upgrade "0"`) {
		t.Fatal("chưa tắt")
	}
}
