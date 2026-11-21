package install

import (
	"context"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"itso.local/agent/internal/platform"
)

// RestoreRoot: nơi op panel.restore giải mã backup panel (cùng backup.StagingRoot của agent).
const RestoreRoot = "/var/lib/itso/restore"

// RestoreResultFile: kết quả lần áp khôi phục gần nhất (itso status / runbook đọc).
const RestoreResultFile = "/var/lib/itso/restore/last-apply.json"

// keepOnRestore: file /etc/itso giữ bản của máy mới (mật khẩu DB/Redis, khóa agent, TLS, địa chỉ panel). itso.env chỉ
// lấy APP_KEY từ bản cũ để giải được dữ liệu đã mã hóa (credential đích, mật khẩu repo, khóa age).
var keepOnRestore = map[string]bool{"itso.env": true, "agent.key": true, "redis.conf": true, "panel.json": true}

var stagedDirRe = regexp.MustCompile(`^` + RestoreRoot + `/panel-[0-9]{8}T[0-9]{6}Z$`)

var appKeyRe = regexp.MustCompile(`(?m)^APP_KEY=base64:[A-Za-z0-9+/=]{40,60}$`)

// RestoreResult ghi lại một lần áp.
type RestoreResult struct {
	Dir      string   `json:"dir"`
	OK       bool     `json:"ok"`
	Error    string   `json:"error,omitempty"`
	Restored []string `json:"restored_files"`
	At       string   `json:"at"`
}

// PanelRestoreApply (itso panel-restore-apply, chạy bởi unit tạm do op panel.restore hẹn): sao lưu DB/cấu hình hiện
// tại → maintenance → dừng itso.target → pg_restore một transaction → /etc/itso (trừ file của máy mới, APP_KEY cũ)
// → migrate → chạy lại dịch vụ → itso:reconcile → itso:dr-restore --start → hết maintenance. Lỗi trước khi đổi
// cấu hình: DB không đổi (single transaction), dịch vụ được bật lại.
func (e *Env) PanelRestoreApply(ctx context.Context, dir string) (err error) {
	dir = path.Clean(dir)
	if !stagedDirRe.MatchString(dir) {
		return fmt.Errorf("thư mục khôi phục không hợp lệ: %s", dir)
	}
	if err := e.FS.NoSymlinkBelow(RestoreRoot, dir); err != nil {
		return err
	}
	dump, err := e.FS.ReadFile(dir + "/itso.dump")
	if err != nil {
		return fmt.Errorf("thiếu itso.dump trong %s: %w", dir, err)
	}
	oldEnv := e.readFile(dir + "/etc/itso/itso.env")
	appKey := appKeyRe.FindString(oldEnv)
	if appKey == "" {
		return fmt.Errorf("backup panel không có APP_KEY hợp lệ (etc/itso/itso.env)")
	}
	res := RestoreResult{Dir: dir}
	defer func() {
		res.OK = err == nil
		if err != nil {
			res.Error = err.Error()
		}
		res.At = e.now().UTC().Format(time.RFC3339)
		_ = e.writeJSON(RestoreResultFile, res, 0o600, platform.Owner{})
	}()
	pg, err := e.as("postgres")
	if err != nil {
		return err
	}
	// Sao lưu trạng thái máy mới trước khi thay (có thể quay lại bằng tay theo runbook).
	bdir := BackupDir + "/pre-restore/" + e.now().UTC().Format("20060102T150405Z")
	if err := e.FS.MkdirAll(bdir); err != nil {
		return err
	}
	if _, err := e.run(ctx, platform.Cmd{Bin: "pg_dump", Args: []string{"--cluster", "16/itso", "-Fc", "-f", bdir + "/itso.dump", "itso"}, As: pg}); err != nil {
		return fmt.Errorf("sao lưu DB hiện tại: %w", err)
	}
	if err := e.copyTree(EtcDir, bdir+"/etc"); err != nil {
		return err
	}
	if _, err := e.artisan(ctx, "down", "--retry=30"); err != nil {
		e.printf("  cảnh báo: không bật được maintenance: %v\n", err)
	}
	if _, err := e.cmd(ctx, "systemctl", "stop", "itso.target"); err != nil {
		return err
	}
	started := false
	defer func() {
		if !started {
			_, _ = e.cmd(ctx, "systemctl", "start", "itso.target")
			_, _ = e.artisan(ctx, "up")
		}
	}()
	if _, err := e.run(ctx, platform.Cmd{Bin: "pg_restore", Args: []string{"--cluster", "16/itso", "--clean", "--if-exists",
		"--single-transaction", "--no-owner", "--role=itso", "--exit-on-error", "-d", "itso"}, Stdin: dump, As: pg}); err != nil {
		return fmt.Errorf("pg_restore (DB không đổi): %w", err)
	}
	restored, err := e.restoreEtc(dir+"/etc/itso", appKey)
	if err != nil {
		return err
	}
	res.Restored = restored
	// Bản rõ (dump DB panel + /etc/itso cũ) không cần nữa: bản trước khi thay nằm ở pre-restore, bản cũ vẫn trong repo.
	if err := e.FS.RemoveAll(dir); err != nil {
		e.printf("  cảnh báo: không xóa được %s: %v\n", dir, err)
	}
	if _, err := e.artisan(ctx, "migrate", "--force"); err != nil {
		return err
	}
	if _, err := e.cmd(ctx, "systemctl", "start", "itso.target"); err != nil {
		return err
	}
	started = true
	for _, args := range [][]string{{"itso:reconcile"}, {"itso:dr-restore", "--start"}, {"up"}} {
		if _, err := e.artisan(ctx, args...); err != nil {
			return fmt.Errorf("artisan %s: %w", args[0], err)
		}
	}
	e.printf("Khôi phục panel xong (%d file cấu hình). Đăng nhập bằng tài khoản cũ; dữ liệu account đang khôi phục nền.\n", len(restored))
	return nil
}

