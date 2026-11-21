package ops_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

const pw = "S3cret.Pass-word"

func acct() map[string]any { return ct.Acct("anphat", 20001) }

func dataEnv(t *testing.T) *env {
	e := newEnv(t)
	e.site("anphat", 20001, "anphat.vn")
	return e
}

// ---------- Database ----------

func TestDBLifecycle(t *testing.T) {
	for _, eng := range []string{"mysql", "pg"} {
		t.Run(eng, func(t *testing.T) {
			e := dataEnv(t)
			if eng == "pg" {
				write(t, e.fs.Root, "/etc/passwd", e.file("/etc/passwd")+"postgres:x:114:121::/var/lib/postgresql:/bin/bash\n")
			}
			op := func(s string) string { return "db." + eng + "." + s }
			if d := e.h.OK(op("owner_ensure"), map[string]any{"account": acct()}); d["created"] != true {
				t.Fatal(d)
			}
			if d := e.h.OK(op("create"), map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"}); d["created"] != true {
				t.Fatal(d)
			}
			if d := e.h.OK(op("create"), map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf8mb4"}); d["created"] != false {
				t.Fatal("create lần 2 phải idempotent", d)
			}
			e.fake.Reset()
			d := e.h.OK(op("user_ensure"), map[string]any{"account": acct(), "username": "anphat_app", "password": pw, "host": "localhost", "max_connections": 10})
			if d["created"] != true {
				t.Fatal(d)
			}
			for _, l := range e.fake.Lines() { // mật khẩu chỉ đi qua stdin, không bao giờ nằm trong argv
				if strings.Contains(l, pw) {
					t.Fatalf("mật khẩu lộ trong argv: %s", l)
				}
			}
			e.h.OK(op("grant"), map[string]any{"account": acct(), "username": "anphat_app", "database": "anphat_shop", "privileges": []any{"SELECT", "INSERT"}})
			ins := e.h.OK(op("inspect"), map[string]any{"account": acct()})
			if dbs := ins["databases"].([]any); len(dbs) != 1 || dbs[0].(map[string]any)["name"] != "anphat_shop" {
				t.Fatal(ins)
			}
			if us := ins["users"].([]any); len(us) != 1 || us[0] != "anphat_app" {
				t.Fatal(ins)
			}
			// Import từ file trong home (helper cat dưới uid account) rồi dump ra file mới.
			e.h.OK(contracts.OpFsWrite, map[string]any{"account": acct(), "path": "dump.sql", "content_b64": base64.StdEncoding.EncodeToString([]byte("CREATE TABLE t(id int);\n"))})
			if d := e.h.OK(op("import"), map[string]any{"account": acct(), "name": "anphat_shop", "source": "dump.sql"}); d["bytes"] != float64(24) {
				t.Fatal(d)
			}
			e.h.OK(contracts.OpFsMkdir, map[string]any{"account": acct(), "path": "backup", "mode": "0750"})
			e.h.OK(op("dump"), map[string]any{"account": acct(), "name": "anphat_shop", "target": "backup/shop.sql", "compress": false})
			if got := e.file("/home/anphat/backup/shop.sql"); !strings.Contains(got, "CREATE TABLE t(id int);") {
				t.Fatalf("dump không chứa dữ liệu đã import: %q", got)
			}
			// Dump DB không tồn tại: không để lại file rác.
			e.failAny(op("dump"), map[string]any{"account": acct(), "name": "anphat_none", "target": "backup/none.sql", "compress": false})
			if e.exists("/home/anphat/backup/none.sql") {
				t.Fatal("dump lỗi phải xóa file đích")
			}
			if d := e.h.OK(op("lock"), map[string]any{"account": acct(), "locked": true}); d["changed"].(float64) < 1 {
				t.Fatal(d)
			}
			e.h.OK(op("user_drop"), map[string]any{"account": acct(), "username": "anphat_app"})
			e.h.OK(op("drop"), map[string]any{"account": acct(), "name": "anphat_shop", "confirm_name": "anphat_shop"})
			ins = e.h.OK(op("inspect"), map[string]any{"account": acct()})
			if len(ins["databases"].([]any)) != 0 || len(ins["users"].([]any)) != 0 {
				t.Fatal(ins)
			}
		})
	}
}

