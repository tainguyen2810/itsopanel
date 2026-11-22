package ops_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/policy"
	"itso.local/agent/internal/registry"
)

const (
	cpUUID  = "0194dd10-0001-7000-8000-000000000001"
	cpOther = "0194dd10-0001-7000-8000-000000000002"
	cpUser  = "01938a01-0003-7000-8000-000000000001"
	cpReg   = "0194ee10-0001-7000-8000-000000000009"
)

func dockerEnv(t *testing.T) (*env, *docker.Fake) {
	t.Helper()
	e := newEnv(t)
	fk := docker.NewFake()
	fk.MkdirMount = func(p string) { _ = os.MkdirAll(filepath.Join(e.fs.Root, p), 0o755) }
	e.sim.Docker = fk
	e.d.Docker = fk
	e.d.DockerPoll = time.Millisecond
	return e, fk
}

func proj(uuid string) map[string]any { return map[string]any{"project_uuid": uuid, "name": "cache"} }

func validateParams(uuid, yaml string, ports ...int) map[string]any {
	ap := []any{}
	for _, p := range ports {
		ap = append(ap, p)
	}
	return map[string]any{"project": proj(uuid), "compose_yaml": yaml, "allocated_ports": ap,
		"defaults": map[string]any{"mem_limit_mb": 512, "cpus": 1.0, "pids_limit": 256}, "overrides": []any{}, "allow_home_bind": false}
}

const cacheYAML = `services:
  redis:
    image: redis:7.4-alpine
    ports: ["6379:6379"]
    volumes: ["data:/data"]
  web:
    image: nginx:1.27
    ports: ["8080:80"]
volumes:
  data: {}
`

// validate + apply một project; trả kết quả validate.
func applyProject(t *testing.T, e *env, uuid, yaml string, env map[string]any, ports ...int) map[string]any {
	t.Helper()
	v := e.h.OK(contracts.OpComposeValidate, validateParams(uuid, yaml, ports...))
	if v["ok"] != true {
		t.Fatalf("validate: %v", v["findings"])
	}
	if env == nil {
		env = map[string]any{}
	}
	e.h.OK(contracts.OpComposeApply, map[string]any{"project": proj(uuid), "revision": 1, "validated_yaml": v["validated_yaml"],
		"validated_sha256": v["validated_sha256"], "env": env, "ports": v["ports"], "registry_uuids": []any{}})
	return v
}

