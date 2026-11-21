package install_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/install"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

var seed = bytes.Repeat([]byte{7}, ed25519.SeedSize)
var priv = ed25519.NewKeyFromSeed(seed)

type rig struct {
	t    *testing.T
	e    *install.Env
	fake *platform.FakeRunner
	fs   *platform.FS
	out  *bytes.Buffer
	fail map[string]platform.Result
}

func put(t *testing.T, root, p, content string) {
	t.Helper()
	full := filepath.Join(root, p)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeHost là máy Ubuntu 24.04 có systemd + cgroup v2 (gốc giả).
func fakeHost(t *testing.T, systemd bool) string {
	h := t.TempDir()
	put(t, h, "/etc/os-release", "ID=ubuntu\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n")
	put(t, h, "/proc/cpuinfo", "processor\t: 0\n\nprocessor\t: 1\n")
	put(t, h, "/proc/meminfo", "MemTotal:        4048576 kB\n")
	put(t, h, "/proc/sys/kernel/hostname", "srv01.itso.local\n")
	if systemd {
		put(t, h, "/sys/fs/cgroup/cgroup.controllers", "cpu memory io pids\n")
		put(t, h, "/run/systemd/system/.keep", "")
		put(t, h, "/proc/1/comm", "systemd\n")
	} else {
		put(t, h, "/proc/1/comm", "bash\n")
	}
	return h
}

func newRig(t *testing.T) *rig {
	t.Helper()
	root := t.TempDir()
	put(t, root, "/etc/passwd", "root:x:0:0:root:/root:/bin/bash\npostgres:x:110:110::/var/lib/postgresql:/bin/bash\n")
	put(t, root, "/etc/group", "root:x:0:\npostgres:x:110:\n")
	put(t, root, "/etc/shadow", "root:*:20000:0:99999:7:::\n")
	r := &rig{t: t, fs: platform.NewFS(root, true), out: &bytes.Buffer{}, fail: map[string]platform.Result{}}
	sim := ops.NewSim(r.fs)
	r.fake = platform.NewFake()
	r.fake.Hook = func(c platform.Cmd) (platform.Result, bool) {
		s := c.String()
		for k, v := range r.fail {
			if strings.HasPrefix(s, k) {
				return v, true
			}
		}
		return sim.Handle(c)
	}
	r.e = &install.Env{Run: r.fake, FS: r.fs, Host: platform.NewFS(fakeHost(t, true), true), Out: r.out,
		Now: func() time.Time { return time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC) }, PubKey: priv.Public().(ed25519.PublicKey),
		Arch: "amd64", HealthTries: 1, IP: func() string { return "203.0.113.10" }}
	return r
}

type entry struct {
	name, body, link string
	typ              byte
}

