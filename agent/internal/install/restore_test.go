package install_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"itso.local/agent/internal/install"
	"itso.local/agent/internal/platform"
)

const stagedDir = "/var/lib/itso/restore/panel-20261121T025900Z"

var oldKey = "APP_KEY=base64:" + strings.Repeat("B", 43) + "="

func stage(t *testing.T, r *rig) {
	t.Helper()
	root := r.fs.Root
	put(t, root, stagedDir+"/itso.dump", "PGDMP-cu")
	put(t, root, stagedDir+"/etc/itso/itso.env", oldKey+"\nDB_PASSWORD=mat-khau-cu\n")
	put(t, root, stagedDir+"/etc/itso/agent.key", "khoa-agent-cu")
	put(t, root, stagedDir+"/etc/itso/agent-policy.yaml", "terminal.root: on # cu\n")
	put(t, root, stagedDir+"/etc/itso/backup/id_ed25519", "ssh-cu")
	put(t, root, stagedDir+"/etc/itso/tls/panel.key", "tls-cu")
}

func TestPanelRestoreApply(t *testing.T) {
	r := installed(t)
	ctx := context.Background()
	newEnv := string(must(r.fs.ReadFile(install.EnvFile)))
	newAgentKey := string(must(r.fs.ReadFile(install.AgentKey)))
	newTLS := string(must(r.fs.ReadFile(install.TLSKey)))
	stage(t, r)

	// Đường dẫn ngoài staging → từ chối, không chạy lệnh nào.
	r.fake.Reset()
	if err := r.e.PanelRestoreApply(ctx, "/etc/itso"); err == nil || len(r.fake.Lines()) != 0 {
		t.Fatal("thư mục lạ phải bị từ chối", err)
	}
	if err := r.e.PanelRestoreApply(ctx, stagedDir+"/../../../../etc"); err == nil {
		t.Fatal("`..` phải bị từ chối")
	}

	// pg_restore lỗi → DB không đổi (single transaction), cấu hình không đổi, dịch vụ chạy lại.
	r.fail["[uid=110] pg_restore"] = platform.Result{ExitCode: 1, Stderr: []byte("pg_restore: error")}
	if err := r.e.PanelRestoreApply(ctx, stagedDir); err == nil || !strings.Contains(err.Error(), "DB không đổi") {
		t.Fatal(err)
	}
	w := strings.Join(r.writes(), "\n")
	if !strings.Contains(w, "systemctl start itso.target") || !strings.Contains(w, "artisan up") {
		t.Fatal("lỗi giữa chừng phải bật lại dịch vụ:\n" + w)
	}
	if string(must(r.fs.ReadFile(install.EnvFile))) != newEnv {
		t.Fatal("cấu hình không được đổi khi pg_restore lỗi")
	}
	var res install.RestoreResult
	_ = json.Unmarshal(must(r.fs.ReadFile(install.RestoreResultFile)), &res)
	if res.OK || !strings.Contains(res.Error, "pg_restore") {
		t.Fatal(res)
	}
	delete(r.fail, "[uid=110] pg_restore")

	r.fake.Reset()
	if err := r.e.PanelRestoreApply(ctx, stagedDir); err != nil {
		t.Fatal(err, r.out.String())
	}
	w = strings.Join(r.writes(), "\n")
	order := []string{"[uid=110] pg_dump --cluster 16/itso -Fc -f /var/backups/itso/pre-restore/", "artisan down", "systemctl stop itso.target",
		"[uid=110] pg_restore --cluster 16/itso --clean --if-exists --single-transaction --no-owner --role=itso --exit-on-error -d itso",
		"artisan migrate --force", "systemctl start itso.target", "artisan itso:reconcile", "artisan itso:dr-restore --start", "artisan up"}
	at := 0
	for _, want := range order {
		i := strings.Index(w[at:], want)
		if i < 0 {
			t.Fatalf("thiếu hoặc sai thứ tự %q:\n%s", want, w)
		}
		at += i + len(want)
	}
	env := string(must(r.fs.ReadFile(install.EnvFile)))
	if !strings.Contains(env, oldKey+"\n") || strings.Contains(env, "mat-khau-cu") || strings.Replace(newEnv, newEnv[strings.Index(newEnv, "APP_KEY="):strings.Index(newEnv, "APP_KEY=")+len(oldKey)], oldKey, 1) != env {
		t.Fatal("itso.env: chỉ thay APP_KEY, giữ mật khẩu DB của máy mới:\n" + env)
	}
	if string(must(r.fs.ReadFile(install.AgentKey))) != newAgentKey || string(must(r.fs.ReadFile(install.TLSKey))) != newTLS {
		t.Fatal("agent.key/TLS phải giữ bản của máy mới")
	}
	if string(must(r.fs.ReadFile(install.PolicyFile))) != "terminal.root: on # cu\n" || string(must(r.fs.ReadFile("/etc/itso/backup/id_ed25519"))) != "ssh-cu" {
		t.Fatal("policy agent + khóa SSH backup phải lấy từ backup")
	}
	if !r.fs.Exists(install.BackupDir + "/pre-restore/20261121T030000Z/etc/agent.key") {
		t.Fatal("phải sao lưu /etc/itso của máy mới trước khi thay")
	}
	if r.fs.Exists(stagedDir) || !r.fs.Exists(install.RestoreRoot) {
		t.Fatal("bản rõ trong staging phải bị xóa sau khi áp (giữ thư mục restore gốc)")
	}
	_ = json.Unmarshal(must(r.fs.ReadFile(install.RestoreResultFile)), &res)
	if !res.OK || strings.Join(res.Restored, ",") != "agent-policy.yaml,backup/id_ed25519,itso.env (APP_KEY)" {
		t.Fatal(res)
	}
}

func TestInstallRestoreMode(t *testing.T) {
	r := newRig(t)
	o := opts(release(t, "1.0.0"))
	o.Restore = true
	if err := r.e.Install(context.Background(), o); err != nil {
		t.Fatal(err, r.out.String())
	}
	var sc install.SetupCode
	_ = json.Unmarshal(must(r.fs.ReadFile(install.SetupFile)), &sc)
	if sc.Mode != "restore" || !strings.Contains(r.out.String(), "Khôi phục từ backup") {
		t.Fatal(sc, r.out.String())
	}
	// Cài thường: không có mode.
	r2 := installed(t)
	var sc2 install.SetupCode
	_ = json.Unmarshal(must(r2.fs.ReadFile(install.SetupFile)), &sc2)
	if sc2.Mode != "" || strings.Contains(string(must(r2.fs.ReadFile(install.SetupFile))), "mode") {
		t.Fatal(sc2)
	}
}