func TestComposeLifecycle(t *testing.T) {
	e, fk := dockerEnv(t)
	bad := e.h.OK(contracts.OpComposeValidate, validateParams(cpUUID, "services:\n  app:\n    image: nginx:1.27\n    privileged: true\n"))
	if bad["ok"] != false || bad["validated_yaml"] != nil || bad["findings"].([]any)[0].(map[string]any)["rule"] != "privileged" {
		t.Fatal(bad)
	}
	v := e.h.OK(contracts.OpComposeValidate, validateParams(cpUUID, cacheYAML, 20001, 20002))
	y := v["validated_yaml"].(string)
	if v["ok"] != true || !strings.Contains(y, `"127.0.0.1:20001:6379/tcp"`) || len(v["ports"].([]any)) != 2 {
		t.Fatal(v)
	}
	apply := func(yaml, sum string, env map[string]any) map[string]any {
		return map[string]any{"project": proj(cpUUID), "revision": 1, "validated_yaml": yaml, "validated_sha256": sum, "env": env,
			"ports": v["ports"], "registry_uuids": []any{}}
	}
	sum := v["validated_sha256"].(string)
	// YAML không do validator trả (sửa một byte, tự tính sha) → compose_rejected.
	evil := strings.Replace(y, "nginx:1.27", "nginx:1.28", 1)
	e.h.Fail(contracts.OpComposeApply, apply(evil, sum, map[string]any{}), "compose_rejected")
	e.h.Fail(contracts.OpComposeApply, apply(evil, sha(evil), map[string]any{}), "compose_rejected")
	// env: biến COMPOSE_* và nháy đơn bị từ chối.
	e.h.Fail(contracts.OpComposeApply, apply(y, sum, map[string]any{"COMPOSE_FILE": "/etc/x.yml"}), "invalid_params")
	e.h.Fail(contracts.OpComposeApply, apply(y, sum, map[string]any{"PASS": "a'b"}), "invalid_params")
	e.fake.Reset()
	res := e.h.OK(contracts.OpComposeApply, apply(y, sum, map[string]any{"REDIS_PASSWORD": "s3cr3t-value"}))
	svcs := res["services"].([]any)
	if len(svcs) != 2 || svcs[0].(map[string]any)["state"] != "running" || svcs[0].(map[string]any)["container_id"] == nil {
		t.Fatal(res)
	}
	dir := "/var/lib/itso/compose/" + cpUUID
	if e.mode(dir).Perm() != 0o700 || e.mode(dir+"/.env") != 0o600 || e.mode(dir+"/compose.yaml") != 0o600 || !e.exists(dir+"/data") {
		t.Fatal("quyền thư mục project sai", e.mode(dir), e.mode(dir+"/.env"), e.mode(dir+"/compose.yaml"))
	}
	if !strings.Contains(e.file(dir+"/.env"), "REDIS_PASSWORD='s3cr3t-value'") {
		t.Fatal(e.file(dir + "/.env"))
	}
	want := "docker --config /etc/itso/docker-client compose -p itso_" + cpUUID + " --project-directory " + dir + " -f " + dir +
		"/compose.yaml --env-file " + dir + "/.env up -d --remove-orphans"
	found := false
	for _, l := range e.fake.Lines() {
		if strings.Contains(l, "s3cr3t-value") {
			t.Fatalf("giá trị env lộ trong argv: %s", l)
		}
		found = found || l == want
	}
	if !found {
		t.Fatalf("argv compose up sai:\n%s", strings.Join(e.fake.Lines(), "\n"))
	}

	list := e.h.OK(contracts.OpDockerContainerList, map[string]any{"project_uuid": cpUUID})["containers"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["project_uuid"] != cpUUID || list[0].(map[string]any)["service"] != "redis" {
		t.Fatal(list)
	}
	id := list[0].(map[string]any)["id"].(string)
	ins := e.h.OK(contracts.OpDockerContainerInspect, map[string]any{"id": id})
	if ins["ports"].([]any)[0].(map[string]any)["host_ip"] != "127.0.0.1" || ins["mounts"].([]any)[0].(map[string]any)["source"] != "itso_"+cpUUID+"_data" {
		t.Fatal(ins)
	}
	fk.AddLog(id, "ready to accept connections", "line 2")
	if l := e.h.OK(contracts.OpDockerContainerLogs, map[string]any{"id": id, "lines": 1}); l["truncated"] != true || l["lines"].([]any)[0] != "line 2" {
		t.Fatal(l)
	}
	if s := e.h.OK(contracts.OpDockerContainerStats, map[string]any{"ids": []any{id}})["stats"].([]any); len(s) != 1 {
		t.Fatal(s)
	}
	if c := e.h.OK(contracts.OpDockerContainerControl, map[string]any{"id": id, "action": "stop"}); c["state"] != "exited" {
		t.Fatal(c)
	}
	if u := e.h.OK(contracts.OpComposeUp, map[string]any{"project": proj(cpUUID)}); u["running"] != float64(2) || u["total"] != float64(2) {
		t.Fatal(u)
	}
	if p := e.h.OK(contracts.OpComposePull, map[string]any{"project": proj(cpUUID), "registry_uuids": []any{}}); len(p["images"].([]any)) != 2 {
		t.Fatal(p)
	}
	// compose.yaml bị sửa ngoài agent → up từ chối.
	write(t, e.fs.Root, dir+"/compose.yaml", e.file(dir+"/compose.yaml")+"    privileged: true\n")
	e.h.Fail(contracts.OpComposeUp, map[string]any{"project": proj(cpUUID)}, "compose_rejected")
	write(t, e.fs.Root, dir+"/compose.yaml", y)
	if dn := e.h.OK(contracts.OpComposeDown, map[string]any{"project": proj(cpUUID)}); dn["stopped"] != float64(2) {
		t.Fatal(dn)
	}
	rm := e.h.OK(contracts.OpComposeRemove, map[string]any{"project": proj(cpUUID), "remove_volumes": true})
	if rm["removed"] != true || len(rm["volumes_removed"].([]any)) != 1 || e.exists(dir) {
		t.Fatal(rm)
	}
	if rm := e.h.OK(contracts.OpComposeRemove, map[string]any{"project": proj(cpUUID), "remove_volumes": false}); rm["removed"] != false {
		t.Fatal("remove lần 2 phải idempotent", rm)
	}
}

func sha(s string) string {
	return ops.SHA256Hex([]byte(s))
}

// Bind tương đối đi qua symlink (container tạo trong data/) → compose_rejected.
func TestComposeBindSymlink(t *testing.T) {
	e, _ := dockerEnv(t)
	y := "services:\n  app:\n    image: nginx:1.27\n    volumes: [\"./data/www:/usr/share/nginx/html\"]\n"
	applyProject(t, e, cpUUID, y, nil)
	dir := filepath.Join(e.fs.Root, "/var/lib/itso/compose/"+cpUUID+"/data")
	if err := os.Symlink("/etc", filepath.Join(dir, "www")); err != nil {
		t.Fatal(err)
	}
	e.h.Fail(contracts.OpComposeUp, map[string]any{"project": proj(cpUUID)}, "compose_rejected")
}

// Cổng trùng: tiến trình host đang nghe hoặc container project khác publish → port_unavailable.
func TestComposePortUnavailable(t *testing.T) {
	e, _ := dockerEnv(t)
	y := "services:\n  app:\n    image: nginx:1.27\n    ports: [\"80\"]\n"
	// 20001 = 0x4E21, trạng thái 0A (LISTEN).
	write(t, e.host, "/proc/net/tcp", "  sl  local_address rem_address   st\n   0: 00000000:4E21 00000000:0000 0A 00000000:00000000\n")
	v := e.h.OK(contracts.OpComposeValidate, validateParams(cpUUID, y, 20001))
	e.h.Fail(contracts.OpComposeApply, map[string]any{"project": proj(cpUUID), "revision": 1, "validated_yaml": v["validated_yaml"],
		"validated_sha256": v["validated_sha256"], "env": map[string]any{}, "ports": v["ports"], "registry_uuids": []any{}}, "port_unavailable")

	write(t, e.host, "/proc/net/tcp", "  sl  local_address rem_address   st\n")
	applyProject(t, e, cpUUID, y, nil, 20002)
	v = e.h.OK(contracts.OpComposeValidate, validateParams(cpOther, y, 20002))
	e.h.Fail(contracts.OpComposeApply, map[string]any{"project": proj(cpOther), "revision": 1, "validated_yaml": v["validated_yaml"],
		"validated_sha256": v["validated_sha256"], "env": map[string]any{}, "ports": v["ports"], "registry_uuids": []any{}}, "port_unavailable")
	// ports trong params phải khớp YAML.
	e.h.Fail(contracts.OpComposeApply, map[string]any{"project": proj(cpOther), "revision": 1, "validated_yaml": v["validated_yaml"],
		"validated_sha256": v["validated_sha256"], "env": map[string]any{}, "ports": []any{}, "registry_uuids": []any{}}, "invalid_params")
	// Project của chính nó apply lại cùng cổng: không coi là trùng.
	applyProject(t, e, cpUUID, y, nil, 20002)
}

func serviceImage(t *testing.T, fk *docker.Fake, svc string) string {
	t.Helper()
	cs, _ := fk.Containers(t.Context(), map[string]string{docker.LabelComposeService: svc})
	if len(cs) != 1 {
		t.Fatalf("service %s có %d container", svc, len(cs))
	}
	return cs[0].ImageID
}

func TestImageUpdateHealthRollback(t *testing.T) {
	e, fk := dockerEnv(t)
	y := "services:\n  web:\n    image: nginx:1.27\n"
	applyProject(t, e, cpUUID, y, nil)
	oldID := serviceImage(t, fk, "web")
	upd := map[string]any{"project": proj(cpUUID), "services": []any{"web"}, "health_timeout_sec": 10, "keep_rollbacks": 2}

	// Registry chưa có bản mới → unchanged.
	if r := e.h.OK(contracts.OpDockerImageUpdate, upd)["services"].([]any)[0].(map[string]any); r["state"] != "unchanged" {
		t.Fatal(r)
	}
	// Bản mới unhealthy → tự quay về image cũ.
	bad := fk.Publish("nginx:1.27")
	fk.Health = func(_, img string) string {
		if img == bad {
			return "unhealthy"
		}
		return "healthy"
	}
	r := e.h.OK(contracts.OpDockerImageUpdate, upd)["services"].([]any)[0].(map[string]any)
	if r["state"] != "rolled_back" || r["from_digest"] != oldID || r["to_digest"] != bad || r["reason"] == nil {
		t.Fatal(r)
	}
	if got := serviceImage(t, fk, "web"); got != oldID {
		t.Fatalf("sau rollback service chạy %s, muốn %s", got, oldID)
	}
	// Container dừng ngay → cũng quay về.
	bad2 := fk.Publish("nginx:1.27")
	fk.Health = func(_, img string) string {
		if img == bad2 {
			return "exited"
		}
		return ""
	}
	if r := e.h.OK(contracts.OpDockerImageUpdate, upd)["services"].([]any)[0].(map[string]any); r["state"] != "rolled_back" {
		t.Fatal(r)
	}
	// Bản mới healthy → updated, giữ tag rollback của image cũ.
	good := fk.Publish("nginx:1.27")
	fk.Health = nil
	e.d.Now = func() time.Time { return time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC) }
	r = e.h.OK(contracts.OpDockerImageUpdate, upd)["services"].([]any)[0].(map[string]any)
	if r["state"] != "updated" || r["rollback_tag"] != "itso-rollback/"+cpUUID+"-web:20261122100000" || serviceImage(t, fk, "web") != good {
		t.Fatal(r)
	}
	imgs := e.h.OK(contracts.OpDockerImageList, map[string]any{})["images"].([]any)
	rb := 0
	for _, i := range imgs {
		for _, tag := range i.(map[string]any)["tags"].([]any) {
			if strings.HasPrefix(tag.(string), "itso-rollback/") {
				rb++
			}
		}
	}
	if rb != 2 { // keep_rollbacks=2
		t.Fatalf("muốn 2 tag rollback, có %d", rb)
	}
	// Prune giữ image đang dùng và image rollback.
	e.h.OK(contracts.OpDockerImagePrune, map[string]any{"keep_rollback": true, "dangling_only": false})
	if serviceImage(t, fk, "web") != good {
		t.Fatal("prune không được xóa image đang dùng")
	}
	// Rollback thủ công về bản trước.
	rr := e.h.OK(contracts.OpDockerImageRollback, map[string]any{"project": proj(cpUUID), "services": []any{"web"}})
	if got := serviceImage(t, fk, "web"); got != oldID || rr["services"].([]any)[0].(map[string]any)["digest"] != oldID {
		t.Fatalf("rollback: %v, đang chạy %s", rr, got)
	}
}

