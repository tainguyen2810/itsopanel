package ops_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/platform"
)

const (
	bkServer = "0193aa10-0001-7000-8000-000000000001"
	bkAcct   = "01938a01-0003-7000-8000-000000000020"
	bkOther  = "01938a01-0003-7000-8000-000000000021"
	bkDest   = "0193bb10-0001-7000-8000-000000000003"
	bkRepo   = "0193cc10-0001-7000-8000-000000000004"
	bkPass   = "Rk7-panel-9fQ2-xV4m-T8sL"
)

func bkRepoParams(dest map[string]any, account, pass string) map[string]any {
	p := "itso/" + bkServer + "/server"
	if account != "" {
		p = "itso/" + bkServer + "/acct-" + account
	}
	return map[string]any{"repo_uuid": bkRepo, "path": p, "destination": dest, "password": pass}
}

func localDest() map[string]any { return map[string]any{"type": "local", "destination_uuid": bkDest} }

func bkRun(repo map[string]any, kind string, account any, extra map[string]any) map[string]any {
	var acctUUID any
	if account != nil {
		acctUUID = bkAcct
	}
	p := map[string]any{"repo": repo, "kind": kind, "account": account, "website_uuid": nil, "site_dir": nil,
		"databases": []any{}, "excludes": []any{}, "tags": []any{"manual"}, "age_recipient": nil,
		"meta": map[string]any{"panel_version": "0.1.0-alpha", "server_uuid": bkServer, "account_uuid": acctUUID, "package": "Business"}}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func needRestic(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("/usr/bin/restic"); err != nil {
		t.Skip("cần restic thật (/usr/bin/restic) — CI cài gói restic; máy dev thiếu thì bỏ qua")
	}
}

// restic thật trên repo local dưới gốc sandbox: init → backup files/db → snapshots → browse → stats.
func TestBackupRealRestic(t *testing.T) {
	needRestic(t)
	e := dataEnv(t)
	e.d.Sandbox = true
	home := filepath.Join(e.fs.Root, "home/anphat")
	write(t, home, "sites/anphat.vn/public/index.php", "<?php echo 'anphat';")
	write(t, home, "tmp/sess_abc", "session")
	write(t, home, ".cache/x", "cache")
	write(t, home, "sites/anphat.vn/public/app.log", "log")
	if err := os.Symlink("/etc/shadow", filepath.Join(home, "sites/anphat.vn/public/evil")); err != nil {
		t.Fatal(err)
	}
	repo := bkRepoParams(localDest(), bkAcct, bkPass)
	if d := e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo}); d["already_existed"] != false {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo}); d["already_existed"] != true {
		t.Fatal("init lần 2 phải idempotent", d)
	}
	st, err := os.Stat(filepath.Join(e.fs.Root, "var/backups/itso/repos"))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatal("thư mục repo local phải 0700", err)
	}
	run := e.h.OK(contracts.OpBackupRun, bkRun(repo, "files", acct(), map[string]any{"excludes": []any{"*.log"}}))
	sid := run["snapshot_id"].(string)
	if len(sid) != 64 || run["manifest_sha256"] == "" {
		t.Fatal(run)
	}
	if entries, _ := os.ReadDir(filepath.Join(e.fs.Root, "run/itso/backup")); len(entries) != 0 {
		t.Fatal("thư mục bí mật của op phải bị xóa sau khi xong", entries)
	}

	// db: dump dưới uid account → --stdin
	e.h.OK("db.mysql.owner_ensure", map[string]any{"account": acct()})
	e.h.OK("db.mysql.create", map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"})
	e.fake.Reset()
	dbRun := e.h.OK(contracts.OpBackupRun, bkRun(repo, "db", acct(), map[string]any{
		"databases": []any{map[string]any{"engine": "mariadb", "name": "anphat_shop"}}}))
	dumpAsAccount := false
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "[uid=20001] mariadb-dump --user=anphat --single-transaction") && strings.Contains(l, "--hex-blob") {
			dumpAsAccount = true
		}
		if strings.Contains(l, bkPass) {
			t.Fatal("mật khẩu repo lộ trong argv: " + l)
		}
	}
	if !dumpAsAccount {
		t.Fatal("dump phải chạy dưới uid account", e.fake.Lines())
	}

	snaps := e.h.OK(contracts.OpBackupSnapshots, map[string]any{"repo": repo, "tags": []any{}, "limit": 10})["snapshots"].([]any)
	if len(snaps) != 2 {
		t.Fatalf("2 snapshot (snapshot meta bị ẩn), nhận %v", snaps)
	}
	files := e.h.OK(contracts.OpBackupSnapshots, map[string]any{"repo": repo, "tags": []any{"type:files"}, "limit": 10})["snapshots"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["id"] != sid || files[0].(map[string]any)["hostname"] != bkServer {
		t.Fatal(files)
	}
	_ = dbRun

	root := e.h.OK(contracts.OpBackupBrowse, map[string]any{"repo": repo, "snapshot_id": sid, "path": ".", "limit": 100})
	names := map[string]string{}
	for _, it := range root["entries"].([]any) {
		m := it.(map[string]any)
		names[m["name"].(string)] = m["type"].(string)
	}
	if names["sites"] != "dir" || names["tmp"] != "" || names[".cache"] != "" {
		t.Fatalf("gốc snapshot là home, tmp/.cache bị loại: %v", names)
	}
	pub := e.h.OK(contracts.OpBackupBrowse, map[string]any{"repo": repo, "snapshot_id": sid, "path": "sites/anphat.vn/public", "limit": 100})
	got := map[string]map[string]any{}
	for _, it := range pub["entries"].([]any) {
		m := it.(map[string]any)
		got[m["name"].(string)] = m
	}
	if got["index.php"]["type"] != "file" || got["index.php"]["path"] != "sites/anphat.vn/public/index.php" {
		t.Fatal(got)
	}
	if got["evil"]["type"] != "symlink" || got["evil"]["size"] != float64(0) {
		t.Fatal("symlink phải được lưu như symlink (không theo tới /etc/shadow)", got["evil"])
	}
	if _, ok := got["app.log"]; ok {
		t.Fatal("mẫu loại trừ *.log của policy phải có tác dụng")
	}
	page := e.h.OK(contracts.OpBackupBrowse, map[string]any{"repo": repo, "snapshot_id": sid, "path": "sites/anphat.vn/public", "limit": 1})
	if page["truncated"] != true || len(page["entries"].([]any)) != 1 {
		t.Fatal(page)
	}
	stats := e.h.OK(contracts.OpBackupStats, map[string]any{"repo": repo})
	if stats["raw_size_bytes"].(float64) <= 0 || stats["snapshots"].(float64) < 2 {
		t.Fatal(stats)
	}

	// Sai mật khẩu → repo_auth_failed; repo chưa init → repo_not_initialized.
	e.h.Fail(contracts.OpBackupSnapshots, map[string]any{"repo": bkRepoParams(localDest(), bkAcct, "Wrong-password-123456"), "tags": []any{}, "limit": 10}, "repo_auth_failed")
	other := bkRepoParams(localDest(), bkOther, bkPass)
	e.h.Fail(contracts.OpBackupSnapshots, map[string]any{"repo": other, "tags": []any{}, "limit": 10}, "repo_not_initialized")
}

