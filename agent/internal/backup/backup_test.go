package backup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	srv   = "0193aa10-0001-7000-8000-000000000001"
	acc   = "01938a01-0003-7000-8000-000000000020"
	dst   = "0193bb10-0001-7000-8000-000000000003"
	rpw   = "Rk7-panel-9fQ2-xV4m-T8sL"
	rpath = "itso/" + srv + "/acct-" + acc
)

func repoParams(dest map[string]any) RepoParams {
	b, _ := json.Marshal(dest)
	return RepoParams{RepoUUID: dst, Path: rpath, Destination: b, Password: rpw}
}

func TestParseRepoAndURL(t *testing.T) {
	cases := []struct {
		dest map[string]any
		want string
	}{
		{map[string]any{"type": "local", "destination_uuid": dst}, "/R/" + rpath},
		{map[string]any{"type": "sftp", "destination_uuid": dst, "host": "backup2.itso.local", "port": 2222, "user": "itso-backup",
			"path": "/srv/backup", "host_key_sha256": nil}, "sftp:itso-backup@backup2.itso.local:/srv/backup/" + rpath},
		{map[string]any{"type": "s3", "destination_uuid": dst, "endpoint": "https://s3.example.com", "bucket": "itso-backup",
			"region": "ap-southeast-1", "access_key_id": "AKIAITSODEMO", "secret_access_key": "demo-secret-key"},
			"s3:https://s3.example.com/itso-backup/" + rpath},
		{map[string]any{"type": "rest", "destination_uuid": dst, "url": "https://rest.itso.local/itso", "user": "itso",
			"password": "p@ss/w0rd!x"}, "rest:https://itso:p%40ss%2Fw0rd%21x@rest.itso.local/itso/" + rpath + "/"},
	}
	for _, c := range cases {
		r, err := ParseRepo(repoParams(c.dest))
		if err != nil {
			t.Fatalf("%v: %v", c.dest["type"], err)
		}
		if got := r.URL("/R"); got != c.want {
			t.Fatalf("URL %s:\n got %s\nwant %s", c.dest["type"], got, c.want)
		}
		if r.AccountUUID() != acc {
			t.Fatal(r.AccountUUID())
		}
	}
}

func TestParseRepoRejectsEvil(t *testing.T) {
	good := map[string]any{"type": "local", "destination_uuid": dst}
	bad := []RepoParams{
		{RepoUUID: dst, Path: "itso/" + srv + "/../x", Destination: mustJSON(good), Password: rpw},
		{RepoUUID: dst, Path: "/var/backups", Destination: mustJSON(good), Password: rpw},
		{RepoUUID: dst, Path: rpath, Destination: mustJSON(good), Password: "short"},
		{RepoUUID: dst, Path: rpath, Destination: mustJSON(good), Password: "has space in password!!"},
		{RepoUUID: "x", Path: rpath, Destination: mustJSON(good), Password: rpw},
	}
	dests := []map[string]any{
		{"type": "local", "destination_uuid": dst, "path": "/"},
		{"type": "sftp", "destination_uuid": dst, "host": "h -oProxyCommand=id", "port": 22, "user": "u", "path": "/srv"},
		{"type": "sftp", "destination_uuid": dst, "host": "h", "port": 22, "user": "-oProxyCommand=id", "path": "/srv"},
		{"type": "sftp", "destination_uuid": dst, "host": "h", "port": 22, "user": "u", "path": "/srv/../etc"},
		{"type": "sftp", "destination_uuid": dst, "host": "h", "port": 22, "user": "u", "path": "/srv/a b"},
		{"type": "sftp", "destination_uuid": dst, "host": "h", "port": 0, "user": "u", "path": "/srv"},
		{"type": "s3", "destination_uuid": dst, "endpoint": "http://169.254.169.254", "bucket": "b-1", "access_key_id": "AKIAITSODEMO", "secret_access_key": "xxxxxxxxx"},
		{"type": "s3", "destination_uuid": dst, "endpoint": "https://user:pw@s3.example.com", "bucket": "b-1", "access_key_id": "AKIAITSODEMO", "secret_access_key": "xxxxxxxxx"},
		{"type": "rest", "destination_uuid": dst, "url": "https://r.example.com/?x=1", "user": "u", "password": "xxxxxxxxx"},
		{"type": "ftp", "destination_uuid": dst},
	}
	for _, d := range dests {
		bad = append(bad, RepoParams{RepoUUID: dst, Path: rpath, Destination: mustJSON(d), Password: rpw})
	}
	for i, p := range bad {
		if _, err := ParseRepo(p); err == nil {
			t.Fatalf("case %d phải bị từ chối: %+v", i, p)
		}
	}
}

func mustJSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

func TestSessionArgvHasNoSecrets(t *testing.T) {
	r, err := ParseRepo(repoParams(map[string]any{"type": "s3", "destination_uuid": dst, "endpoint": "https://s3.example.com",
		"bucket": "itso-backup", "region": nil, "access_key_id": "AKIAITSODEMO", "secret_access_key": "demo-secret-key"}))
	if err != nil {
		t.Fatal(err)
	}
	files := Files(r, "/R")
	if !strings.Contains(string(files["env"]), "AWS_SECRET_ACCESS_KEY=demo-secret-key") || !strings.Contains(string(files["password"]), rpw) {
		t.Fatal(files)
	}
	s := Session{RepoFile: "/run/itso/backup/op/repository", PasswordFile: "/run/itso/backup/op/password", EnvFile: "/run/itso/backup/op/env", CacheDir: "/var/cache/itso/restic"}
	bin, argv := s.Wrap(false, "/home/anphat", append([]string{"backup"}, s.Global(r.Dest)...))
	line := bin + " " + strings.Join(argv, " ")
	for _, secret := range []string{rpw, "demo-secret-key", "AKIAITSODEMO"} {
		if strings.Contains(line, secret) {
			t.Fatalf("bí mật %q lộ trong argv: %s", secret, line)
		}
	}
	for _, want := range []string{"--slice=itso-maint.slice", "CPUQuota=50%", "IOWeight=10", "Nice=10", "EnvironmentFile=/run/itso/backup/op/env",
		"--working-directory=/home/anphat", "-- /usr/bin/restic backup --repository-file /run/itso/backup/op/repository --password-file"} {
		if !strings.Contains(line, want) {
			t.Fatalf("thiếu %q trong %s", want, line)
		}
	}
	if bin, _ := s.Wrap(true, "", []string{"snapshots"}); bin != "restic" {
		t.Fatal("sandbox chạy restic trực tiếp")
	}
	rest, _ := ParseRepo(repoParams(map[string]any{"type": "rest", "destination_uuid": dst, "url": "https://rest.itso.local", "user": "itso", "password": "restpassword1"}))
	_, argv = s.Wrap(false, "", append([]string{"init"}, s.Global(rest.Dest)...))
	if strings.Contains(strings.Join(argv, " "), "restpassword1") {
		t.Fatal("mật khẩu rest lộ trong argv")
	}
}

func TestSFTPCommand(t *testing.T) {
	d := Dest{Type: "sftp", DestinationUUID: dst, Host: "backup2.itso.local", Port: 2222, User: "itso-backup", Path: "/srv"}
	got := d.SFTPCommand("/K", "/KH")
	want := "/usr/bin/ssh -i /K -p 2222 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/KH -o ConnectTimeout=20 -o ServerAliveInterval=30 -l itso-backup -- backup2.itso.local -s sftp"
	if got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
}

func TestExcludesTagsSnapshots(t *testing.T) {
	ex := ExcludeArgs("/R/home/anphat", []string{"*.log", "sites/*/cache"})
	j := strings.Join(ex, " ")
	for _, want := range []string{"--exclude=/R/home/anphat/tmp", "--exclude=/R/home/anphat/.cache", "--exclude=*.log", "--exclude=/R/home/anphat/sites/*/cache", "--exclude=*.sock"} {
		if !strings.Contains(j, want) {
			t.Fatalf("thiếu %s trong %s", want, j)
		}
	}
	for _, s := range []string{"/etc", "../x", "-x", "a\nb", "a b", "sites/../../root"} {
		if ValidExclude(s) {
			t.Fatalf("exclude %q phải bị từ chối", s)
		}
	}
	for _, s := range []string{"latest", "4F2A9C1E", "4f2a9c", "4f2a9c1e --target /"} {
		if ValidSnapshotID(s) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"--tag=x", "type:files,account:x", "itso-meta", "of:12345678"} {
		if ValidTag(s) {
			t.Fatalf("tag %q phải bị từ chối từ params", s)
		}
	}
	out := []byte(`[{"id":"aaaaaaaa11","time":"2026-11-20T02:00:00Z","tags":["itso","type:files"],"paths":["/home/x"],"hostname":"h"},
{"id":"bbbbbbbb22","time":"2026-11-21T02:00:00Z","tags":["itso-meta","of:aaaaaaaa"],"paths":["/itso-meta.json"],"hostname":"h"},
{"id":"cccccccc33","time":"2026-11-21T02:00:00Z","tags":["itso","type:db"],"paths":["/db/x.sql"],"hostname":"h"}]`)
	list, err := ParseSnapshots(out, 10)
	if err != nil || len(list) != 2 || list[0].ID != "cccccccc33" {
		t.Fatalf("%v %+v", err, list)
	}
}