func TestVolumeInUse(t *testing.T) {
	e, _ := dockerEnv(t)
	applyProject(t, e, cpUUID, cacheYAML, nil, 20001, 20002)
	name := "itso_" + cpUUID + "_data"
	vl := e.h.OK(contracts.OpDockerVolumeList, map[string]any{})["volumes"].([]any)
	if len(vl) != 1 || len(vl[0].(map[string]any)["used_by"].([]any)) != 1 || vl[0].(map[string]any)["project_uuid"] != cpUUID {
		t.Fatal(vl)
	}
	e.h.Fail(contracts.OpDockerVolumeRemove, map[string]any{"name": name}, "in_use")
	e.h.OK(contracts.OpComposeDown, map[string]any{"project": proj(cpUUID)})
	if r := e.h.OK(contracts.OpDockerVolumeRemove, map[string]any{"name": name}); r["removed"] != true {
		t.Fatal(r)
	}
	if r := e.h.OK(contracts.OpDockerVolumeCreate, map[string]any{"name": "shared-media", "project_uuid": cpUUID}); r["created"] != true {
		t.Fatal(r)
	}
	if r := e.h.OK(contracts.OpDockerVolumeCreate, map[string]any{"name": "shared-media", "project_uuid": cpUUID}); r["created"] != false {
		t.Fatal(r)
	}
}