// Tham số độc bị từ chối trước khi chạy restic.
func TestBackupRejectsEvilParams(t *testing.T) {
	e := dataEnv(t)
	e.d.Sandbox = true
	repo := bkRepoParams(localDest(), bkAcct, bkPass)
	evilRepo := bkRepoParams(localDest(), bkAcct, bkPass)
	evilRepo["path"] = "itso/" + bkServer + "/../../etc"
	e.h.Fail(contracts.OpBackupRepoInit, map[string]any{"repo": evilRepo}, "invalid_params")
	e.h.Fail(contracts.OpBackupBrowse, map[string]any{"repo": repo, "snapshot_id": "latest", "path": ".", "limit": 10}, "invalid_params")
	e.h.Fail(contracts.OpBackupBrowse, map[string]any{"repo": repo, "snapshot_id": "4f2a9c1e", "path": "../lehoa", "limit": 10}, "invalid_params")
	e.h.Fail(contracts.OpBackupRun, bkRun(repo, "files", acct(), map[string]any{"tags": []any{"--tag=x"}}), "invalid_params")
	e.h.Fail(contracts.OpBackupRun, bkRun(repo, "files", acct(), map[string]any{"excludes": []any{"/etc/shadow"}}), "invalid_params")
	// repo của account khác (meta.account_uuid khác account trong đường dẫn repo)
	e.h.Fail(contracts.OpBackupRun, bkRun(bkRepoParams(localDest(), bkOther, bkPass), "files", acct(), nil), "invalid_params")
	// config/panel không được ghi vào repo account; files không được ghi vào repo server
	e.h.Fail(contracts.OpBackupRun, bkRun(repo, "config", nil, nil), "invalid_params")
	e.h.Fail(contracts.OpBackupRun, bkRun(bkRepoParams(localDest(), "", bkPass), "files", acct(), nil), "invalid_params")
	// DB của account khác (thiếu tiền tố)
	e.h.Fail(contracts.OpBackupRun, bkRun(repo, "db", acct(), map[string]any{"databases": []any{map[string]any{"engine": "mariadb", "name": "lehoa_main"}}}), "invalid_params")
	sftp := map[string]any{"type": "sftp", "destination_uuid": bkDest, "host": "backup2.itso.local -oProxyCommand=id", "port": 22, "user": "itso", "path": "/srv", "host_key_sha256": nil}
	e.h.Fail(contracts.OpBackupDestinationTest, map[string]any{"destination": sftp}, "invalid_params")
	if len(e.fake.Lines()) > 0 {
		for _, l := range e.fake.Lines() {
			if strings.HasPrefix(l, "restic") {
				t.Fatal("restic không được chạy với tham số độc: " + l)
			}
		}
	}
}

