package compose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const uuid = "8a1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"

func opts() Options {
	return Options{ProjectUUID: uuid, Allocated: []int64{20001, 20002, 20003}, Defaults: Limits{MemMB: 512, CPUs: 1, Pids: 256}}
}

func rules(r Result, sev string) []string {
	var out []string
	for _, f := range r.Findings {
		if sev == "" || f.Severity == sev {
			out = append(out, f.Rule)
		}
	}
	return out
}

func has(r Result, rule string) bool {
	for _, f := range r.Findings {
		if f.Rule == rule && f.Severity == "error" {
			return true
		}
	}
	return false
}

// Vector dùng chung với panel (contracts/test-vectors/evil-inputs.json, nhóm compose_yaml): validator Go phải chặn
// mọi vector reject (kể cả tầng semantic) và nhận vector accept.
func TestSharedVectors(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../contracts/test-vectors/evil-inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Categories map[string]struct {
			Vectors []struct {
				Input  json.RawMessage `json:"input"`
				Expect string          `json:"expect"`
				Note   string          `json:"note"`
			} `json:"vectors"`
		} `json:"categories"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	c, ok := v.Categories["compose_yaml"]
	if !ok || len(c.Vectors) < 10 {
		t.Fatal("thiếu nhóm vector compose_yaml")
	}
	for _, x := range c.Vectors {
		var in string
		if json.Unmarshal(x.Input, &in) != nil {
			t.Fatalf("vector không phải chuỗi: %s", x.Input)
		}
		r := Validate([]byte(in), opts())
		if x.Expect == "reject" && r.OK {
			t.Errorf("%q phải bị chặn (%s)", in, x.Note)
		}
		if x.Expect == "accept" && !r.OK {
			t.Errorf("%q phải được nhận: %+v", in, r.Findings)
		}
	}
}

// Bảng chặn: mỗi dòng phải sinh đúng rule (error).
func TestBlockTable(t *testing.T) {
	svc := func(extra string) string { return "services:\n  app:\n    image: nginx:1.27\n" + extra }
	cases := []struct{ name, yaml, rule string }{
		{"privileged", svc("    privileged: true\n"), RulePrivileged},
		{"cap SYS_ADMIN", svc("    cap_add: [SYS_ADMIN]\n"), RuleCapAdd},
		{"cap ALL", svc("    cap_add: [ALL]\n"), RuleCapAdd},
		{"devices", svc("    devices: [\"/dev/sda:/dev/sda\"]\n"), RuleDevices},
		{"bind /srv", svc("    volumes: [\"/srv/data:/data\"]\n"), RuleBindMount},
		{"bind long /srv", svc("    volumes:\n      - type: bind\n        source: /srv/x\n        target: /x\n"), RuleBindMount},
		{"host network", svc("    network_mode: host\n"), RuleHostNetwork},
		{"container network", svc("    network_mode: \"container:abc\"\n"), RuleHostNetwork},
		{"pid host", svc("    pid: host\n"), RuleHostPID},
		{"ipc host", svc("    ipc: host\n"), RuleHostIPC},
		{"userns host", svc("    userns_mode: host\n"), RuleHostUserns},
		{"seccomp", svc("    security_opt: [\"seccomp=unconfined\"]\n"), RuleSecurityOpt},
		{"apparmor", svc("    security_opt: [\"apparmor:unconfined\"]\n"), RuleSecurityOpt},
		{"sysctls", svc("    sysctls: {net.ipv4.ip_forward: 1}\n"), RuleSecurityOpt},
		{"docker.sock", svc("    volumes: [\"/var/run/docker.sock:/s\"]\n"), RuleDockerSocket},
		{"run docker.sock", svc("    volumes: [\"/run/docker.sock:/s:ro\"]\n"), RuleDockerSocket},
		{"bind /", svc("    volumes: [\"/:/host\"]\n"), RuleBindMountSystem},
		{"bind /etc/..", svc("    volumes: [\"/srv/../etc:/x\"]\n"), RuleBindMountSystem},
		{"bind /var (cha của /var/lib/docker)", svc("    volumes: [\"/var:/x\"]\n"), RuleBindMountSystem},
		{"bind /var/lib/docker", svc("    volumes: [\"/var/lib/docker:/x\"]\n"), RuleBindMountSystem},
		{"bind /home", svc("    volumes: [\"/home/anphat:/x\"]\n"), RuleBindMountSystem},
		{"bind ~", svc("    volumes: [\"~/.ssh:/x\"]\n"), RuleBindMountSystem},
		{"bind ../", svc("    volumes: [\"../../etc:/x\"]\n"), RuleBindMountSystem},
		{"bind . (chứa compose.yaml)", svc("    volumes: [\".:/x\"]\n"), RuleBindMountSystem},
		{"propagation", svc("    volumes:\n      - type: bind\n        source: ./data\n        target: /x\n        bind: {propagation: rshared}\n"), RuleBindMountSystem},
		{"driver_opts", "services:\n  app:\n    image: nginx:1.27\nvolumes:\n  d:\n    driver_opts: {type: none, o: bind, device: /etc}\n", RuleBindMountSystem},
		{"build", "services:\n  app:\n    build: .\n", RuleBuild},
		{"no services", "services: {}\n", RuleServices},
		{"bad service name", "services:\n  App:\n    image: nginx:1.27\n", RuleServices},
		{"no image", "services:\n  app:\n    command: x\n", RuleServices},
		{"port 22", svc("    ports: [\"0.0.0.0:22:22\"]\n"), RuleReservedPort},
		{"port 443", svc("    ports: [\"443:443\"]\n"), RuleReservedPort},
		{"port 8443 long", svc("    ports:\n      - target: 80\n        published: 8443\n"), RuleReservedPort},
		{"port range", svc("    ports: [\"8000-8010:8000-8010\"]\n"), RuleYAML},
		{"too many ports", svc("    ports: [\"1:1\", \"2:2\", \"3:3\", \"4:4\"]\n"), RuleServices},
		{"alias", "x: &a [*a, *a]\nservices: *a\n", RuleYAML},
		{"merge key", "services:\n  app: &b\n    image: nginx:1.27\n  web:\n    <<: *b\n", RuleYAML},
		{"tag", "services:\n  app:\n    image: !!binary bmdpbng=\n", RuleYAML},
		{"custom tag", "services:\n  app:\n    image: !evil nginx\n", RuleYAML},
		{"dup key", svc("    privileged: false\n    privileged: true\n"), RuleYAML},
		{"multi doc", svc("") + "---\nservices: {}\n", RuleYAML},
		{"top include", "include: [x.yaml]\n" + svc(""), RuleYAML},
		{"top name", "name: other\n" + svc(""), RuleYAML},
		{"env_file", svc("    env_file: /etc/shadow\n"), RuleYAML},
		{"extends", svc("    extends: {file: /etc/x.yml, service: a}\n"), RuleYAML},
		{"volumes_from", svc("    volumes_from: [other]\n"), RuleYAML},
		{"container_name", svc("    container_name: panel\n"), RuleYAML},
		{"cgroup_parent", svc("    cgroup_parent: /\n"), RuleYAML},
		{"deploy", svc("    deploy: {resources: {}}\n"), RuleYAML},
		{"interp port", svc("    ports: [\"${P}:80\"]\n"), RuleYAML},
		{"interp privileged", svc("    privileged: ${PRIV}\n"), RuleYAML},
		{"interp volume", svc("    volumes: [\"$SRC:/x\"]\n"), RuleYAML},
		{"external volume", "services:\n  app:\n    image: nginx:1.27\n    volumes: [\"v:/d\"]\nvolumes:\n  v:\n    external: true\n", RuleYAML},
		{"volume name override", "services:\n  app:\n    image: nginx:1.27\nvolumes:\n  v:\n    name: itso_other_data\n", RuleYAML},
		{"undeclared volume", svc("    volumes: [\"v:/d\"]\n"), RuleYAML},
		{"reserved label", svc("    labels: {io.itso.project: x}\n"), RuleYAML},
		{"compose label", svc("    labels: [\"com.docker.compose.project=itso_x\"]\n"), RuleYAML},
		{"bad image", "services:\n  app:\n    image: \"nginx --privileged\"\n", RuleYAML},
		{"network driver host", svc("") + "networks:\n  n:\n    driver: host\n", RuleHostNetwork},
		{"external network", svc("") + "networks:\n  n:\n    external: true\n", RuleYAML},
	}
	for _, c := range cases {
		r := Validate([]byte(c.yaml), opts())
		if r.OK || !has(r, c.rule) {
			t.Errorf("%s: muốn rule %s, có ok=%v %v", c.name, c.rule, r.OK, r.Findings)
		}
		if r.YAML != nil || r.SHA256 != "" {
			t.Errorf("%s: không được trả YAML khi bị chặn", c.name)
		}
	}
}

func TestAcceptAndRewrite(t *testing.T) {
	src := `services:
  app:
    image: ghcr.io/itso/app:2.1.0
    environment:
      DB_URL: "postgres://${DB_USER}@db/app"
    command: ["printenv", "$$HOME"]
    ports:
      - "8080:80"
      - target: 53
        published: 5353
        protocol: udp
    volumes:
      - data:/var/lib/app
      - ./data/uploads:/uploads
      - type: tmpfs
        target: /tmp
    labels:
      - "traefik.enable=false"
    cap_add: [NET_BIND_SERVICE]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 256m
  cache:
    image: redis
    ports: ["6379"]
volumes:
  data: {}
`
	r := Validate([]byte(src), opts())
	if !r.OK {
		t.Fatalf("phải được nhận: %+v", r.Findings)
	}
	if got := strings.Join(rules(r, "warning"), ","); got != "missing_limits,latest_tag,missing_limits" {
		t.Fatalf("cảnh báo = %s", got)
	}
	want := []PortMap{{"app", 80, 20001, "tcp"}, {"app", 53, 20002, "udp"}, {"cache", 6379, 20003, "tcp"}}
	if len(r.Ports) != 3 {
		t.Fatalf("ports = %+v", r.Ports)
	}
	for i, p := range want {
		if r.Ports[i] != p {
			t.Errorf("port %d = %+v, muốn %+v", i, r.Ports[i], p)
		}
	}
	y := string(r.YAML)
	for _, s := range []string{`"127.0.0.1:20001:80/tcp"`, `"127.0.0.1:20002:53/udp"`, `"127.0.0.1:20003:6379/tcp"`,
		"io.itso.project: " + uuid, "io.itso.service: cache", "traefik.enable: \"false\"", "mem_limit: 256m", "mem_limit: 512m",
		"pids_limit: 256", "cpus: 1.0"} {
		if !strings.Contains(y, s) {
			t.Errorf("YAML thiếu %q:\n%s", s, y)
		}
	}
	if strings.Contains(y, "8080") || strings.Contains(y, "0.0.0.0") {
		t.Errorf("cổng gốc còn trong YAML:\n%s", y)
	}
	if len(r.Volumes) != 1 || r.Volumes[0] != "itso_"+uuid+"_data" || len(r.Images) != 2 {
		t.Fatalf("volumes=%v images=%v", r.Volumes, r.Images)
	}
	if len(r.SHA256) != 64 {
		t.Fatal("thiếu sha256")
	}
	// Idempotent: validate lại YAML đã viết lại cho đúng YAML và sha256, không còn rewrite cổng.
	r2 := Validate(r.YAML, opts())
	if !r2.OK || r2.SHA256 != r.SHA256 || string(r2.YAML) != y {
		t.Fatalf("validate lại phải ổn định:\n%s\n---\n%s", y, r2.YAML)
	}
	for _, rw := range r2.Rewrites {
		if strings.Contains(rw.Path, "ports") {
			t.Fatalf("validate lại không được viết lại cổng: %+v", rw)
		}
	}
	svcs, err := Services(r.YAML)
	if err != nil || len(svcs) != 2 || svcs[0].Volumes[0] != "data" || svcs[0].RelBinds[0] != "data/uploads" || svcs[1].Ports[0].HostPort != 20003 {
		t.Fatalf("Services = %+v, %v", svcs, err)
	}
}

func TestOverrides(t *testing.T) {
	src := []byte("services:\n  app:\n    image: nginx:1.27\n    privileged: true\n    volumes: [\"/srv/media:/media\"]\n")
	if r := Validate(src, opts()); r.OK || !has(r, RulePrivileged) || !has(r, RuleBindMount) {
		t.Fatalf("chưa ghi đè phải bị chặn: %+v", r.Findings)
	}
	o := opts()
	o.Overrides = []Override{{Rule: RulePrivileged, Reason: "cần quyền cho VPN", By: uuid}}
	if r := Validate(src, o); r.OK || has(r, RulePrivileged) || !has(r, RuleBindMount) {
		t.Fatalf("ghi đè privileged chỉ gỡ privileged: %+v", r.Findings)
	}
	o.Overrides = append(o.Overrides, Override{Rule: RuleBindMount, Reason: "thư viện media chung", By: uuid})
	r := Validate(src, o)
	if !r.OK {
		t.Fatalf("ghi đè đủ phải được nhận: %+v", r.Findings)
	}
	found := false
	for _, f := range r.Findings {
		if f.Rule == RulePrivileged && f.Severity == "warning" && strings.Contains(f.Message, "được ghi đè") {
			found = true
		}
	}
	if !found {
		t.Fatal("finding ghi đè phải còn ở dạng cảnh báo")
	}
	// Rule không ghi đè được: override bị bỏ qua.
	o.Overrides = []Override{{Rule: RuleDockerSocket, Reason: "muốn portainer", By: uuid}}
	if r := Validate([]byte("services:\n  app:\n    image: nginx:1.27\n    volumes: [\"/var/run/docker.sock:/s\"]\n"), o); r.OK {
		t.Fatal("docker.sock không bao giờ ghi đè được")
	}
	// /home chỉ thành bind_mount (ghi đè được) khi allow_home_bind.
	o = opts()
	o.AllowHomeBind = true
	if r := Validate([]byte("services:\n  app:\n    image: nginx:1.27\n    volumes: [\"/home/anphat/media:/m\"]\n"), o); !has(r, RuleBindMount) || has(r, RuleBindMountSystem) {
		t.Fatalf("allow_home_bind: %+v", r.Findings)
	}
}

func TestLatestTag(t *testing.T) {
	for img, warn := range map[string]bool{"nginx": true, "nginx:latest": true, "nginx:1.27": false,
		"registry.local:5000/team/app": true, "nginx@sha256:" + strings.Repeat("a", 64): false} {
		r := Validate([]byte("services:\n  app:\n    image: \""+img+"\"\n    mem_limit: 1g\n    cpus: 1\n    pids_limit: 100\n"), opts())
		if !r.OK {
			t.Fatalf("%s: %+v", img, r.Findings)
		}
		if got := len(rules(r, "warning")) > 0; got != warn {
			t.Errorf("%s: cảnh báo latest = %v", img, got)
		}
	}
}

func TestBadOptions(t *testing.T) {
	o := opts()
	o.ProjectUUID = "../x"
	if Validate([]byte("services:\n  app:\n    image: nginx:1.27\n"), o).OK {
		t.Fatal("project_uuid sai phải bị chặn")
	}
	if Validate([]byte(strings.Repeat("a", MaxYAML+1)), opts()).OK {
		t.Fatal("quá kích thước phải bị chặn")
	}
}

// Fuzz: không panic; YAML nhận được luôn validate lại ra cùng kết quả và không chứa cấu hình nguy hiểm.
func FuzzValidate(f *testing.F) {
	for _, s := range []string{
		"services:\n  app:\n    image: nginx:1.27\n",
		"services:\n  app:\n    image: nginx:1.27\n    ports: [\"8080:80\", \"53/udp\"]\n",
		"services:\n  app:\n    image: nginx\n    volumes: [\"d:/d\", \"./data:/x\"]\nvolumes:\n  d:\n",
		"x: &a [*a]\nservices: *a\n", "services:\n  a:\n    privileged: yes\n", "{services: {a: {image: x, network_mode: host}}}",
		"services:\n  app:\n    image: nginx\n    volumes:\n      - type: bind\n        source: /\n        target: /h\n",
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		r := Validate(b, opts())
		if !r.OK {
			return
		}
		y := string(r.YAML)
		for _, bad := range []string{"privileged: true", "network_mode: host", "docker.sock", "pid: host", "0.0.0.0:"} {
			if strings.Contains(y, bad) {
				t.Fatalf("YAML được nhận chứa %q:\n%s", bad, y)
			}
		}
		r2 := Validate(r.YAML, opts())
		if !r2.OK || r2.SHA256 != r.SHA256 {
			t.Fatalf("validate lại không ổn định:\n%s\n%+v", y, r2.Findings)
		}
		if _, err := Services(r.YAML); err != nil {
			t.Fatalf("Services lỗi trên YAML hợp lệ: %v", err)
		}
	})
}
