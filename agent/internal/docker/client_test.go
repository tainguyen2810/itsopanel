package docker

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// Engine giả qua unix socket thật: kiểm đường dẫn API, header X-Registry-Auth, lỗi trong luồng pull, demux log.
func fakeEngine(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return NewClient(sock)
}

func frame(stream byte, s string) []byte {
	b := make([]byte, 8+len(s))
	b[0] = stream
	binary.BigEndian.PutUint32(b[4:], uint32(len(s)))
	copy(b[8:], s)
	return b
}

func TestClient(t *testing.T) {
	var gotAuth string
	c := fakeEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/"+APIVersion+"/") {
			http.Error(w, "bad version", 400)
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/"+APIVersion)
		switch {
		case p == "/version":
			_, _ = w.Write([]byte(`{"Version":"26.1.3","ApiVersion":"1.45"}`))
		case p == "/containers/json":
			if r.URL.Query().Get("all") != "1" || !strings.Contains(r.URL.Query().Get("filters"), "io.itso.project=x") {
				http.Error(w, "filters", 400)
				return
			}
			_, _ = w.Write([]byte(`[{"Id":"abc123abc123","Names":["/web-1"],"Image":"nginx:1.27","ImageID":"sha256:1","State":"running",
				"Status":"Up 3 minutes (healthy)","Labels":{"io.itso.project":"x"},"Ports":[{"IP":"127.0.0.1","PrivatePort":80,"PublicPort":20001,"Type":"tcp"}]}]`))
		case p == "/containers/abc123abc123/json":
			_, _ = w.Write([]byte(`{"Id":"abc123abc123","Image":"sha256:1","Config":{"Image":"nginx:1.27","Tty":false},"State":{"Status":"running","Health":{"Status":"healthy"}},
				"HostConfig":{"Privileged":false},"NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"20001"}]}}}`))
		case p == "/containers/abc123abc123/logs":
			_, _ = w.Write(append(frame(1, "out 1\n"), frame(2, "err 2\nout 3\n")...))
		case p == "/containers/missing0000/json":
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"message":"No such container"}`))
		case p == "/images/create":
			gotAuth = r.Header.Get("X-Registry-Auth")
			if r.URL.Query().Get("fromImage") == "ghcr.io/itso/private" {
				_, _ = w.Write([]byte(`{"status":"Pulling"}` + "\n" + `{"error":"unauthorized: authentication required"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"Pulling from library/nginx"}` + "\n" + `{"status":"Done"}`))
		case p == "/volumes/data" && r.Method == "DELETE":
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"message":"volume is in use"}`))
		case p == "/auth":
			var a Auth
			_ = json.NewDecoder(r.Body).Decode(&a)
			if a.Password != "ok" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"message":"incorrect username or password"}`))
				return
			}
			_, _ = w.Write([]byte(`{"Status":"Login Succeeded"}`))
		default:
			http.Error(w, "unknown "+p, 404)
		}
	})
	ctx := context.Background()
	v, err := c.Version(ctx)
	if err != nil || v.Version != "26.1.3" {
		t.Fatal(v, err)
	}
	cs, err := c.Containers(ctx, map[string]string{"io.itso.project": "x"})
	if err != nil || len(cs) != 1 || cs[0].Name != "web-1" || cs[0].Health != "healthy" || cs[0].Ports[0].PublicPort != 20001 {
		t.Fatal(cs, err)
	}
	d, err := c.Inspect(ctx, "abc123abc123")
	if err != nil || d.Image != "nginx:1.27" || d.Health != "healthy" || d.Ports[0].PublicPort != 20001 {
		t.Fatal(d, err)
	}
	lines, cut, err := c.Logs(ctx, "abc123abc123", 2)
	if err != nil || !cut || strings.Join(lines, "|") != "err 2|out 3" {
		t.Fatal(lines, cut, err)
	}
	if _, err := c.Inspect(ctx, "missing0000"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err := c.Pull(ctx, "nginx:1.27", &Auth{Username: "u", Password: "p", ServerAddress: "docker.io"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.URLEncoding.DecodeString(gotAuth)
	if !strings.Contains(string(raw), `"username":"u"`) {
		t.Fatalf("X-Registry-Auth = %s", raw)
	}
	if err := c.Pull(ctx, "ghcr.io/itso/private:1", nil); !errors.Is(err, ErrAuth) {
		t.Fatalf("lỗi trong luồng pull phải thành ErrAuth: %v", err)
	}
	if err := c.RemoveVolume(ctx, "data"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := c.Login(ctx, Auth{Username: "u", Password: "bad"}); !errors.Is(err, ErrAuth) {
		t.Fatal(err)
	}
	if err := c.Login(ctx, Auth{Username: "u", Password: "ok"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Action(ctx, "abc123abc123", "kill"); err == nil {
		t.Fatal("action ngoài danh sách phải bị từ chối")
	}
	if _, err := NewClient(filepath.Join(t.TempDir(), "none.sock")).Version(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestRefHelpers(t *testing.T) {
	for ref, want := range map[string][3]string{
		"nginx":                          {"nginx", "latest", "docker.io"},
		"nginx:1.27":                     {"nginx", "1.27", "docker.io"},
		"registry.local:5000/team/app":   {"registry.local:5000/team/app", "latest", "registry.local:5000"},
		"ghcr.io/itso/app:2.1@sha256:ab": {"ghcr.io/itso/app", "2.1", "ghcr.io"},
		"localhost/x:1":                  {"localhost/x", "1", "localhost"},
		"library/redis:7":                {"library/redis", "7", "docker.io"},
	} {
		r, tag := SplitRef(ref)
		if r != want[0] || tag != want[1] || RegistryHost(ref) != want[2] {
			t.Errorf("%s → %s %s %s", ref, r, tag, RegistryHost(ref))
		}
	}
	if HealthFromStatus("Up 1 minute (health: starting)") != "starting" || HealthFromStatus("Up (unhealthy)") != "unhealthy" || HealthFromStatus("Exited (0)") != "" {
		t.Fatal("HealthFromStatus")
	}
	if l, cut := SplitLines([]byte(strings.Repeat("x", 9000)+"\nb\n"), 10); cut != true || len(l[0]) != 8192 {
		t.Fatal("dòng dài phải bị cắt")
	}
}