var opDirRe = regexp.MustCompile(`0193a000-0000-7000-8000-[0-9]{12}-1-1`)

// Golden argv ở chế độ máy thật (runner giả): systemd-run trong itso-maint.slice, bí mật chỉ qua file 0600.
func TestBackupGoldenArgvReal(t *testing.T) {
	e := dataEnv(t)
	write(t, filepath.Join(e.fs.Root, "home/anphat"), "sites/anphat.vn/public/index.php", "x")
	var envMode os.FileMode
	var envBody string
	e.fake.StreamHook = func(_ context.Context, p platform.Proc) (int, error) {
		if p.Bin != "systemd-run" {
			return e.sim.Stream(context.Background(), p)
		}
		for _, a := range p.Args {
			if f, ok := strings.CutPrefix(a, "EnvironmentFile="); ok {
				st, _ := os.Stat(f)
				envMode = st.Mode().Perm()
				b, _ := os.ReadFile(f)
				envBody = string(b)
			}
		}
		if p.Stdin != nil {
			_, _ = io.Copy(io.Discard, p.Stdin)
		}
		j := strings.Join(p.Args, " ")
		switch {
		case strings.Contains(j, "/usr/bin/restic cat ") && strings.HasSuffix(j, " config"):
			_, _ = io.WriteString(p.Stderr, "Is there a repository at the following location?")
			return 10, nil
		case strings.Contains(j, " backup "):
			_, _ = io.WriteString(p.Stdout, `{"message_type":"summary","files_new":1,"data_added":10,"total_bytes_processed":1,"total_duration":0.1,"snapshot_id":"a28f8eed43b4fc74842a84137bb3a9855dd7df1bce31f0f0aadf7f0e2b78afd0"}`+"\n")
		}
		return 0, nil
	}
	s3 := map[string]any{"type": "s3", "destination_uuid": bkDest, "endpoint": "https://s3.example.com", "bucket": "itso-backup",
		"region": "ap-southeast-1", "access_key_id": "AKIAITSODEMO", "secret_access_key": "demo-secret-key"}
	repo := bkRepoParams(s3, bkAcct, bkPass)
	e.fake.Reset()
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	e.h.OK(contracts.OpBackupRun, bkRun(repo, "files", acct(), map[string]any{"site_dir": "anphat.vn", "website_uuid": "0193dd10-0001-7000-8000-000000000005"}))
	lines := strings.Join(e.fake.Lines(), "\n") + "\n"
	for _, secret := range []string{bkPass, "demo-secret-key"} {
		if strings.Contains(lines, secret) {
			t.Fatalf("bí mật %q lộ trong argv:\n%s", secret, lines)
		}
	}
	if envMode != 0o600 || !strings.Contains(envBody, "AWS_SECRET_ACCESS_KEY=demo-secret-key") {
		t.Fatalf("EnvironmentFile phải 0600 và chứa credential: %v %q", envMode, envBody)
	}
	norm := strings.ReplaceAll(lines, e.fs.Root, "$ROOT")
	norm = opDirRe.ReplaceAllString(norm, "$$OP")
	golden(t, "backup.s3.argv", norm)
}

// SFTP: lần kiểm tra đầu sinh khóa ed25519 0600, ghim host key; run trước khi kiểm tra bị từ chối.
func TestBackupSFTPKeyAndPrecondition(t *testing.T) {
	e := dataEnv(t)
	e.d.Sandbox = true
	sftp := map[string]any{"type": "sftp", "destination_uuid": bkDest, "host": "backup2.itso.local", "port": 22, "user": "itso-backup",
		"path": "/srv/backup", "host_key_sha256": nil}
	e.d.Sandbox = false
	e.h.Fail(contracts.OpBackupRepoInit, map[string]any{"repo": bkRepoParams(sftp, bkAcct, bkPass)}, "precondition_failed")
	e.d.Sandbox = true
	d := e.h.OK(contracts.OpBackupDestinationTest, map[string]any{"destination": sftp})
	if d["ok"] != true || !strings.HasPrefix(d["ssh_public_key"].(string), "ssh-ed25519 ") || !strings.HasPrefix(d["host_key_sha256"].(string), "SHA256:") {
		t.Fatal(d)
	}
	st, err := os.Stat(filepath.Join(e.fs.Root, "etc/itso/backup/keys", bkDest))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatal("khóa riêng SFTP phải 0600", err)
	}
	again := e.h.OK(contracts.OpBackupDestinationTest, map[string]any{"destination": sftp})
	if again["ssh_public_key"] != d["ssh_public_key"] {
		t.Fatal("kiểm tra lại không được sinh khóa mới")
	}
	sftp["host_key_sha256"] = "SHA256:" + strings.Repeat("B", 43)
	bad := e.h.OK(contracts.OpBackupDestinationTest, map[string]any{"destination": sftp})
	if bad["ok"] != false || !strings.HasPrefix(*strPtr(bad["error"]), "host_key_mismatch") {
		t.Fatal(bad)
	}
	_ = ct.Now
}

func strPtr(v any) *string {
	s, _ := v.(string)
	return &s
}