// restoreEtc chép cây etc/itso của backup vào /etc/itso, giữ file của máy mới (keepOnRestore, tls/), thay APP_KEY.
func (e *Env) restoreEtc(src, appKey string) ([]string, error) {
	var files []string
	var walk func(rel string) error
	walk = func(rel string) error {
		names, err := e.FS.ReadDir(src + rel)
		if err != nil {
			return err
		}
		for _, n := range names {
			p := rel + "/" + n
			fi, err := e.FS.Lstat(src + p)
			if err != nil {
				return err
			}
			switch {
			case fi.IsDir():
				if err := walk(p); err != nil {
					return err
				}
			case fi.Mode().IsRegular():
				files = append(files, strings.TrimPrefix(p, "/"))
			}
		}
		return nil
	}
	if err := walk(""); err != nil {
		return nil, err
	}
	sort.Strings(files)
	var done []string
	group := e.rootGroup("itso")
	for _, f := range files {
		if keepOnRestore[f] || strings.HasPrefix(f, "tls/") {
			continue
		}
		b, err := e.FS.ReadFile(src + "/" + f)
		if err != nil {
			return nil, err
		}
		dst := EtcDir + "/" + f
		mode := fs.FileMode(0o640)
		if fi, err := e.FS.Lstat(dst); err == nil && fi.Mode().IsRegular() {
			mode = fi.Mode().Perm()
		}
		if err := e.FS.MkdirAll(dirOf(dst)); err != nil {
			return nil, err
		}
		if _, err := e.FS.WriteAtomic(dst, b, mode, group); err != nil {
			return nil, err
		}
		done = append(done, f)
	}
	cur := e.readFile(EnvFile)
	if !appKeyRe.MatchString(cur) {
		return nil, fmt.Errorf("%s không có APP_KEY để thay", EnvFile)
	}
	mode := fs.FileMode(0o640)
	if fi, err := e.FS.Lstat(EnvFile); err == nil {
		mode = fi.Mode().Perm()
	}
	if _, err := e.FS.WriteAtomic(EnvFile, []byte(appKeyRe.ReplaceAllLiteralString(cur, appKey)), mode, group); err != nil {
		return nil, err
	}
	return append(done, "itso.env (APP_KEY)"), nil
}