func TestDBRejectsInjection(t *testing.T) {
	e := dataEnv(t)
	for _, name := range []string{"other_shop", "anphat_", "mysql", "anphat_x;drop", "anphat_`x`", "Anphat_shop"} {
		res := e.h.Call(contracts.OpDBMysqlCreate, map[string]any{"account": acct(), "name": name, "charset": "utf8mb4"})
		if res.OK || res.Error.Code != "invalid_params" {
			t.Fatalf("tên %q phải bị từ chối: %+v", name, res)
		}
	}
	for _, p := range []string{"short", "has'quote-123456", `back\slash12345`, "space in pass 123"} {
		res := e.h.Call(contracts.OpDBMysqlUserEnsure, map[string]any{"account": acct(), "username": "anphat_app", "password": p, "host": "localhost", "max_connections": 5})
		if res.OK || res.Error.Code != "invalid_params" {
			t.Fatalf("mật khẩu %q phải bị từ chối: %+v", p, res)
		}
	}
	e.h.Fail(contracts.OpDBMysqlCreate, map[string]any{"account": acct(), "name": "anphat_shop", "charset": "utf16"}, "invalid_params")
	e.h.Fail(contracts.OpDBMysqlDrop, map[string]any{"account": acct(), "name": "anphat_shop", "confirm_name": "anphat_shp"}, "invalid_params")
	e.h.Fail(contracts.OpDBMysqlGrant, map[string]any{"account": acct(), "username": "anphat_app", "database": "anphat_shop", "privileges": []any{"SUPER"}}, "invalid_params")
}

func TestDBSQLGolden(t *testing.T) {
	var b strings.Builder
	for i, eng := range []string{"mysql", "pg"} {
		e := ops.EngMySQL
		if i == 1 {
			e = ops.EngPG
		}
		b.WriteString("== " + eng + " owner\n" + ops.OwnerSQL(e, "anphat"))
		b.WriteString("== " + eng + " create\n" + ops.CreateSQL(e, "anphat", "anphat_shop", "utf8mb4"))
		b.WriteString("== " + eng + " grant\n" + ops.GrantSQL(e, "anphat", "anphat_app", "localhost", "anphat_shop", []string{"SELECT", "INSERT"}))
	}
	golden(t, "db.sql", b.String())
}

// ---------- SFTP / sshd / SSH key ----------

func TestSshdMatchApply(t *testing.T) {
	e := dataEnv(t)
	e.step("sshd.match.apply", contracts.OpSshdMatchApply, map[string]any{"password_authentication": true}, true)
	golden(t, "50-itso.conf", e.file(ops.SshdDropIn))
	conf := e.file(ops.SshdDropIn)
	if !strings.HasSuffix(conf, "Match all\n") || strings.Count(conf, "AuthorizedKeysFile") != 1 {
		t.Fatal(conf)
	}
	// sshd -t lỗi → khôi phục bản cũ, không reload.
	e.fail["sshd -t"] = platform.Result{ExitCode: 255, Stderr: []byte("Bad configuration option")}
	e.fake.Reset()
	e.h.Fail(contracts.OpSshdMatchApply, map[string]any{"password_authentication": false}, "config_test_failed")
	if e.file(ops.SshdDropIn) != conf {
		t.Fatal("phải khôi phục cấu hình cũ")
	}
	for _, l := range e.fake.Lines() {
		if strings.HasPrefix(l, "systemctl") {
			t.Fatal("không được reload khi sshd -t lỗi:", l)
		}
	}
}

func TestSFTPUser(t *testing.T) {
	e := dataEnv(t)
	e.fake.Reset()
	d := e.h.OK(contracts.OpSFTPUserEnsure, map[string]any{"account": acct(), "ssh_access": false, "password": pw})
	if d["group"] != "itso-sftp" || d["changed"] != true {
		t.Fatal(d)
	}
	for _, l := range e.fake.Lines() {
		if strings.Contains(l, pw) {
			t.Fatal("mật khẩu lộ trong argv")
		}
	}
	if !strings.Contains(e.file("/etc/group"), "itso-sftp:x:") || !strings.Contains(e.file("/etc/group"), ":anphat") {
		t.Fatal(e.file("/etc/group"))
	}
	if d := e.h.OK(contracts.OpSFTPUserEnsure, map[string]any{"account": acct(), "ssh_access": false, "password": nil}); d["changed"] != false {
		t.Fatal("lần 2 không đổi gì", d)
	}
	if d := e.h.OK(contracts.OpSFTPUserEnsure, map[string]any{"account": acct(), "ssh_access": true, "password": nil}); d["group"] != "itso-ssh" || d["changed"] != true {
		t.Fatal(d)
	}
	if d := e.h.OK(contracts.OpSFTPUserRemove, map[string]any{"account": acct()}); d["removed"] != true {
		t.Fatal(d)
	}
}

