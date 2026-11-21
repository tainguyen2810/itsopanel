package policy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	p, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	for op, want := range map[string]bool{"system.ping": true, "account.ensure": true, "backup.forget": false,
		"docker.container.control": false, "compose.up": false, "khong.co": false} {
		if got := p.Enabled(op); got != want {
			t.Errorf("Enabled(%s) = %t, muốn %t", op, got, want)
		}
	}
}

func TestLoadAndOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-policy.yaml")
	if err := os.WriteFile(path, []byte("version: 1\nops:\n  system.reboot: false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := Load(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if p.Enabled("system.reboot") || !p.Enabled("system.info") {
		t.Fatal("ghi đè op không đúng")
	}
	// Bật op docker trong ops không vượt được cờ docker=false.
	_ = p.Set("ops.compose.up", true)
	if p.Enabled("compose.up") {
		t.Fatal("cờ docker=false phải thắng ops")
	}
	_ = p.Set("docker", true)
	if !p.Enabled("compose.up") {
		t.Fatal("docker=true + ops bật → cho phép")
	}
	if err := p.Set("ops.khong.co", true); err == nil {
		t.Fatal("op lạ phải bị từ chối")
	}
	if err := p.Save(path); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("quyền sau khi lưu %o", fi.Mode().Perm())
	}
	p2, err := Load(path, false)
	if err != nil || !p2.File.Docker || !p2.File.Ops["compose.up"] {
		t.Fatalf("nạp lại sai: %+v %v", p2, err)
	}
}

func TestRejects(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"op lạ":       "version: 1\nops:\n  run.anything: true\n",
		"khóa lạ":     "version: 1\nallow_shell: true\n",
		"sai version": "version: 2\n",
	}
	for name, body := range cases {
		p := filepath.Join(dir, name+".yaml")
		_ = os.WriteFile(p, []byte(body), 0o600)
		if _, err := Load(p, false); err == nil {
			t.Errorf("%s: phải bị từ chối", name)
		}
	}
	// strict: quyền rộng hoặc chủ không phải root → từ chối.
	p := filepath.Join(dir, "wide.yaml")
	_ = os.WriteFile(p, []byte("version: 1\n"), 0o644)
	if _, err := Load(p, true); err == nil {
		t.Error("quyền 0644 phải bị từ chối ở chế độ strict")
	}
	if os.Getuid() != 0 {
		_ = os.Chmod(p, 0o600)
		if _, err := Load(p, true); err == nil {
			t.Error("chủ không phải root phải bị từ chối ở chế độ strict")
		}
	}
	// Không có file → mặc định.
	if _, err := Load(filepath.Join(dir, "none.yaml"), true); err != nil {
		t.Errorf("không có file phải dùng mặc định: %v", err)
	}
}
