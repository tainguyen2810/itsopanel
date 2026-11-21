package ops_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/policy"
	"itso.local/agent/internal/registry"
)

var bkNow = time.Date(2026, 11, 21, 3, 4, 5, 0, time.UTC)

const bkTS = "20261121-030405"

func restoreParams(repo map[string]any, sid, mode string, items ...map[string]any) map[string]any {
	its := make([]any, len(items))
	for i, it := range items {
		its[i] = it
	}
	return map[string]any{"repo": repo, "snapshot_id": sid, "restore_uuid": "0193dd10-0001-7000-8000-000000000005",
		"account": acct(), "mode": mode, "items": its, "pre_restore_tags": []any{"manual"}}
}

// bkSetup: site có index.php, file setuid, symlink ra ngoài; backup files → snapshot id.
func bkSetup(t *testing.T) (*env, map[string]any, string, string) {
	t.Helper()
	needRestic(t)
	e := dataEnv(t)
	e.d.Sandbox = true
	e.d.Now = func() time.Time { return bkNow }
	home := filepath.Join(e.fs.Root, "home/anphat")
	write(t, home, "sites/anphat.vn/public/index.php", "<?php echo 'v1';")
	write(t, home, "sites/anphat.vn/public/css/app.css", "body{}")
	write(t, home, "sites/anphat.vn/public/suid", "binary\n")
	if err := os.Chmod(filepath.Join(home, "sites/anphat.vn/public/suid"), os.ModeSetuid|0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/shadow", filepath.Join(home, "sites/anphat.vn/public/evil")); err != nil {
		t.Fatal(err)
	}
	repo := bkRepoParams(localDest(), bkAcct, bkPass)
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	sid := e.h.OK(contracts.OpBackupRun, bkRun(repo, "files", acct(), nil))["snapshot_id"].(string)
	return e, repo, sid, home
}

func TestBackupRestoreFilesNew(t *testing.T) {
	e, repo, sid, home := bkSetup(t)
	res := e.h.OK(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "files", "path": "sites/anphat.vn/public"}))
	target := "backups/restore-" + bkTS
	if p := res["restored_paths"].([]any); len(p) != 1 || p[0] != target {
		t.Fatal(res)
	}
	got, err := os.ReadFile(filepath.Join(home, target, "sites/anphat.vn/public/index.php"))
	if err != nil || string(got) != "<?php echo 'v1';" {
		t.Fatal("nội dung khôi phục phải khớp", string(got), err)
	}
	skipped := map[string]string{}
	for _, s := range res["skipped"].([]any) {
		m := s.(map[string]any)
		skipped[m["path"].(string)] = m["reason"].(string)
	}
	if skipped[target+"/sites/anphat.vn/public/evil"] != "symlink" || skipped[target+"/sites/anphat.vn/public/suid"] != "setuid" {
		t.Fatal("symlink bị bỏ, setuid bị gỡ và báo cáo", skipped)
	}
	if _, err := os.Lstat(filepath.Join(home, target, "sites/anphat.vn/public/evil")); !os.IsNotExist(err) {
		t.Fatal("không được tạo symlink khi khôi phục", err)
	}
	st, err := os.Stat(filepath.Join(home, target, "sites/anphat.vn/public/suid"))
	if err != nil || st.Mode()&os.ModeSetuid != 0 || st.Mode().Perm() != 0o755 {
		t.Fatal("bit setuid phải bị gỡ", st.Mode(), err)
	}
	helperAsAcct := false
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "[uid=20001] itso-fs-helper") {
			helperAsAcct = true
		}
	}
	if !helperAsAcct {
		t.Fatal("giải tar vào home phải qua helper chạy dưới uid account", e.fake.Lines())
	}
	if entries, _ := os.ReadDir(filepath.Join(e.fs.Root, "var/lib/itso/restore")); len(entries) != 0 {
		t.Fatal("staging phải được dọn", entries)
	}
	// Chạy lại cùng thời điểm: đích đã tồn tại → không ghi đè.
	e.h.Fail(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "files", "path": "sites"}), "already_exists")
}