func edKey(t *testing.T) string {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var blob []byte
	for _, part := range [][]byte{[]byte("ssh-ed25519"), pub} {
		blob = binary.BigEndian.AppendUint32(blob, uint32(len(part)))
		blob = append(blob, part...)
	}
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob)
}

func TestSSHKeys(t *testing.T) {
	e := dataEnv(t)
	k1, k2 := edKey(t), edKey(t)
	if d := e.h.OK(contracts.OpSSHKeysApply, map[string]any{"account": acct(), "keys": []any{k1 + " laptop@home", k2}}); d["count"] != float64(2) {
		t.Fatal(d)
	}
	got := e.file(ops.AuthorizedKeys + "/anphat")
	if !strings.Contains(got, k1+" laptop@home\n") || e.mode(ops.AuthorizedKeys+"/anphat") != 0o644 {
		t.Fatal(got)
	}
	for _, bad := range []string{
		`command="/usr/bin/id" ` + k1, // option bị cấm
		"ssh-dss AAAAB3NzaC1kc3MAAACBAP",
		"ssh-ed25519 !!!notbase64",
		"ssh-rsa " + strings.Fields(k1)[1], // blob ed25519 khai báo là rsa
		k1 + " bad\x01comment",
	} {
		e.h.Fail(contracts.OpSSHKeysApply, map[string]any{"account": acct(), "keys": []any{bad}}, "invalid_params")
	}
	e.h.Fail(contracts.OpSSHKeysApply, map[string]any{"account": acct(), "keys": []any{k1, k1 + " dup"}}, "already_exists")
	e.h.OK(contracts.OpSSHKeysApply, map[string]any{"account": acct(), "keys": []any{}})
	if e.exists(ops.AuthorizedKeys + "/anphat") {
		t.Fatal("không còn khóa → xóa file")
	}
}

// ---------- FTPS phụ ----------

func TestFTPUser(t *testing.T) {
	e := dataEnv(t)
	ftp := func(name, root string, enabled bool, p any) map[string]any {
		return map[string]any{"account": acct(), "username": name, "root_path": root, "enabled": enabled, "password": p}
	}
	e.h.Fail(contracts.OpFTPUserEnsure, ftp("other_dev", "sites/anphat.vn", true, pw), "invalid_params")
	e.failAny(contracts.OpFTPUserEnsure, ftp("anphat_dev", "sites/none", true, pw))
	e.failAny(contracts.OpFTPUserEnsure, ftp("anphat_dev", "../other", true, pw))
	e.h.Fail(contracts.OpFTPUserEnsure, ftp("anphat_dev", "sites/anphat.vn", true, nil), "invalid_params")
	if err := os.Symlink("/etc", filepath.Join(e.fs.Root, "home/anphat/sites/link")); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpFTPUserEnsure, ftp("anphat_dev", "sites/link", true, pw), "precondition_failed")

	e.fake.Reset()
	if d := e.h.OK(contracts.OpFTPUserEnsure, ftp("anphat_dev", "sites/anphat.vn", true, pw)); d["created"] != true {
		t.Fatal(d)
	}
	lines := strings.Join(e.fake.Lines(), "\n")
	if !strings.Contains(lines, "pure-pw useradd anphat_dev -u 20001 -g 20001 -d /home/anphat/sites/anphat.vn -m") || strings.Contains(lines, pw) {
		t.Fatal(lines)
	}
	if d := e.h.OK(contracts.OpFTPUserEnsure, ftp("anphat_dev", "sites/anphat.vn", true, nil)); d["changed"] != false {
		t.Fatal("không đổi gì", d)
	}
	if d := e.h.OK(contracts.OpFTPUserEnsure, ftp("anphat_dev", "sites/anphat.vn", false, nil)); d["changed"] != true {
		t.Fatal("tắt = đặt mật khẩu ngẫu nhiên", d)
	}
	e.h.Fail(contracts.OpFTPUserRemove, map[string]any{"account": ct.Acct("anphat", 20002), "username": "anphat_dev"}, "precondition_failed")
	if d := e.h.OK(contracts.OpFTPUserRemove, map[string]any{"account": acct(), "username": "anphat_dev"}); d["removed"] != true {
		t.Fatal(d)
	}
}

// ---------- Cron ----------