func TestDockerUserRuleOrder(t *testing.T) {
	e, _ := dockerEnv(t)
	e.fake.Reset()
	r := e.h.OK(contracts.OpDockerFirewallSync, map[string]any{"public_interface": "eth0", "open_ports": []any{
		map[string]any{"port": 20002, "protocol": "udp", "source": "0.0.0.0/0"},
		map[string]any{"port": 20001, "protocol": "tcp", "source": "203.0.113.0/24"},
		map[string]any{"port": 20001, "protocol": "tcp", "source": "2001:db8::/32"},
	}})
	if r["rules"] != float64(6) || r["changed"] != true {
		t.Fatal(r)
	}
	want := `# Quản lý bởi itso-agent (docker.firewall.sync). Không sửa tay.
*filter
:DOCKER-USER - [0:0]
-F DOCKER-USER
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER ! -i eth0 -j RETURN
-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 20001 --ctdir ORIGINAL -s 203.0.113.0/24 -j RETURN
-A DOCKER-USER -i eth0 -p udp -m conntrack --ctorigdstport 20002 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i eth0 -j DROP
-A DOCKER-USER -j RETURN
COMMIT
`
	var stdin string
	for _, c := range e.fake.Calls {
		if c.Bin == "iptables-restore" {
			stdin = string(c.Stdin)
			if strings.Join(c.Args, " ") != "--noflush" {
				t.Fatal(c.Args)
			}
		}
	}
	if stdin != want {
		t.Fatalf("ruleset:\n%s", stdin)
	}
	if e.file("/etc/itso/docker-user.rules") != want || e.mode("/etc/itso/docker-user.rules") != 0o600 {
		t.Fatal("file rules sai")
	}
	if !strings.Contains(e.file("/etc/systemd/system/itso-docker-user.service"), "PartOf=docker.service") {
		t.Fatal("thiếu unit nạp lại DOCKER-USER")
	}
	e.h.Fail(contracts.OpDockerFirewallSync, map[string]any{"public_interface": "eth0;id", "open_ports": []any{}}, "invalid_params")
}