// Symlink đặt sẵn tại đích (backups/restore-<ts> → thư mục ngoài home): không ghi xuyên qua.
func TestBackupRestoreSymlinkAtTarget(t *testing.T) {
	e, repo, sid, home := bkSetup(t)
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "backups/restore-"+bkTS)); err != nil {
		t.Fatal(err)
	}
	res := e.h.Call(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "files", "path": "sites"}))
	if res.OK {
		t.Fatal("phải từ chối khi đích là symlink có sẵn")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("đã ghi xuyên symlink ra ngoài home", entries)
	}
	// Thư mục cha là symlink ra ngoài cũng bị chặn.
	_ = os.Remove(filepath.Join(home, "backups/restore-"+bkTS))
	_ = os.Remove(filepath.Join(home, "backups"))
	if err := os.Symlink(outside, filepath.Join(home, "backups")); err != nil {
		t.Fatal(err)
	}
	if res := e.h.Call(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "files", "path": "sites"})); res.OK {
		t.Fatal("thư mục cha symlink phải bị từ chối")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("đã ghi xuyên symlink cha", entries)
	}
}

func TestBackupRestoreWebsiteOverwrite(t *testing.T) {
	e, repo, sid, home := bkSetup(t)
	idx := filepath.Join(home, "sites/anphat.vn/public/index.php")
	write(t, home, "sites/anphat.vn/public/index.php", "<?php echo 'hacked';")
	write(t, home, "sites/anphat.vn/public/shell.php", "<?php system($_GET['c']);")
	res := e.h.OK(contracts.OpBackupRestore, restoreParams(repo, sid, "overwrite", map[string]any{"kind": "website", "site_dir": "anphat.vn"}))
	if b, _ := os.ReadFile(idx); string(b) != "<?php echo 'v1';" {
		t.Fatal("website phải về bản snapshot", string(b))
	}
	if _, err := os.Stat(filepath.Join(home, "sites/anphat.vn/public/shell.php")); !os.IsNotExist(err) {
		t.Fatal("file lạ sau snapshot phải biến mất khỏi bản đang chạy", err)
	}
	if b, _ := os.ReadFile(filepath.Join(home, "sites/anphat.vn.restore-"+bkTS, "public/shell.php")); !strings.Contains(string(b), "system") {
		t.Fatal("bản cũ được giữ cạnh bên (đổi chỗ nguyên tử)")
	}
	pre, _ := res["pre_restore_snapshot_id"].(string)
	if len(pre) != 64 {
		t.Fatal("ghi đè phải tạo snapshot pre-restore", res)
	}
	snaps := e.h.OK(contracts.OpBackupSnapshots, map[string]any{"repo": repo, "tags": []any{"pre-restore"}, "limit": 10})["snapshots"].([]any)
	if len(snaps) != 1 || snaps[0].(map[string]any)["id"] != pre || snaps[0].(map[string]any)["hostname"] != bkServer {
		t.Fatal(snaps)
	}
	// Bản new giải cạnh bên (.restore-<ts> mới), không đụng bản đang chạy.
	e.d.Now = func() time.Time { return bkNow.Add(time.Hour) }
	write(t, home, "sites/anphat.vn/public/index.php", "<?php echo 'v2';")
	res = e.h.OK(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "website", "site_dir": "anphat.vn"}))
	if p := res["restored_paths"].([]any); len(p) != 1 || p[0] != "sites/anphat.vn.restore-20261121-040405" {
		t.Fatal(res)
	}
	if b, _ := os.ReadFile(idx); string(b) != "<?php echo 'v2';" {
		t.Fatal("chế độ new không được đụng bản đang chạy")
	}
}