func TestReadNodesDirectChildrenOnly(t *testing.T) {
	in := strings.Join([]string{
		`{"struct_type":"snapshot","id":"x"}`,
		`{"name":"sites","type":"dir","path":"/sites","struct_type":"node"}`,
		`{"name":"a.vn","type":"dir","path":"/sites/a.vn","struct_type":"node"}`,
		`{"name":"index.php","type":"file","path":"/sites/a.vn/index.php","size":3,"mode":420,"struct_type":"node"}`,
		`{"name":"b.vn","type":"dir","path":"/sites/b.vn","struct_type":"node"}`,
	}, "\n")
	n, tr, err := ReadNodes(strings.NewReader(in), "sites", 10)
	if err != nil || tr || len(n) != 2 || n[0].Name != "a.vn" {
		t.Fatalf("%v %v %+v", err, tr, n)
	}
	n, tr, _ = ReadNodes(strings.NewReader(in), "sites", 1)
	if !tr || len(n) != 1 {
		t.Fatal("phải báo truncated")
	}
	n, _, _ = ReadNodes(strings.NewReader(in), ".", 10)
	if len(n) != 1 || RelPath(n[0].Path) != "sites" {
		t.Fatal(n)
	}
}

func TestClassifyAndRedact(t *testing.T) {
	cases := map[string]string{
		"Fatal: wrong password or no key found":                                   "repo_auth_failed",
		"unable to create lock in backend: repository is already locked by PID 1": "repo_locked",
		"Fatal: unable to open config file: Stat: stat /x/config: no such file or directory\nIs there a repository at the following location?": "repo_not_initialized",
		"Host key verification failed.":                                        "host_key_mismatch",
		"dial tcp: lookup s3.example.com: no such host":                        "dependency_unavailable",
		"Fatal: create repository at rest:https://itso:secret@h/x failed: ...": "precondition_failed",
	}
	for in, want := range cases {
		e := Classify(1, in)
		if e.Code != want {
			t.Fatalf("%q → %s, muốn %s", in, e.Code, want)
		}
		if strings.Contains(e.Msg, "secret@") {
			t.Fatal("chưa che credential: " + e.Msg)
		}
	}
}

func TestManifestSkipsSymlinkAndChanged(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "sites/a.vn"), 0o755))
	must(os.MkdirAll(filepath.Join(root, "tmp"), 0o755))
	must(os.WriteFile(filepath.Join(root, "sites/a.vn/index.php"), []byte("hi"), 0o644))
	must(os.WriteFile(filepath.Join(root, "tmp/sess"), []byte("x"), 0o644))
	must(os.Symlink("/etc/passwd", filepath.Join(root, "sites/a.vn/link")))
	m := SampleManifest(root, ".")
	if len(m) != 1 || m["sites/a.vn/index.php"] == "" {
		t.Fatalf("manifest chỉ có file thường ngoài tmp: %v", m)
	}
	must(os.WriteFile(filepath.Join(root, "sites/a.vn/index.php"), []byte("changed"), 0o644))
	Recheck(root, m)
	if len(m) != 0 {
		t.Fatal("file đổi sau backup phải bị bỏ khỏi manifest")
	}
}

// ---- probe: SSH server thật trong tiến trình, S3/rest giả bằng httptest.