func TestCronToOnCalendar(t *testing.T) {
	for in, want := range map[string]string{
		"* * * * *":        "*-*-* *:*:00",
		"*/15 * * * *":     "*-*-* *:00,15,30,45:00",
		"*/15 2-5 * * 1-5": "Mon..Fri *-*-* 02..05:00,15,30,45:00",
		"0 3 1 * *":        "*-*-01 03:00:00",
		"30 4 * 1,6 *":     "*-01,06-* 04:30:00",
		"0 0 * * 0":        "Sun *-*-* 00:00:00",
		"0 0 * * 7":        "Sun *-*-* 00:00:00",
		"0 0 * * 5-7":      "Fri..Sun *-*-* 00:00:00",
		"0 12 29 2 *":      "*-02-29 12:00:00",
		"5 0-23/6 * * *":   "*-*-* 00,06,12,18:05:00",
		"0 9 * * 1,3,5":    "Mon,Wed,Fri *-*-* 09:00:00",
		"10-12 1 * * *":    "*-*-* 01:10..12:00",
		"0 0 1-31/10 * *":  "*-*-01,11,21,31 00:00:00",
	} {
		got, err := ops.CronToOnCalendar(in)
		if err != nil || got != want {
			t.Errorf("%q → %q (%v), muốn %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"* * 1 * 1", "0 0 30 2 *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8",
		"*/0 * * * *", "5-1 * * * *", "* * * *", "@reboot", "a * * * *", "1,,2 * * * *"} {
		if _, err := ops.CronToOnCalendar(bad); err == nil {
			t.Errorf("%q phải bị từ chối", bad)
		}
	}
}

func cronEntry(id, sched, cmd string, enabled bool) map[string]any {
	return map[string]any{"uuid": id, "schedule": sched, "command": cmd, "working_dir": "sites/anphat.vn", "enabled": enabled, "timeout_sec": 600}
}

func TestCronApply(t *testing.T) {
	e := dataEnv(t)
	id1, id2 := "01938a0d-0001-7000-8000-00000d000001", "01938a0d-0001-7000-8000-00000d000002"
	cmd := `php artisan schedule:run >> "$HOME/logs/cron.log" 2>&1 # 100% \ ok`
	p := map[string]any{"account": acct(), "entries": []any{cronEntry(id1, "*/15 * * * *", cmd, true), cronEntry(id2, "0 3 * * *", "true", true)}}
	d := e.step("cron.apply", contracts.OpCronApply, p, true)
	if d["active"] != float64(2) || d["removed"] != float64(0) {
		t.Fatal(d)
	}
	golden(t, "itso-cron.service", e.file(ops.UnitDir+"/itso-cron-"+id1+".service"))
	golden(t, "itso-cron.timer", e.file(ops.UnitDir+"/itso-cron-"+id1+".timer"))
	// Lệnh nằm nguyên văn trong script root 0644, không bị escape vào unit.
	script := ops.CronDir + "/anphat/" + id1 + ".sh"
	if !strings.Contains(e.file(script), "\n"+cmd+"\n") || e.mode(script) != 0o640 || e.fs.Owners[script].GID != 20001 {
		t.Fatal(e.file(script))
	}
	if strings.Contains(e.file(ops.UnitDir+"/itso-cron-"+id1+".service"), "artisan") {
		t.Fatal("lệnh không được nằm trong unit")
	}
	// Tắt job 2 → dừng + xóa unit và script.
	p["entries"] = []any{cronEntry(id1, "*/15 * * * *", cmd, true), cronEntry(id2, "0 3 * * *", "true", false)}
	if d := e.h.OK(contracts.OpCronApply, p); d["active"] != float64(1) || d["removed"] != float64(1) {
		t.Fatal(d)
	}
	if e.exists(ops.UnitDir+"/itso-cron-"+id2+".timer") || e.exists(ops.CronDir+"/anphat/"+id2+".sh") {
		t.Fatal("job tắt phải bị xóa")
	}
	// Lệnh nhiều dòng, DOM+DOW, working_dir thoát home → từ chối.
	for _, en := range []map[string]any{
		cronEntry(id1, "*/15 * * * *", "echo a\nrm -rf ~", true),
		cronEntry(id1, "0 0 1 * 1", "true", true),
		{"uuid": id1, "schedule": "* * * * *", "command": "true", "working_dir": "../root", "enabled": true, "timeout_sec": 600},
	} {
		res := e.h.Call(contracts.OpCronApply, map[string]any{"account": acct(), "entries": []any{en}})
		if res.OK {
			t.Fatalf("phải bị từ chối: %v", en)
		}
	}
	e.h.OK(contracts.OpCronApply, map[string]any{"account": acct(), "entries": []any{}})
	if e.exists(ops.UnitDir + "/itso-cron-" + id1 + ".timer") {
		t.Fatal("desired state rỗng → xóa hết")
	}
}

func TestCronInspectAndRunOnce(t *testing.T) {
	e := dataEnv(t)
	id := "01938a0d-0001-7000-8000-00000d000001"
	e.fail["systemctl show itso-cron-"+id] = platform.Result{Stdout: []byte("ExecMainStartTimestamp=@1795137300\nExecMainExitTimestamp=@1795137302\nExecMainStatus=1\nResult=exit-code\n")}
	d := e.h.OK(contracts.OpCronInspect, map[string]any{"account": acct(), "uuids": []any{id}})
	j := d["jobs"].([]any)[0].(map[string]any)
	if j["result"] != "failed" || j["exit_code"] != float64(1) || j["last_started_at"] != "2026-11-20T01:15:00Z" {
		t.Fatal(j)
	}
	e.fake.Reset()
	r := e.h.OK(contracts.OpCronRunOnce, map[string]any{"account": acct(), "uuid": id, "command": "php -v", "working_dir": ".", "timeout_sec": 60})
	if r["exit_code"] != float64(0) || r["timed_out"] != false {
		t.Fatal(r)
	}
	lines := strings.Join(e.fake.Lines(), "\n")
	if !strings.Contains(lines, "systemd-run --wait --pipe --collect --quiet --unit=itso-cron-run-"+id+" --uid=20001 --gid=20001 --slice=itso-acct-20001.slice --working-directory=/home/anphat") {
		t.Fatal(lines)
	}
	if e.exists(ops.CronDir + "/anphat/" + id + ".run.sh") {
		t.Fatal("script chạy tay phải được xóa")
	}
}

// ---------- File Manager qua helper ----------

func TestFSOpsViaHelper(t *testing.T) {
	e := dataEnv(t)
	body := base64.StdEncoding.EncodeToString([]byte("<?php echo 1;"))
	w := e.h.OK(contracts.OpFsWrite, map[string]any{"account": acct(), "path": "sites/anphat.vn/index.php", "content_b64": body})
	e.h.Fail(contracts.OpFsWrite, map[string]any{"account": acct(), "path": "sites/anphat.vn/index.php", "content_b64": body, "if_sha256": strings.Repeat("0", 64)}, "precondition_failed")
	r := e.h.OK(contracts.OpFsRead, map[string]any{"account": acct(), "path": "sites/anphat.vn/index.php", "max_bytes": 1024})
	if r["content_b64"] != body || r["sha256"] != w["sha256"] {
		t.Fatal(r)
	}
	l := e.h.OK(contracts.OpFsList, map[string]any{"account": acct(), "path": "sites/anphat.vn"})
	if len(l["entries"].([]any)) == 0 {
		t.Fatal(l)
	}
	e.failAny(contracts.OpFsRead, map[string]any{"account": acct(), "path": "../../etc/shadow", "max_bytes": 1024})
	// Upload: file staging (root) → helper ghi vào home.
	up := "01938a0e-0001-7000-8000-00000e000001"
	write(t, e.fs.Root, ops.UploadDir+"/"+up+".part", "hello upload")
	e.h.Fail(contracts.OpFsUploadCommit, map[string]any{"account": acct(), "upload_uuid": up, "target": "up.txt", "size": 5, "overwrite": false}, "precondition_failed")
	e.h.OK(contracts.OpFsUploadCommit, map[string]any{"account": acct(), "upload_uuid": up, "target": "up.txt", "size": 12, "overwrite": false})
	if e.file("/home/anphat/up.txt") != "hello upload" || e.exists(ops.UploadDir+"/"+up+".part") {
		t.Fatal("upload commit sai")
	}
	// Staging là symlink → từ chối (O_NOFOLLOW).
	up2 := "01938a0e-0001-7000-8000-00000e000002"
	if err := os.Symlink("/etc/passwd", filepath.Join(e.fs.Root, ops.UploadDir, up2+".part")); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpFsUploadCommit, map[string]any{"account": acct(), "upload_uuid": up2, "target": "p.txt", "size": 1, "overwrite": false}, "precondition_failed")
}

// failAny đòi op thất bại (mã lỗi tùy trường hợp: not_found, path_outside_home…).
func (e *env) failAny(op string, params map[string]any) {
	e.t.Helper()
	if res := e.h.Call(op, params); res.OK {
		e.t.Fatalf("%s phải thất bại: %+v", op, res)
	}
}
