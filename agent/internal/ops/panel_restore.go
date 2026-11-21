package ops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// CLIBin là CLI quản trị trong bản phát hành hiện tại (tarball bin/itso).
const CLIBin = "/opt/itso/current/bin/itso"

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{contracts.OpPanelRestore: d.panelRestore}
	})
}

// panelRestore (panel.restore, DR Prompt 8.5): giải mã backup panel của snapshot vào /var/lib/itso/restore/panel-<ts>
// (0700 root), kiểm có itso.dump + etc/itso/itso.env, rồi hẹn unit tạm `itso panel-restore-apply --dir …` chạy sau
// apply_delay_sec giây — sau khi job hiện tại đã ghi kết quả vào DB panel (DB này sẽ bị thay).
func (d *Deps) panelRestore(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo          backup.RepoParams `json:"repo"`
		SnapshotID    string            `json:"snapshot_id"`
		AgeIdentity   string            `json:"age_identity"`
		ApplyDelaySec int               `json:"apply_delay_sec"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !backup.ValidSnapshotID(p.SnapshotID) {
		return nil, bkInvalid("snapshot_id không hợp lệ")
	}
	if !strings.HasPrefix(p.AgeIdentity, "AGE-SECRET-KEY-1") || len(p.AgeIdentity) != 74 {
		return nil, bkInvalid("age_identity không hợp lệ")
	}
	if p.ApplyDelaySec < 1 || p.ApplyDelaySec > 300 {
		return nil, bkInvalid("apply_delay_sec ngoài 1–300")
	}
	if !strings.HasSuffix(p.Repo.Path, "/server") {
		return nil, bkInvalid("chỉ khôi phục panel từ repo server")
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	base, err := d.FS.Path(backup.StagingRoot)
	if err != nil {
		return nil, opErr(err)
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, opErr(err)
	}
	ts := d.now().UTC().Format("20060102T150405Z")
	rel := backup.StagingRoot + "/panel-" + ts
	dst := filepath.Join(base, "panel-"+ts)
	names, err := d.extractPanel(ctx, r, p.SnapshotID, p.AgeIdentity, dst)
	if err != nil {
		_ = os.RemoveAll(dst)
		return nil, err
	}
	if !slices.Contains(names, "itso.dump") || !slices.Contains(names, "etc/itso/itso.env") {
		_ = os.RemoveAll(dst)
		return nil, &registry.OpError{Code: "precondition_failed", Message: "backup panel thiếu itso.dump hoặc etc/itso/itso.env"}
	}
	unit := "itso-panel-restore-" + strings.ToLower(ts)
	if _, err := d.must(ctx, "dependency_unavailable", "systemd-run", "--quiet", "--collect",
		fmt.Sprintf("--on-active=%ds", p.ApplyDelaySec), "--unit="+unit, "--timer-property=AccuracySec=1s",
		"--description=ITSO DR: thay DB panel + /etc/itso", CLIBin, "panel-restore-apply", "--dir", rel); err != nil {
		return nil, err
	}
	return toData(contracts.PanelRestoreResult{StagedDir: rel, Files: names, ApplyUnit: &unit})
}