// Policy cục bộ tắt docker (mặc định) → mọi op docker.*/compose.* bị từ chối trước handler.
func TestDockerPolicyDisabled(t *testing.T) {
	e, _ := dockerEnv(t)
	p, err := policy.Default()
	if err != nil {
		t.Fatal(err)
	}
	r := registry.New(ops.Version)
	r.SetAllow(p.Enabled)
	if err := ops.Register(r, e.d); err != nil {
		t.Fatal(err)
	}
	h := ct.New(t, r)
	h.Fail(contracts.OpDockerHostStatus, map[string]any{}, "op_disabled")
	h.Fail(contracts.OpComposeValidate, validateParams(cpUUID, cacheYAML, 20001, 20002), "op_disabled")
	h.Fail(contracts.OpDockerContainerList, map[string]any{"project_uuid": nil}, "op_disabled")
	if err := p.Set("docker", true); err != nil {
		t.Fatal(err)
	}
	h.OK(contracts.OpDockerHostStatus, map[string]any{})
	// ops.<op>=false vẫn thắng cờ docker.
	_ = p.Set("ops.compose.apply", false)
	if p.Enabled(contracts.OpComposeApply) || !p.Enabled(contracts.OpComposeValidate) {
		t.Fatal("ops.compose.apply=false phải tắt riêng compose.apply")
	}
}