func TestBackupRestoreDatabase(t *testing.T) {
	needRestic(t)
	e := dataEnv(t)
	e.d.Sandbox = true
	repo := bkRepoParams(localDest(), bkAcct, bkPass)
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	e.h.OK("db.mysql.owner_ensure", map[string]any{"account": acct()})
	e.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"})
	db := map[string]any{"engine": "mariadb", "name": "anphat_shop"}
	sid := e.h.OK(contracts.OpBackupRun, bkRun(repo, "db", acct(), map[string]any{"databases": []any{db}}))["snapshot_id"].(string)

	res := e.h.OK(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "database", "db": db, "target_name": "anphat_shop2"}))
	if d := res["databases"].([]any); len(d) != 1 || d[0] != "anphat_shop2" {
		t.Fatal(res)
	}
	// Bản new vào DB đã có → already_exists; target_name = tên gốc ở chế độ new → invalid.
	e.h.Fail(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "database", "db": db, "target_name": "anphat_shop2"}), "already_exists")
	e.h.Fail(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "database", "db": db, "target_name": "anphat_shop"}), "invalid_params")
	// DB của account khác → bị chặn.
	e.h.Fail(contracts.OpBackupRestore, restoreParams(repo, sid, "new", map[string]any{"kind": "database", "db": db, "target_name": "other_x"}), "invalid_params")

	e.fake.Reset()
	res = e.h.OK(contracts.OpBackupRestore, restoreParams(repo, sid, "overwrite", map[string]any{"kind": "database", "db": db, "target_name": "anphat_shop"}))
	if pre, _ := res["pre_restore_snapshot_id"].(string); len(pre) != 64 {
		t.Fatal("ghi đè DB phải tạo snapshot pre-restore", res)
	}
	asAcct := false
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "[uid=20001] mariadb ") && strings.HasSuffix(l, " anphat_shop") {
			asAcct = true
		}
	}
	if !asAcct {
		t.Fatal("nhập dump phải chạy dưới uid account", e.fake.Lines())
	}

	// restore_test: dump khớp sha256 và nạp được vào DB tạm.
	rt := e.h.OK(contracts.OpBackupRestoreTest, map[string]any{"repo": repo, "snapshot_id": sid, "sample_files": 10, "databases": []any{db}})
	if rt["ok"] != true || rt["databases_ok"] != float64(1) {
		t.Fatal(rt)
	}
}

