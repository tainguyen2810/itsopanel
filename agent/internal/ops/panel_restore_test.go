package ops_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"itso.local/agent/internal/contracts"
)

// DR (Prompt 8.5): panel.restore giải mã backup panel (restic thật) vào staging rồi hẹn itso panel-restore-apply.
func TestPanelRestoreStagesAndSchedulesApply(t *testing.T) {
	needRestic(t)
	e := dataEnv(t)
	e.d.Sandbox = true
	write(t, e.fs.Root, "/etc/passwd", e.file("/etc/passwd")+"postgres:x:114:121::/var/lib/postgresql:/bin/bash\n")
	key := "APP_KEY=base64:" + strings.Repeat("A", 43) + "=\n"
	write(t, e.fs.Root, "/etc/itso/itso.env", key+"DB_PASSWORD=cu\n")
	write(t, e.fs.Root, "/etc/itso/agent-policy.yaml", "terminal.root: off\n")
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	repo := bkRepoParams(localDest(), "", bkPass)
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	sid := e.h.OK(contracts.OpBackupRun, bkRun(repo, "panel", nil, map[string]any{"age_recipient": id.Recipient().String()}))["snapshot_id"].(string)
	params := func(identity string, r map[string]any) map[string]any {
		return map[string]any{"repo": r, "snapshot_id": sid, "age_identity": identity, "apply_delay_sec": 5}
	}

	e.fake.Reset()
	res := e.h.OK(contracts.OpPanelRestore, params(id.String(), repo))
	dir := res["staged_dir"].(string)
	if !regexp.MustCompile(`^/var/lib/itso/restore/panel-[0-9]{8}T[0-9]{6}Z$`).MatchString(dir) {
		t.Fatal(dir)
	}
	files := res["files"].([]any)
	if len(files) != 3 || files[0] != "itso.dump" {
		t.Fatal(files)
	}
	if b, _ := os.ReadFile(filepath.Join(e.fs.Root, dir, "etc/itso/itso.env")); !strings.HasPrefix(string(b), key) {
		t.Fatal("itso.env cũ phải được giải ra", string(b))
	}
	if fi, err := os.Stat(filepath.Join(e.fs.Root, dir)); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatal("staging 0700", fi, err)
	}
	unit := res["apply_unit"].(string)
	sched := ""
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "systemd-run ") {
			sched = l
		}
	}
	if !strings.Contains(sched, "--on-active=5s") || !strings.Contains(sched, "--unit="+unit) ||
		!strings.HasSuffix(sched, "/opt/itso/current/bin/itso panel-restore-apply --dir "+dir) {
		t.Fatal("phải hẹn apply bằng unit tạm:", sched)
	}

	// Khóa riêng sai → repo_auth_failed, không để lại staging mới; repo account → invalid.
	other, _ := age.GenerateX25519Identity()
	e.d.Now = func() time.Time { return bkNow.Add(time.Minute) }
	before, _ := os.ReadDir(filepath.Join(e.fs.Root, "var/lib/itso/restore"))
	e.h.Fail(contracts.OpPanelRestore, params(other.String(), repo), "repo_auth_failed")
	after, _ := os.ReadDir(filepath.Join(e.fs.Root, "var/lib/itso/restore"))
	if len(after) != len(before) {
		t.Fatal("staging lỗi phải được dọn", before, after)
	}
	e.h.Fail(contracts.OpPanelRestore, params(id.String(), bkRepoParams(localDest(), bkAcct, bkPass)), "invalid_params")
	e.h.Fail(contracts.OpPanelRestore, map[string]any{"repo": repo, "snapshot_id": "latest", "age_identity": id.String(), "apply_delay_sec": 5}, "invalid_params")
}