func TestContainerControlManagedOnly(t *testing.T) {
	e, fk := dockerEnv(t)
	fk.AddContainer(docker.Detail{Container: docker.Container{ID: strings.Repeat("ab", 32), Name: "portainer", State: "running", Labels: map[string]string{}}})
	e.h.Fail(contracts.OpDockerContainerControl, map[string]any{"id": strings.Repeat("ab", 32), "action": "stop"}, "precondition_failed")
	e.h.Fail(contracts.OpDockerContainerControl, map[string]any{"id": strings.Repeat("cd", 32), "action": "stop"}, "not_found")
	if l := e.h.OK(contracts.OpDockerContainerList, map[string]any{"project_uuid": nil})["containers"].([]any); len(l) != 1 || l[0].(map[string]any)["project_uuid"] != nil {
		t.Fatal(l)
	}
	// Network: không xóa network không do panel quản lý; network đang có container → in_use.
	e.h.OK(contracts.OpDockerNetworkCreate, map[string]any{"name": "shared-net", "internal": true, "project_uuid": cpUUID})
	if r := e.h.OK(contracts.OpDockerNetworkRemove, map[string]any{"name": "shared-net"}); r["removed"] != true {
		t.Fatal(r)
	}
	applyProject(t, e, cpUUID, "services:\n  app:\n    image: nginx:1.27\n", nil)
	e.h.Fail(contracts.OpDockerNetworkRemove, map[string]any{"name": "itso_" + cpUUID + "_default"}, "in_use")
	if n := e.h.OK(contracts.OpDockerNetworkList, map[string]any{})["networks"].([]any); len(n) != 4 {
		t.Fatal(n)
	}
}

func TestRegistryLoginAndPull(t *testing.T) {
	e, fk := dockerEnv(t)
	fk.Creds = map[string]string{"ghcr.io": "itso-bot:ghp_Secret123"}
	login := func(pass string) map[string]any {
		return e.h.OK(contracts.OpDockerRegistryLogin, map[string]any{"registry_uuid": cpReg, "url": "https://ghcr.io",
			"username": "itso-bot", "password": pass})
	}
	e.fake.Reset()
	if r := login("wrong-pass"); r["ok"] != false || e.exists("/etc/itso/docker-registries/"+cpReg+".json") {
		t.Fatal(r)
	}
	if r := login("ghp_Secret123"); r["ok"] != true {
		t.Fatal(r)
	}
	if len(e.fake.Lines()) != 0 {
		t.Fatalf("login không được chạy lệnh (mật khẩu qua argv): %v", e.fake.Lines())
	}
	if e.mode("/etc/itso/docker-client/config.json") != 0o600 || !strings.Contains(e.file("/etc/itso/docker-client/config.json"), `"ghcr.io"`) {
		t.Fatal("config.json sai")
	}
	pull := func(img string, reg any) map[string]any {
		return map[string]any{"image": img, "registry_uuid": reg}
	}
	e.h.Fail(contracts.OpDockerImagePull, pull("ghcr.io/itso/app:2.1.0", nil), "precondition_failed")
	e.h.Fail(contracts.OpDockerImagePull, pull("registry.local:5000/team/app:1", cpReg), "invalid_params")
	if r := e.h.OK(contracts.OpDockerImagePull, pull("ghcr.io/itso/app:2.1.0", cpReg)); r["changed"] != true {
		t.Fatal(r)
	}
	if r := e.h.OK(contracts.OpDockerImagePull, pull("ghcr.io/itso/app:2.1.0", cpReg)); r["changed"] != false {
		t.Fatal(r)
	}
	if fk.Pulls[len(fk.Pulls)-1] != "ghcr.io/itso/app:2.1.0 (itso-bot)" {
		t.Fatal(fk.Pulls)
	}
}