func TestBackupCheckRestoreTestForget(t *testing.T) {
	e, repo, sid, _ := bkSetup(t)
	if c := e.h.OK(contracts.OpBackupCheck, map[string]any{"repo": repo, "read_data_percent": 100}); c["ok"] != true {
		t.Fatal(c)
	}
	rt := e.h.OK(contracts.OpBackupRestoreTest, map[string]any{"repo": repo, "snapshot_id": sid, "sample_files": 50, "databases": []any{}})
	if rt["ok"] != true || rt["verified_files"].(float64) < 2 || len(rt["mismatches"].([]any)) != 0 {
		t.Fatal(rt)
	}
	// Hỏng dữ liệu: ghi đè một pack → check báo lỗi, restore_test không ra ok.
	packs, _ := filepath.Glob(filepath.Join(e.fs.Root, "var/backups/itso/repos/itso", bkServer, "acct-"+bkAcct, "data/*/*"))
	if len(packs) == 0 {
		t.Fatal("không thấy pack")
	}
	for _, p := range packs {
		b, _ := os.ReadFile(p)
		for i := 64; i < len(b)-64; i += 97 {
			b[i] ^= 0xff
		}
		_ = os.Chmod(p, 0o600)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if c := e.h.OK(contracts.OpBackupCheck, map[string]any{"repo": repo, "read_data_percent": 100}); c["ok"] != false || len(c["errors"].([]any)) == 0 {
		t.Fatal("check phải phát hiện pack hỏng", c)
	}
	res := e.h.Call(contracts.OpBackupRestoreTest, map[string]any{"repo": repo, "snapshot_id": sid, "sample_files": 50, "databases": []any{}})
	if res.OK && res.Data["ok"] == true {
		t.Fatal("restore_test không được báo ok trên repo hỏng", res.Data)
	}
}

func TestBackupForgetDisabledByDefault(t *testing.T) {
	e := dataEnv(t)
	p, err := policy.Default()
	if err != nil {
		t.Fatal(err)
	}
	r := registry.New(ops.Version)
	r.SetAllow(p.Enabled) // policy mặc định: backup_forget=off
	if err := ops.Register(r, e.d); err != nil {
		t.Fatal(err)
	}
	ct.New(t, r).Fail(contracts.OpBackupForget, map[string]any{"repo": bkRepoParams(localDest(), bkAcct, bkPass),
		"snapshot_ids": []any{strings.Repeat("a", 64)}, "prune": true}, "op_disabled")
}

func TestBackupPanelAgeAndKit(t *testing.T) {
	needRestic(t)
	e := dataEnv(t)
	e.d.Sandbox = true
	write(t, e.fs.Root, "/etc/passwd", e.file("/etc/passwd")+"postgres:x:114:121::/var/lib/postgresql:/bin/bash\n")
	write(t, e.fs.Root, "/etc/itso/env", "APP_KEY=base64:secret\n")
	write(t, e.fs.Root, "/etc/itso/agent/hmac.key", "hmac-secret")
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	repo := bkRepoParams(localDest(), "", bkPass)
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	// Thiếu age_recipient với panel → invalid; age_recipient cho files → invalid.
	e.h.Fail(contracts.OpBackupRun, bkRun(repo, "panel", nil, nil), "invalid_params")
	e.fake.Reset()
	run := e.h.OK(contracts.OpBackupRun, bkRun(repo, "panel", nil, map[string]any{"age_recipient": id.Recipient().String()}))
	sid := run["snapshot_id"].(string)
	dumpAsPG := false
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "[uid=114] pg_dump --cluster 16/itso -Fc itso") {
			dumpAsPG = true
		}
	}
	if !dumpAsPG {
		t.Fatal("pg_dump panel chạy dưới user postgres trên cluster 16/itso", e.fake.Lines())
	}
	// Bản rõ không nằm trong repo: tìm chuỗi bí mật trong mọi file repo (restic đã mã hóa, age mã hóa thêm lớp nữa).
	_ = filepath.WalkDir(filepath.Join(e.fs.Root, "var/lib/itso/restore"), func(p string, de os.DirEntry, err error) error {
		if err == nil && !de.IsDir() {
			t.Fatal("staging panel phải được dọn: " + p)
		}
		return nil
	})
	rt := e.h.OK(contracts.OpBackupRestoreTest, map[string]any{"repo": repo, "snapshot_id": sid, "sample_files": 5, "databases": []any{}})
	if rt["ok"] != true || rt["verified_files"] != float64(1) {
		t.Fatal("restore_test kiểm sha256 file .age", rt)
	}

	kitText := strings.Join([]string{
		"# ITSO Panel recovery kit",
		"destination: Local (local)",
		"destination_uuid: " + bkDest,
		"repositories:",
		"- Server",
		"  repo: itso/" + bkServer + "/server",
		"  password: " + bkPass,
		"panel_public_key: " + id.Recipient().String(),
		"panel_private_key: " + id.String(), ""}, "\n")
	kit, err := backup.ParseKit(kitText)
	if err != nil || kit.DestinationUUID != bkDest || len(kit.Repos) != 1 || kit.PrivateKey != id.String() {
		t.Fatal(kit, err)
	}
	dst := filepath.Join(t.TempDir(), "out")
	names, err := e.d.KitPanelRestore(context.Background(), kit, ops.KitCreds{}, sid, dst)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, ",") != "itso.dump,etc/itso/agent/hmac.key,etc/itso/env" {
		t.Fatal(names)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "etc/itso/env")); string(b) != "APP_KEY=base64:secret\n" {
		t.Fatal(string(b))
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "itso.dump")); !bytes.HasPrefix(b, []byte("PGDMP")) {
		t.Fatal(string(b))
	}
	// Khóa riêng sai → repo_auth_failed, không ghi gì.
	other, _ := age.GenerateX25519Identity()
	kit.PrivateKey = other.String()
	if _, err := e.d.KitPanelRestore(context.Background(), kit, ops.KitCreds{}, sid, filepath.Join(t.TempDir(), "x")); err == nil ||
		!strings.Contains(err.Error(), "khóa riêng") {
		t.Fatal("khóa riêng sai phải bị từ chối", err)
	}

	// Prune bằng bộ khôi phục: keep-last 1 trên 2 snapshot panel → xóa 1 (kèm meta), giữ 1.
	e.h.OK(contracts.OpBackupRun, bkRun(repo, "panel", nil, map[string]any{"age_recipient": id.Recipient().String()}))
	var out bytes.Buffer
	if err := e.d.KitPrune(context.Background(), kit, ops.KitCreds{}, ops.KeepPolicy{Last: 1}, true, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "giữ 1, sẽ xóa 2 snapshot") {
		t.Fatal("dry-run: 1 snapshot + 1 meta đi kèm", out.String())
	}
	out.Reset()
	if err := e.d.KitPrune(context.Background(), kit, ops.KitCreds{}, ops.KeepPolicy{Last: 1}, false, &out); err != nil {
		t.Fatal(err)
	}
	snaps := e.h.OK(contracts.OpBackupSnapshots, map[string]any{"repo": repo, "tags": []any{}, "limit": 10})["snapshots"].([]any)
	if len(snaps) != 1 || snaps[0].(map[string]any)["id"] == sid {
		t.Fatal("còn đúng snapshot mới nhất", snaps, out.String())
	}
	if err := e.d.KitPrune(context.Background(), kit, ops.KitCreds{}, ops.KeepPolicy{}, true, &out); err == nil {
		t.Fatal("không có --keep-* phải lỗi")
	}
}

