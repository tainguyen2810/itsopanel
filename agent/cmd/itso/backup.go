package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/install"
	"itso.local/agent/internal/ops"
)

// backupCmd: `itso backup prune|panel-restore` bằng bộ khôi phục (ADR 0029 §4, ADR 0033 §6). Lệnh restic đi qua
// cùng đường của agent (systemd-run, repo/mật khẩu chỉ qua file 0600 dưới /run/itso/backup).
func backupCmd(ctx context.Context, e *install.Env, args []string) error {
	if len(args) < 1 {
		return errUsage
	}
	sub, args := args[0], args[1:]
	fs := flag.NewFlagSet("backup "+sub, flag.ContinueOnError)
	fs.SetOutput(e.Out)
	kitPath := fs.String("kit", "", "file bộ khôi phục (.txt tải từ panel)")
	sshKey := fs.String("ssh-key", "", "khóa riêng SSH của đích SFTP (khi máy này chưa có)")
	var keep ops.KeepPolicy
	var dry bool
	var snapshot, outDir string
	switch sub {
	case "prune":
		fs.IntVar(&keep.Last, "keep-last", 0, "giữ N snapshot mới nhất")
		fs.IntVar(&keep.Daily, "keep-daily", 0, "giữ N ngày")
		fs.IntVar(&keep.Weekly, "keep-weekly", 0, "giữ N tuần")
		fs.IntVar(&keep.Monthly, "keep-monthly", 0, "giữ N tháng")
		fs.IntVar(&keep.Yearly, "keep-yearly", 0, "giữ N năm")
		fs.BoolVar(&dry, "dry-run", false, "chỉ liệt kê snapshot sẽ xóa")
	case "panel-restore":
		fs.StringVar(&snapshot, "snapshot", "", "id snapshot panel (tag type:panel)")
		fs.StringVar(&outDir, "out", "", "thư mục giải nén (mặc định /var/lib/itso/restore/panel-<thời điểm>)")
	default:
		return fmt.Errorf("%w: backup %q", errUsage, sub)
	}
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *kitPath == "" {
		return errUsage
	}
	raw, err := os.ReadFile(*kitPath)
	if err != nil {
		return err
	}
	kit, err := backup.ParseKit(string(raw))
	if err != nil {
		return err
	}
	creds, err := ops.ReadKitCreds(kit.DestType, stdin)
	if err != nil {
		return err
	}
	if *sshKey != "" {
		if creds.SSHKey, err = os.ReadFile(*sshKey); err != nil {
			return err
		}
	}
	d := &ops.Deps{Run: e.Run, FS: e.FS, Sandbox: sandboxMode}
	if sub == "prune" {
		return d.KitPrune(ctx, kit, creds, keep, dry, e.Out)
	}
	if outDir == "" {
		base, _ := e.FS.Path(backup.StagingRoot)
		if err := os.MkdirAll(base, 0o700); err != nil {
			return err
		}
		outDir = filepath.Join(base, "panel-"+time.Now().UTC().Format("20060102T150405Z"))
	}
	names, err := d.KitPanelRestore(ctx, kit, creds, snapshot, outDir)
	if err != nil {
		return err
	}
	fmt.Fprintf(e.Out, "Đã giải mã backup panel vào %s (%d file):\n", outDir, len(names))
	for _, n := range names {
		fmt.Fprintf(e.Out, "  %s\n", n)
	}
	fmt.Fprintln(e.Out, "Bước tiếp: theo docs/runbooks/disaster-recovery.md (pg_restore itso.dump, chép etc/itso, itso repair).")
	return nil
}