func TestProbeSFTPPinsAndDetectsMismatch(t *testing.T) {
	priv, pub, err := GenerateSSHKey("itso-backup-test")
	if err != nil || !strings.HasPrefix(pub, "ssh-ed25519 ") {
		t.Fatal(err, pub)
	}
	clientPub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(pub))
	_, hk, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(hk)
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		if string(k.Marshal()) == string(clientPub.Marshal()) {
			return &ssh.Permissions{}, nil
		}
		return nil, os.ErrPermission
	}}
	cfg.AddHostKey(hostSigner)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					c.Close()
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					ch, creqs, _ := nc.Accept()
					go func() {
						for r := range creqs {
							_ = r.Reply(r.Type == "subsystem", nil)
						}
					}()
					_ = ch
				}
			}(c)
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	d := Dest{Type: "sftp", DestinationUUID: dst, Host: "127.0.0.1", Port: port, User: "itso", Path: "/srv"}
	p, err := ProbeSFTP(context.Background(), d, priv, "", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if p.Fingerprint != ssh.FingerprintSHA256(hostSigner.PublicKey()) || !strings.HasPrefix(p.KnownHosts, "[127.0.0.1]:") {
		t.Fatal(p)
	}
	if _, err := ProbeSFTP(context.Background(), d, priv, p.Fingerprint, 5*time.Second); err != nil {
		t.Fatal("host key đã ghim phải qua:", err)
	}
	_, err = ProbeSFTP(context.Background(), d, priv, "SHA256:"+strings.Repeat("A", 43), 5*time.Second)
	if e, ok := err.(*Error); !ok || e.Code != "host_key_mismatch" {
		t.Fatal("host key lệch phải bị từ chối:", err)
	}
	other, _, _ := GenerateSSHKey("x")
	_, err = ProbeSFTP(context.Background(), d, other, "", 5*time.Second)
	if e, ok := err.(*Error); !ok || e.Code != "repo_auth_failed" {
		t.Fatal("khóa chưa thêm vào authorized_keys phải là repo_auth_failed:", err)
	}
}

func TestProbeS3AndRest(t *testing.T) {
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKIAITSODEMO/") {
			w.WriteHeader(403)
			return
		}
		if r.URL.RawQuery == "object-lock=" {
			_, _ = w.Write([]byte(`<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>`))
		}
	}))
	defer s3.Close()
	d := Dest{Type: "s3", Endpoint: s3.URL, Bucket: "itso-backup", AccessKeyID: "AKIAITSODEMO", SecretAccessKey: "demo-secret-key"}
	days, err := ProbeS3(context.Background(), s3.Client(), d, time.Now())
	if err != nil || days == nil || *days != 30 {
		t.Fatal(err, days)
	}
	d.AccessKeyID = "WRONGKEY1"
	if _, err := ProbeS3(context.Background(), s3.Client(), d, time.Now()); err == nil || err.(*Error).Code != "repo_auth_failed" {
		t.Fatal(err)
	}
	for _, appendOnly := range []bool{true, false} {
		rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if u, p, _ := r.BasicAuth(); u != "itso" || p != "restpassword1" {
				w.WriteHeader(401)
				return
			}
			if r.Method == http.MethodDelete {
				if appendOnly {
					w.WriteHeader(403)
				} else {
					w.WriteHeader(404)
				}
			}
		}))
		got, err := ProbeRest(context.Background(), rs.Client(), Dest{URL: rs.URL, User: "itso", Password: "restpassword1"})
		rs.Close()
		if err != nil || got != appendOnly {
			t.Fatal(appendOnly, got, err)
		}
	}
}

// FuzzParseDest: mọi đích được chấp nhận đều cho URL/sftp.command không có ký tự xuống dòng/khoảng trắng lạ và
// sftp.command luôn đúng số thành phần (không chèn được tùy chọn ssh).
func FuzzParseDest(f *testing.F) {
	f.Add("sftp", "backup2.itso.local", "itso-backup", "/srv/backup", "https://s3.example.com", 22)
	f.Add("s3", "h", "u", "/p", "https://s3.example.com:9000/x", 1)
	f.Add("rest", "h", "u", "/p", "https://rest.itso.local/a", 443)
	f.Fuzz(func(t *testing.T, typ, host, user, p, u string, port int) {
		d := map[string]any{"type": typ, "destination_uuid": dst, "host": host, "port": port, "user": user, "path": p,
			"endpoint": u, "url": u, "bucket": "itso-backup", "access_key_id": "AKIAITSODEMO", "secret_access_key": "demo-secret-key",
			"password": "restpassword1"}
		for k := range d {
			if typ == "sftp" && (k == "endpoint" || k == "url" || k == "password" || k == "secret_access_key") {
				delete(d, k)
			}
		}
		r, err := ParseRepo(repoParams(d))
		if err != nil {
			return
		}
		if strings.ContainsAny(r.URL("/R"), "\n\r\x00") {
			t.Fatalf("URL có ký tự điều khiển: %q", r.URL("/R"))
		}
		if r.Dest.Type == "sftp" {
			if n := len(strings.Fields(r.Dest.SFTPCommand("/K", "/KH"))); n != 23 {
				t.Fatalf("sftp.command bị chèn thành phần (%d): %q", n, r.Dest.SFTPCommand("/K", "/KH"))
			}
		}
	})
}