// release tạo thư mục phát hành có manifest ký bằng priv.
func release(t *testing.T, ver string, extra ...entry) string {
	t.Helper()
	dir := t.TempDir()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	units, _ := filepath.Glob("../../../packaging/systemd/*")
	files := []entry{{name: "bin/itso-agent", body: "agent " + ver}, {name: "api/artisan", body: "<?php // " + ver}, {name: "VERSION", body: ver + "\n"}}
	for _, u := range units {
		b, _ := os.ReadFile(u)
		files = append(files, entry{name: "packaging/systemd/" + filepath.Base(u), body: string(b)})
	}
	var sums strings.Builder
	for _, f := range files {
		s := sha256.Sum256([]byte(f.body))
		sums.WriteString(hex.EncodeToString(s[:]) + "  ./" + f.name + "\n")
	}
	files = append(files, entry{name: "checksums.txt", body: sums.String()})
	files = append(files, extra...)
	for _, f := range files {
		h := &tar.Header{Name: "itso-" + ver + "/" + f.name, Mode: 0o644, Size: int64(len(f.body)), Typeflag: tar.TypeReg}
		if f.typ != 0 {
			h.Typeflag, h.Linkname, h.Size = f.typ, f.link, 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			_, _ = tw.Write([]byte(f.body))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	name := "itso-" + ver + "-linux-amd64.tar.gz"
	if err := os.WriteFile(filepath.Join(dir, name), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	m, _ := json.Marshal(install.Manifest{Name: "itso-panel", Version: ver, MinFromVersion: "0.0.0",
		Artifacts: []install.Artifact{{Name: name, Kind: "tarball", SHA256: hex.EncodeToString(sum[:]), Size: int64(buf.Len())}}})
	_ = os.WriteFile(filepath.Join(dir, "manifest.json"), m, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "manifest.sig"), ed25519.Sign(priv, m), 0o644)
	return dir
}

var reads = []string{"dpkg-query ", "systemctl is-active ", "findmnt ", "ss ", "[uid=110] psql --cluster 16/itso -v ON_ERROR_STOP=1 -tAc SELECT"}

func (r *rig) writes() []string {
	var out []string
	for _, l := range r.fake.Lines() {
		read := false
		for _, p := range reads {
			read = read || strings.HasPrefix(l, p)
		}
		if !read {
			out = append(out, l)
		}
	}
	return out
}

func (r *rig) state() install.State {
	var st install.State
	b, err := r.fs.ReadFile(install.StateFile)
	if err != nil {
		r.t.Fatal(err)
	}
	_ = json.Unmarshal(b, &st)
	return st
}

func opts(dir string) install.Options {
	return install.Options{ReleaseDir: dir, Port: 28443, Yes: true}
}

func TestPreflightInContainerFails(t *testing.T) {
	r := newRig(t)
	r.e.Host = platform.NewFS(fakeHost(t, false), true)
	cs := r.e.Preflight(context.Background(), opts(release(t, "1.0.0")))
	got := map[string]install.Status{}
	for _, c := range cs {
		got[c.Name] = c.Status
	}
	if got["systemd"] != install.Fail || got["cgroup_v2"] != install.Fail || got["os"] != install.Pass || got["release"] != install.Pass {
		t.Fatal(got)
	}
	if err := r.e.Install(context.Background(), opts(release(t, "1.0.0"))); err == nil || !strings.Contains(err.Error(), "FAIL") {
		t.Fatal("cài phải dừng khi preflight FAIL:", err)
	}
	if len(r.writes()) != 0 {
		t.Fatal(r.writes())
	}
}

func TestDryRunChangesNothing(t *testing.T) {
	r := newRig(t)
	o := opts(release(t, "1.0.0"))
	o.DryRun = true
	if err := r.e.Install(context.Background(), o); err != nil {
		t.Fatal(err, r.out.String())
	}
	if len(r.writes()) != 0 || r.fs.Exists(install.StateFile) || r.fs.Exists(install.OptDir) {
		t.Fatal(r.writes())
	}
	if !strings.Contains(r.out.String(), "--dry-run") || !strings.Contains(r.out.String(), "database") {
		t.Fatal(r.out.String())
	}
}

func TestInstallIdempotentAndResumable(t *testing.T) {
	r := newRig(t)
	dir := release(t, "1.0.0")
	// Lần 1 hỏng ở bước database: các bước trước được giữ.
	r.fail["pg_createcluster "] = platform.Result{ExitCode: 1, Stderr: []byte("cluster lỗi giả")}
	if err := r.e.Install(context.Background(), opts(dir)); err == nil || !strings.Contains(err.Error(), "bước database") {
		t.Fatal(err)
	}
	st := r.state()
	if st.Steps["secrets"] == "" || st.Steps["database"] != "" {
		t.Fatal(st)
	}
	delete(r.fail, "pg_createcluster ")
	r.fake.Reset()
	if err := r.e.Install(context.Background(), opts(dir)); err != nil {
		t.Fatal(err, r.out.String())
	}
	for _, l := range r.writes() {
		if strings.HasPrefix(l, "groupadd") || strings.HasPrefix(l, "useradd") || strings.HasPrefix(l, "apt-get") {
			t.Fatalf("chạy lại không được làm lại bước đã xong: %s", l)
		}
	}
	w := strings.Join(r.writes(), "\n")
	for _, want := range []string{"pg_createcluster 16 itso -p 5433 --start -- --auth-local=peer",
		"[uid=110] psql --cluster 16/itso -v ON_ERROR_STOP=1 -tAc CREATE ROLE itso LOGIN",
		"artisan migrate --force", "systemctl enable --now itso.target"} {
		if !strings.Contains(w, want) {
			t.Fatalf("thiếu %q trong:\n%s", want, w)
		}
	}
	out := r.out.String()
	if !strings.Contains(out, "URL:          https://203.0.113.10:28443/") || !strings.Contains(out, "Mã thiết lập: ") {
		t.Fatal(out)
	}
	if v := r.e.CurrentVersion(); v != "1.0.0" {
		t.Fatal(v)
	}
	// Quyền file bí mật + chủ (root:itso).
	itsoGID := 0
	for _, l := range strings.Split(string(must(r.fs.ReadFile("/etc/group"))), "\n") {
		if strings.HasPrefix(l, "itso:") {
			itsoGID = atoi(strings.Split(l, ":")[2])
		}
	}
	for _, f := range []string{install.AgentKey, install.EnvFile, install.TLSKey, install.SetupFile} {
		rp, _ := r.fs.Path(f)
		fi, err := os.Stat(rp)
		if err != nil || fi.Mode().Perm() != 0o640 {
			t.Fatalf("%s: %v %v", f, fi, err)
		}
		if o, _ := r.fs.OwnerOf(f); o.UID != 0 || o.GID != itsoGID || itsoGID == 0 {
			t.Fatalf("%s chủ %+v (gid itso %d)", f, o, itsoGID)
		}
	}
	env := string(must(r.fs.ReadFile(install.EnvFile)))
	if !strings.Contains(env, "APP_KEY=base64:") || !strings.Contains(env, "DB_PORT=5433") || !strings.Contains(env, "ITSO_PANEL_PORT=28443") {
		t.Fatal(env)
	}
	if !r.fs.Exists("/etc/systemd/system/itso-agent.service") || !r.fs.Exists(install.TLSCert) {
		t.Fatal("thiếu unit hoặc chứng chỉ")
	}
	key1 := string(must(r.fs.ReadFile(install.AgentKey)))

	// Lần 3: mọi bước đã xong → không có lệnh ghi nào, secret giữ nguyên.
	r.fake.Reset()
	if err := r.e.Install(context.Background(), opts(dir)); err != nil {
		t.Fatal(err)
	}
	if w := r.writes(); len(w) != 0 {
		t.Fatalf("lần chạy lại không được ghi gì: %v", w)
	}
	if string(must(r.fs.ReadFile(install.AgentKey))) != key1 {
		t.Fatal("khóa agent bị sinh lại")
	}
}

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func installed(t *testing.T) *rig {
	r := newRig(t)
	if err := r.e.Install(context.Background(), opts(release(t, "1.0.0"))); err != nil {
		t.Fatal(err, r.out.String())
	}
	return r
}

func TestUpdateRollbackAndPrune(t *testing.T) {
	r := installed(t)
	ctx := context.Background()
	if err := r.e.Update(ctx, release(t, "1.0.0")); err == nil {
		t.Fatal("bản không mới hơn phải bị từ chối")
	}
	r.fake.Reset()
	if err := r.e.Update(ctx, release(t, "1.1.0")); err != nil {
		t.Fatal(err, r.out.String())
	}
	w := strings.Join(r.writes(), "\n")
	for _, want := range []string{"[uid=110] pg_dump --cluster 16/itso -Fc -f", "artisan down", "artisan migrate --force", "systemctl restart itso.target", "artisan up"} {
		if !strings.Contains(w, want) {
			t.Fatalf("thiếu %q:\n%s", want, w)
		}
	}
	if st := r.state(); r.e.CurrentVersion() != "1.1.0" || st.Previous != "1.0.0" || st.Version != "1.1.0" {
		t.Fatal(st)
	}
	if !r.fs.Exists(install.BackupDir + "/pre-update/1.0.0-etc/agent.key") {
		t.Fatal("chưa sao lưu /etc/itso trước cập nhật")
	}
	if err := r.e.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if st := r.state(); r.e.CurrentVersion() != "1.0.0" || st.Previous != "1.1.0" {
		t.Fatal(st)
	}
	if err := r.e.Rollback(ctx); err != nil { // rollback lần nữa = về lại 1.1.0
		t.Fatal(err)
	}
	// Sức khỏe hỏng sau khi đổi bản → tự rollback.
	r.fail["systemctl is-active itso-web.service"] = platform.Result{ExitCode: 3, Stdout: []byte("failed\n")}
	err := r.e.Update(ctx, release(t, "1.2.0"))
	if err == nil || !strings.Contains(err.Error(), "đã rollback về 1.1.0") || r.e.CurrentVersion() != "1.1.0" {
		t.Fatal(err, r.e.CurrentVersion())
	}
	delete(r.fail, "systemctl is-active itso-web.service")
	for _, v := range []string{"1.2.0", "1.3.0", "1.4.0"} {
		if err := r.e.Update(ctx, release(t, v)); err != nil {
			t.Fatal(v, err)
		}
	}
	rp, _ := r.fs.Path(install.ReleasesDir)
	ents, _ := os.ReadDir(rp)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "1.2.0,1.3.0,1.4.0" {
		t.Fatalf("giữ 3 bản gần nhất: %v", names)
	}
}

func TestReleaseRejectsBadSignatureChecksumAndTar(t *testing.T) {
	r := installed(t)
	ctx := context.Background()
	dir := release(t, "2.0.0")
	_ = os.WriteFile(filepath.Join(dir, "manifest.sig"), bytes.Repeat([]byte{1}, 64), 0o644)
	if err := r.e.Update(ctx, dir); err == nil || !strings.Contains(err.Error(), "chữ ký") {
		t.Fatal(err)
	}
	dir = release(t, "2.0.0")
	tb, _ := filepath.Glob(filepath.Join(dir, "*.tar.gz"))
	f, _ := os.OpenFile(tb[0], os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.Write([]byte("x"))
	_ = f.Close()
	if err := r.e.Update(ctx, dir); err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatal(err)
	}
	for _, bad := range []entry{{name: "../../etc/evil", body: "x"}, {name: "bin/l", typ: tar.TypeSymlink, link: "/etc/shadow"},
		{name: "bin/l2", typ: tar.TypeSymlink, link: "../../../etc"}, {name: "dev", typ: tar.TypeChar}} {
		if err := r.e.Update(ctx, release(t, "2.0.0", bad)); err == nil {
			t.Fatalf("tarball có %q phải bị từ chối", bad.name)
		}
	}
	if r.e.CurrentVersion() != "1.0.0" {
		t.Fatal(r.e.CurrentVersion())
	}
}

func TestUninstallKeepsHostingData(t *testing.T) {
	r := installed(t)
	put(t, r.fs.Root, "/home/lehoa/sites/index.php", "<?php echo 1;")
	ctx := context.Background()
	if err := r.e.Uninstall(ctx, install.UninstallOptions{PurgePanelData: true, ConfirmHostname: "sai"}); err == nil {
		t.Fatal("purge thiếu xác nhận hostname phải bị từ chối")
	}
	if err := r.e.Uninstall(ctx, install.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if !r.fs.Exists("/home/lehoa/sites/index.php") || r.fs.Exists(install.OptDir) || r.fs.Exists(install.EtcDir) ||
		!r.fs.Exists("/etc/itso.removed-20261121T030000Z/agent.key") || r.fs.Exists("/etc/systemd/system/itso-agent.service") {
		t.Fatal("uninstall phải giữ /home, đổi tên /etc/itso, gỡ /opt/itso và unit")
	}
	if strings.Contains(strings.Join(r.writes(), "\n"), "pg_dropcluster") {
		t.Fatal("không purge thì không xóa cluster")
	}
}

func TestRepairStatusDoctorPolicyLogsAdmin(t *testing.T) {
	r := installed(t)
	ctx := context.Background()
	put(t, r.fs.Root, "/etc/systemd/system/itso-web.service", "[Service]\nExecStart=/bin/false\n")
	put(t, r.fs.Root, install.ReleasesDir+"/1.0.0/api/artisan", "<?php // bị sửa")
	cs, err := r.e.Repair(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if !install.Failed(cs) {
		t.Fatal("repair phải phát hiện unit và file bị sửa", cs)
	}
	cs, _ = r.e.Repair(ctx, true)
	for _, c := range cs {
		if c.Name == "units" && c.Status != install.Pass {
			t.Fatal(c)
		}
	}
	if !strings.Contains(string(must(r.fs.ReadFile("/etc/systemd/system/itso-web.service"))), "FrankenPHP") {
		t.Fatal("repair --fix phải ghi lại unit")
	}
	r.out.Reset()
	if err := r.e.Status(ctx); err != nil || !strings.Contains(r.out.String(), "ITSO Panel 1.0.0") {
		t.Fatal(err, r.out.String())
	}
	cs = r.e.Doctor(ctx)
	for _, c := range cs {
		if c.Name == "agent_socket" && c.Status != install.Fail { // gốc giả không có socket
			t.Fatal(c)
		}
		if c.Name == "tls" && c.Status != install.Pass {
			t.Fatal(c)
		}
	}
	if err := r.e.PolicySet(ctx, "docker", "true"); err != nil {
		t.Fatal(err)
	}
	r.out.Reset()
	if err := r.e.PolicyGet("docker"); err != nil || r.out.String() != "docker=true\n" {
		t.Fatal(err, r.out.String())
	}
	if err := r.e.PolicySet(ctx, "khong.co", "true"); err == nil {
		t.Fatal("khóa lạ phải bị từ chối")
	}
	if err := r.e.Logs(ctx, "../etc", 10); err == nil {
		t.Fatal("dịch vụ lạ phải bị từ chối")
	}
	r.fake.Reset()
	if err := r.e.AdminReset(ctx, "reset-mfa", "admin@itso.vn"); err != nil {
		t.Fatal(err)
	}
	if l := r.fake.Lines(); len(l) != 1 || !strings.HasSuffix(l[0], "frankenphp php-cli /opt/itso/current/api/artisan itso:admin-reset-mfa --email=admin@itso.vn --no-interaction") {
		t.Fatal(l)
	}
	for _, bad := range []string{"a@b", "x;rm -rf /@a.vn", "--force@a.vn x"} {
		if err := r.e.AdminReset(ctx, "reset-password", bad); err == nil {
			t.Fatalf("email %q phải bị từ chối", bad)
		}
	}
}

func TestSetupCode(t *testing.T) {
	r := newRig(t)
	code, err := r.e.NewSetupCode()
	if err != nil || len(code) != 14 || code[4] != '-' || code[9] != '-' {
		t.Fatal(code, err)
	}
	var sc install.SetupCode
	_ = json.Unmarshal(must(r.fs.ReadFile(install.SetupFile)), &sc)
	sum := sha256.Sum256([]byte(strings.ReplaceAll(code, "-", "")))
	if sc.SHA256 != hex.EncodeToString(sum[:]) || sc.ExpiresAt != "2026-11-21T04:00:00Z" {
		t.Fatal(sc)
	}
	if strings.Contains(string(must(r.fs.ReadFile(install.SetupFile))), code) {
		t.Fatal("không được lưu mã thô")
	}
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{{"1.0.0", "1.0.0", 0}, {"1.0.1", "1.0.0", 1}, {"0.9.9", "1.0.0", -1}, {"1.0.0-alpha", "1.0.0", -1}, {"0.4.0-dev", "0.4.0-alpha", 1}, {"1.10.0", "1.9.0", 1}} {
		if got := install.CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("%s vs %s = %d", c.a, c.b, got)
		}
	}
}