func TestKitCredsAndDestination(t *testing.T) {
	c, err := ops.ReadKitCreds("s3", strings.NewReader("AKIAEXAMPLE\nsecretKEY\n"))
	if err != nil || c.AccessKeyID != "AKIAEXAMPLE" || c.SecretAccessKey != "secretKEY" {
		t.Fatal(c, err)
	}
	if _, err := ops.ReadKitCreds("s3", strings.NewReader("only-one\n")); err == nil {
		t.Fatal("s3 cần 2 dòng")
	}
	if c, err := ops.ReadKitCreds("local", strings.NewReader("ignored")); err != nil || c.AccessKeyID != "" || c.Password != "" {
		t.Fatal(c, err)
	}
	k := backup.Kit{DestType: "sftp", DestinationUUID: bkDest, Config: map[string]string{"host": "backup2.itso.local", "port": "22",
		"user": "itso-backup", "path": "/srv/backup", "evil": "x"}}
	raw, err := ops.KitDestination(k, ops.KitCreds{})
	if err != nil {
		t.Fatal(err)
	}
	d, err := backup.ParseDest(raw)
	if err != nil || d.Port != 22 || d.Host != "backup2.itso.local" {
		t.Fatal(d, err)
	}
	k.Config["port"] = "22; rm"
	if _, err := ops.KitDestination(k, ops.KitCreds{}); err == nil {
		t.Fatal("port lạ phải bị từ chối")
	}
}

func TestBackupFileRead(t *testing.T) {
	e, repo, sid, _ := bkSetup(t)
	big := strings.Repeat("0123456789abcdef", 300000) // 4,8 MB
	write(t, filepath.Join(e.fs.Root, "home/anphat"), "sites/anphat.vn/public/big.bin", big)
	sid2 := e.h.OK(contracts.OpBackupRun, bkRun(repo, "files", acct(), nil))["snapshot_id"].(string)
	read := func(snap, p string, off, n int) map[string]any {
		return e.h.OK(contracts.OpBackupFileRead, map[string]any{"repo": repo, "snapshot_id": snap, "path": p, "offset": off, "max_bytes": n})
	}
	r := read(sid, "sites/anphat.vn/public/index.php", 0, 1<<20)
	if b, _ := base64.StdEncoding.DecodeString(r["content_b64"].(string)); string(b) != "<?php echo 'v1';" || r["eof"] != true {
		t.Fatal(r)
	}
	var got []byte
	for off := 0; ; {
		r := read(sid2, "sites/anphat.vn/public/big.bin", off, 2<<20)
		b, _ := base64.StdEncoding.DecodeString(r["content_b64"].(string))
		got = append(got, b...)
		off += len(b)
		if r["eof"] == true {
			break
		}
	}
	if string(got) != big {
		t.Fatalf("ghép khúc phải ra đúng file: %d/%d", len(got), len(big))
	}
	e.h.Fail(contracts.OpBackupFileRead, map[string]any{"repo": repo, "snapshot_id": sid, "path": "sites/anphat.vn/public/evil", "offset": 0, "max_bytes": 10}, "precondition_failed")
	e.h.Fail(contracts.OpBackupFileRead, map[string]any{"repo": repo, "snapshot_id": sid, "path": "sites/anphat.vn/public", "offset": 0, "max_bytes": 10}, "precondition_failed")
	e.h.Fail(contracts.OpBackupFileRead, map[string]any{"repo": repo, "snapshot_id": sid, "path": "sites/nope.txt", "offset": 0, "max_bytes": 10}, "not_found")
	e.h.Fail(contracts.OpBackupFileRead, map[string]any{"repo": repo, "snapshot_id": sid, "path": "../etc/shadow", "offset": 0, "max_bytes": 10}, "invalid_params")
}