func TestDockerHost(t *testing.T) {
	e, fk := dockerEnv(t)
	write(t, e.fs.Root, "/etc/group", e.file("/etc/group")+"docker:x:999:ubuntu\n")
	st := e.h.OK(contracts.OpDockerHostStatus, map[string]any{})
	if st["installed"] != true || st["engine_version"] != "26.1.3" || st["compose_version"] != "2.27.1" {
		t.Fatal(st)
	}
	checks := map[string]bool{}
	for _, c := range st["checks"].([]any) {
		checks[c.(map[string]any)["key"].(string)] = c.(map[string]any)["ok"].(bool)
	}
	if checks["daemon_json"] || checks["docker_group_empty"] || !checks["compose_plugin"] {
		t.Fatal(checks)
	}
	e.fake.Reset()
	r := e.h.OK(contracts.OpDockerHostConfigure, map[string]any{"log_max_size_mb": 20, "log_max_file": 3})
	if r["changed"] != true || r["removed_group_members"].([]any)[0] != "ubuntu" {
		t.Fatal(r)
	}
	if !strings.Contains(e.file("/etc/docker/daemon.json"), `"max-size": "20m"`) || !strings.Contains(e.file("/etc/group"), "docker:x:999:\n") {
		t.Fatal(e.file("/etc/docker/daemon.json"), e.file("/etc/group"))
	}
	if r := e.h.OK(contracts.OpDockerHostConfigure, map[string]any{"log_max_size_mb": 20, "log_max_file": 3}); r["changed"] != false || r["restarted"] != false {
		t.Fatal("configure lần 2 phải idempotent", r)
	}
	st = e.h.OK(contracts.OpDockerHostStatus, map[string]any{})
	for _, c := range st["checks"].([]any) {
		if k := c.(map[string]any)["key"]; (k == "daemon_json" || k == "docker_group_empty") && c.(map[string]any)["ok"] != true {
			t.Fatal(c)
		}
	}
	// Engine không phản hồi: status vẫn trả (installed theo dockerd), op khác báo docker_unavailable.
	fk.Unavailable = true
	if st := e.h.OK(contracts.OpDockerHostStatus, map[string]any{}); st["engine_version"] != nil {
		t.Fatal(st)
	}
	e.h.Fail(contracts.OpDockerContainerList, map[string]any{"project_uuid": nil}, "docker_unavailable")
	e.d.Docker = nil
	e.h.Fail(contracts.OpDockerImageList, map[string]any{}, "docker_unavailable")
}

func TestVolumeBackupRestoreRestic(t *testing.T) {
	needRestic(t)
	e, fk := dockerEnv(t)
	e.d.Sandbox = true
	applyProject(t, e, cpUUID, cacheYAML, nil, 20001, 20002)
	name := "itso_" + cpUUID + "_data"
	mp := filepath.Join(e.fs.Root, "/var/lib/docker/volumes/"+name+"/_data")
	write(t, mp, "dump.rdb", "REDIS0011")
	repo := bkRepoParams(localDest(), "", bkPass)
	e.h.OK(contracts.OpBackupRepoInit, map[string]any{"repo": repo})
	b := e.h.OK(contracts.OpDockerVolumeBackup, map[string]any{"repo": repo, "volumes": []any{name}, "consistency": "pause",
		"tags": []any{"compose:" + cpUUID, "manual"}})
	if len(b["paused"].([]any)) != 1 {
		t.Fatal(b)
	}
	cs, _ := fk.Containers(t.Context(), map[string]string{docker.LabelComposeService: "redis"})
	if cs[0].State != "running" {
		t.Fatal("container phải được unpause sau backup")
	}
	snap := b["snapshot_id"].(string)
	r := e.h.OK(contracts.OpDockerVolumeRestore, map[string]any{"repo": repo, "snapshot_id": snap, "volume": name, "mode": "new", "target": "restored-data"})
	if r["restored"] != true {
		t.Fatal(r)
	}
	got, _ := os.ReadFile(filepath.Join(e.fs.Root, "/var/lib/docker/volumes/restored-data/_data/dump.rdb"))
	if string(got) != "REDIS0011" {
		t.Fatalf("restore sai: %q", got)
	}
	e.h.Fail(contracts.OpDockerVolumeRestore, map[string]any{"repo": repo, "snapshot_id": snap, "volume": name, "mode": "overwrite", "target": name}, "in_use")
}
