package ops

// Op compose.* và docker.image.update|rollback (D-96, D-97, ADR 0041, 0043). Project nằm ở
// /var/lib/itso/compose/<uuid>/ (0700): compose.yaml + .env (0600), .validated (sha256 các YAML validator đã trả),
// .applied (sha256 YAML đang chạy), data/ (bind tương đối duy nhất được phép). compose chạy bằng argv cố định
// `docker --config /etc/itso/docker-client compose -p itso_<uuid> --project-directory … -f … --env-file …`.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"itso.local/agent/internal/compose"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpComposeValidate:     d.composeValidate,
			contracts.OpComposeApply:        d.composeApply,
			contracts.OpComposeUp:           d.composeUp,
			contracts.OpComposeDown:         d.composeDown,
			contracts.OpComposePull:         d.composePull,
			contracts.OpComposeRemove:       d.composeRemove,
			contracts.OpDockerImageUpdate:   d.dockerImageUpdate,
			contracts.OpDockerImageRollback: d.dockerImageRollback,
		}
	})
}

var (
	reEnvKey       = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	reProjectName  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	projectLocks   sync.Map // uuid → *sync.Mutex
	maxValidatedKV = 20
)

var reLinuxUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// validateUsername: tên user Linux bất kỳ (kể cả user hệ thống như ubuntu) để gỡ khỏi nhóm docker.
func validateUsername(s string) error {
	if !reLinuxUser.MatchString(s) {
		return validate.Username(s)
	}
	return nil
}

func statOwner(fi interface{ Sys() any }) (int, int, bool) {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid), int(st.Gid), true
	}
	return 0, 0, false
}

func composeDir(uuid string) string { return composeRoot + "/" + uuid }

func checkProject(p contracts.ComposeProjectRef) (string, error) {
	u := string(p.ProjectUUID)
	if !reUUIDStr(u) || !reProjectName.MatchString(string(p.Name)) {
		return "", dkInvalid("project không hợp lệ")
	}
	return u, nil
}

// lockProject: mỗi project một thao tác compose tại một thời điểm.
func lockProject(uuid string) (func(), error) {
	mu, _ := projectLocks.LoadOrStore(uuid, &sync.Mutex{})
	l := mu.(*sync.Mutex)
	if !l.TryLock() {
		return nil, &registry.OpError{Code: "busy", Message: "project đang có thao tác compose khác", Retryable: true}
	}
	return l.Unlock, nil
}

func composeArgs(uuid string, extra ...string) []string {
	dir := composeDir(uuid)
	return append([]string{"--config", dockerClientDir, "compose", "-p", docker.ComposeProject(uuid), "--project-directory", dir,
		"-f", dir + "/compose.yaml", "--env-file", dir + "/.env"}, extra...)
}

// composeRun chạy docker compose; lỗi được phân loại theo stderr.
func (d *Deps) composeRun(ctx context.Context, uuid string, extra ...string) error {
	res, err := d.run(ctx, "docker", composeArgs(uuid, extra...)...)
	if err != nil {
		return err
	}
	if res.ExitCode == 0 {
		return nil
	}
	msg := strings.ToLower(string(res.Stderr))
	switch {
	case strings.Contains(msg, "port is already allocated") || strings.Contains(msg, "address already in use"):
		return cmdFailed("port_unavailable", "docker compose", res)
	case strings.Contains(msg, "cannot connect to the docker daemon"):
		return cmdFailed("docker_unavailable", "docker compose", res)
	case strings.Contains(msg, "unauthorized") || strings.Contains(msg, "denied") || strings.Contains(msg, "not found"):
		return cmdFailed("precondition_failed", "docker compose", res)
	}
	return cmdFailed("dependency_unavailable", "docker compose", res)
}

func sha256hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func (d *Deps) composeValidate(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ComposeValidateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	l := p.Defaults
	if l.MemLimitMB < 16 || l.MemLimitMB > 1048576 || l.Cpus < 0.05 || l.Cpus > 256 || l.PidsLimit < 16 || l.PidsLimit > 65536 {
		return nil, dkInvalid("defaults ngoài khoảng cho phép")
	}
	o := compose.Options{ProjectUUID: uuid, Defaults: compose.Limits{MemMB: l.MemLimitMB, CPUs: l.Cpus, Pids: l.PidsLimit},
		AllowHomeBind: p.AllowHomeBind}
	for _, a := range p.AllocatedPorts {
		if a < 20000 || a > 29999 {
			return nil, dkInvalid("allocated_ports ngoài dải 20000–29999")
		}
		o.Allocated = append(o.Allocated, a)
	}
	for _, ov := range p.Overrides {
		if !compose.Overridable[ov.Rule] || len([]rune(ov.Reason)) < 10 || len([]rune(ov.Reason)) > 300 || !reUUIDStr(string(ov.ByUserUUID)) {
			return nil, dkInvalid("override không hợp lệ")
		}
		o.Overrides = append(o.Overrides, compose.Override{Rule: ov.Rule, Reason: ov.Reason, By: string(ov.ByUserUUID)})
	}
	r := compose.Validate([]byte(p.ComposeYaml), o)
	out := contracts.ComposeValidateResult{OK: r.OK, Findings: []contracts.ComposeFinding{}, Rewrites: []contracts.ComposeValidateResultRewritesItem{},
		Ports: []contracts.ComposePortMap{}, Images: []contracts.DockerImageRef{}, Volumes: []contracts.DockerVolumeName{},
		ValidatedYaml: json.RawMessage("null"), ValidatedSHA256: json.RawMessage("null")}
	for _, f := range r.Findings {
		cf := contracts.ComposeFinding{Rule: contracts.ComposeRule(f.Rule), Severity: f.Severity, Service: nullableStr(f.Service),
			Path: truncate(f.Path, 500), Message: truncate(f.Message, 500), Overridable: f.Overridable}
		out.Findings = append(out.Findings, cf)
	}
	for _, rw := range r.Rewrites {
		it := contracts.ComposeValidateResultRewritesItem{Service: contracts.ComposeServiceName(rw.Service), Path: truncate(rw.Path, 500), After: truncate(rw.After, 1000)}
		if rw.Before != nil {
			b := truncate(*rw.Before, 1000)
			it.Before = &b
		}
		out.Rewrites = append(out.Rewrites, it)
	}
	for _, pm := range r.Ports {
		out.Ports = append(out.Ports, contracts.ComposePortMap{Service: contracts.ComposeServiceName(pm.Service), ContainerPort: contracts.Port(pm.ContainerPort),
			HostPort: int64(pm.HostPort), Protocol: pm.Protocol})
	}
	for _, i := range r.Images {
		out.Images = append(out.Images, contracts.DockerImageRef(i))
	}
	for _, v := range r.Volumes {
		out.Volumes = append(out.Volumes, contracts.DockerVolumeName(v))
	}
	if r.OK {
		y, _ := json.Marshal(string(r.YAML))
		s, _ := json.Marshal(r.SHA256)
		out.ValidatedYaml, out.ValidatedSHA256 = y, s
		if err := d.recordValidated(uuid, r.SHA256); err != nil {
			return nil, err
		}
	}
	return toData(out)
}

func nullableStr(s string) json.RawMessage {
	if s == "" {
		return json.RawMessage("null")
	}
	b, _ := json.Marshal(s)
	return b
}

// recordValidated ghi sha256 YAML validator vừa trả (giữ 20 bản gần nhất): compose.apply chỉ nhận YAML có trong đây.
func (d *Deps) recordValidated(uuid, sum string) error {
	dir := composeDir(uuid)
	if err := d.ensureTree(dir, 0o700); err != nil {
		return opErr(err)
	}
	var keep []string
	if raw, err := d.FS.ReadFile(dir + "/.validated"); err == nil {
		for _, l := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if len(l) == 64 && l != sum {
				keep = append(keep, l)
			}
		}
	}
	keep = append(keep, sum)
	if len(keep) > maxValidatedKV {
		keep = keep[len(keep)-maxValidatedKV:]
	}
	if _, err := d.FS.WriteAtomic(dir+"/.validated", []byte(strings.Join(keep, "\n")+"\n"), 0o600, platform.Owner{}); err != nil {
		return opErr(err)
	}
	return nil
}

func (d *Deps) wasValidated(uuid, sum string) bool {
	raw, err := d.FS.ReadFile(composeDir(uuid) + "/.validated")
	if err != nil {
		return false
	}
	return slices.Contains(strings.Split(strings.TrimSpace(string(raw)), "\n"), sum)
}

func envFile(env map[string]string) ([]byte, error) {
	if len(env) > 200 {
		return nil, dkInvalid("env tối đa 200 biến")
	}
	keys := make([]string, 0, len(env))
	for k, v := range env {
		if !reEnvKey.MatchString(k) || strings.HasPrefix(k, "COMPOSE_") || strings.HasPrefix(k, "DOCKER_") {
			return nil, dkInvalid("tên biến env không hợp lệ hoặc dành riêng: " + k)
		}
		if len(v) > 4096 || strings.ContainsAny(v, "\r\n\x00'") {
			return nil, dkInvalid("giá trị env " + k + " chứa ký tự không cho phép (xuống dòng, NUL, ')")
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b bytes.Buffer
	b.WriteString("# Quản lý bởi itso-agent (compose.apply). Không sửa tay.\n")
	for _, k := range keys {
		// Nháy đơn: compose không nội suy giá trị.
		fmt.Fprintf(&b, "%s='%s'\n", k, env[k])
	}
	return b.Bytes(), nil
}

// listeningPorts đọc cổng đang nghe trên host (/proc/net/*): tcp LISTEN, udp đã bind.
func (d *Deps) listeningPorts() map[string]bool {
	out := map[string]bool{}
	for _, f := range []struct{ file, proto string }{{"tcp", "tcp"}, {"tcp6", "tcp"}, {"udp", "udp"}, {"udp6", "udp"}} {
		raw, err := d.host().ReadFile("/proc/net/" + f.file)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(bytes.NewReader(raw))
		for sc.Scan() {
			fs := strings.Fields(sc.Text())
			if len(fs) < 4 || fs[0] == "sl" {
				continue
			}
			if f.proto == "tcp" && fs[3] != "0A" {
				continue
			}
			_, hexPort, ok := strings.Cut(fs[1], ":")
			if !ok {
				continue
			}
			if n, err := strconv.ParseUint(hexPort, 16, 16); err == nil {
				out[f.proto+"/"+strconv.FormatUint(n, 10)] = true
			}
		}
	}
	return out
}

// checkPortsFree: cổng host của project không bị tiến trình host hoặc container của project khác chiếm.
func (d *Deps) checkPortsFree(ctx context.Context, e docker.Engine, uuid string, ports []compose.PortMap) error {
	listen := d.listeningPorts()
	cs, err := e.Containers(ctx, nil)
	if err != nil {
		return dkErr(err)
	}
	own := map[string]bool{}
	other := map[string]string{}
	for _, c := range cs {
		for _, pt := range c.Ports {
			if pt.PublicPort == 0 {
				continue
			}
			k := pt.Type + "/" + strconv.Itoa(pt.PublicPort)
			if c.Labels[docker.LabelComposeProject] == docker.ComposeProject(uuid) {
				own[k] = true
			} else if c.State == "running" {
				other[k] = c.Name
			}
		}
	}
	for _, p := range ports {
		k := p.Protocol + "/" + strconv.Itoa(p.HostPort)
		if n, ok := other[k]; ok {
			return &registry.OpError{Code: "port_unavailable", Message: fmt.Sprintf("cổng %s đang được container %s dùng", k, n), Retryable: true}
		}
		if listen[k] && !own[k] {
			return &registry.OpError{Code: "port_unavailable", Message: fmt.Sprintf("cổng %s đang có tiến trình trên host nghe", k), Retryable: true}
		}
	}
	return nil
}

// checkBinds: bind tương đối (./data/…) không được đi qua symlink (container có thể tạo symlink trong data/ để lần
// up sau bind ra ngoài).
func (d *Deps) checkBinds(uuid string, svcs []compose.Service) error {
	dir := composeDir(uuid)
	for _, s := range svcs {
		for _, b := range s.RelBinds {
			if b != "data" && !strings.HasPrefix(b, "data/") {
				return &registry.OpError{Code: "compose_rejected", Message: "bind tương đối ngoài ./data: " + b}
			}
			if err := d.FS.NoSymlinkBelow(dir, dir+"/"+b); err != nil {
				return &registry.OpError{Code: "compose_rejected", Message: "bind " + b + " đi qua symlink, từ chối"}
			}
		}
	}
	return nil
}

// appliedServices đọc compose.yaml đang áp dụng, kiểm sha256 khớp .applied (file không bị sửa ngoài agent).
func (d *Deps) appliedServices(uuid string) ([]compose.Service, error) {
	dir := composeDir(uuid)
	y, err := d.FS.ReadFile(dir + "/compose.yaml")
	if err != nil {
		return nil, &registry.OpError{Code: "not_found", Message: "project chưa được apply trên server"}
	}
	want, _ := d.FS.ReadFile(dir + "/.applied")
	if strings.TrimSpace(string(want)) != sha256hex(y) {
		return nil, &registry.OpError{Code: "compose_rejected", Message: "compose.yaml khác bản đã apply (bị sửa ngoài agent)"}
	}
	svcs, err := compose.Services(y)
	if err != nil {
		return nil, &registry.OpError{Code: "compose_rejected", Message: err.Error()}
	}
	return svcs, nil
}

func allPorts(svcs []compose.Service) []compose.PortMap {
	var out []compose.PortMap
	for _, s := range svcs {
		out = append(out, s.Ports...)
	}
	return out
}

func (d *Deps) projectContainers(ctx context.Context, e docker.Engine, uuid string) ([]docker.Container, error) {
	cs, err := e.Containers(ctx, map[string]string{docker.LabelComposeProject: docker.ComposeProject(uuid)})
	if err != nil {
		return nil, dkErr(err)
	}
	return cs, nil
}

func (d *Deps) composeApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ComposeApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	y := []byte(p.ValidatedYaml)
	sum := sha256hex(y)
	if sum != string(p.ValidatedSHA256) {
		return nil, &registry.OpError{Code: "compose_rejected", Message: "validated_sha256 không khớp YAML"}
	}
	if !d.wasValidated(uuid, sum) {
		return nil, &registry.OpError{Code: "compose_rejected", Message: "YAML chưa qua compose.validate trên server này"}
	}
	ef, err := envFile(p.Env)
	if err != nil {
		return nil, err
	}
	svcs, err := compose.Services(y)
	if err != nil {
		return nil, &registry.OpError{Code: "compose_rejected", Message: err.Error()}
	}
	want := map[compose.PortMap]bool{}
	for _, pm := range allPorts(svcs) {
		want[pm] = true
	}
	if len(want) != len(p.Ports) {
		return nil, dkInvalid("ports không khớp cổng trong YAML đã validate")
	}
	for _, pm := range p.Ports {
		if !want[compose.PortMap{Service: string(pm.Service), ContainerPort: int(pm.ContainerPort), HostPort: int(pm.HostPort), Protocol: pm.Protocol}] {
			return nil, dkInvalid("ports không khớp cổng trong YAML đã validate")
		}
	}
	stored := d.storedRegistryUUIDs()
	for _, r := range p.RegistryUuids {
		if !slices.Contains(stored, string(r)) {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "registry " + string(r) + " chưa đăng nhập trên server"}
		}
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if err := d.checkPortsFree(ctx, e, uuid, allPorts(svcs)); err != nil {
		return nil, err
	}
	dir := composeDir(uuid)
	if err := d.ensureTree(dir+"/data", 0o755); err != nil {
		return nil, opErr(err)
	}
	if err := d.checkBinds(uuid, svcs); err != nil {
		return nil, err
	}
	for _, f := range []struct {
		name string
		data []byte
	}{{"compose.yaml", y}, {".env", ef}, {".applied", []byte(sum + "\n")}} {
		if _, err := d.FS.WriteAtomic(dir+"/"+f.name, f.data, 0o600, platform.Owner{}); err != nil {
			return nil, opErr(err)
		}
	}
	if err := d.composeRun(ctx, uuid, "up", "-d", "--remove-orphans"); err != nil {
		return nil, err
	}
	cs, err := d.projectContainers(ctx, e, uuid)
	if err != nil {
		return nil, err
	}
	out := contracts.ComposeApplyResult{Services: []contracts.ComposeApplyResultServicesItem{}}
	for _, s := range svcs {
		it := contracts.ComposeApplyResultServicesItem{Service: contracts.ComposeServiceName(s.Name), State: "missing", ContainerID: json.RawMessage("null")}
		for _, c := range cs {
			if c.Labels[docker.LabelComposeService] == s.Name {
				it.State, it.ContainerID = normState(c.State), nullableStr(c.ID)
			}
		}
		out.Services = append(out.Services, it)
	}
	return toData(out)
}

func (d *Deps) composeUp(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ComposeUpParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	svcs, err := d.appliedServices(uuid)
	if err != nil {
		return nil, err
	}
	if err := d.checkBinds(uuid, svcs); err != nil {
		return nil, err
	}
	if err := d.checkPortsFree(ctx, e, uuid, allPorts(svcs)); err != nil {
		return nil, err
	}
	if err := d.composeRun(ctx, uuid, "up", "-d", "--remove-orphans"); err != nil {
		return nil, err
	}
	cs, err := d.projectContainers(ctx, e, uuid)
	if err != nil {
		return nil, err
	}
	out := contracts.ComposeUpResult{Total: int64(len(svcs))}
	for _, c := range cs {
		if c.State == "running" {
			out.Running++
		}
	}
	return toData(out)
}

func (d *Deps) composeDown(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ComposeDownParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if _, err := d.appliedServices(uuid); err != nil {
		return nil, err
	}
	cs, err := d.projectContainers(ctx, e, uuid)
	if err != nil {
		return nil, err
	}
	var running int64
	for _, c := range cs {
		if c.State == "running" || c.State == "paused" || c.State == "restarting" {
			running++
		}
	}
	if err := d.composeRun(ctx, uuid, "down", "--remove-orphans"); err != nil {
		return nil, err
	}
	return toData(contracts.ComposeDownResult{Stopped: running})
}

func (d *Deps) composePull(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ComposePullParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	stored := d.storedRegistryUUIDs()
	for _, r := range p.RegistryUuids {
		if !slices.Contains(stored, string(r)) {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "registry " + string(r) + " chưa đăng nhập trên server"}
		}
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	svcs, err := d.appliedServices(uuid)
	if err != nil {
		return nil, err
	}
	before := map[string]string{}
	for _, s := range svcs {
		if im, err := e.ImageInspect(ctx, s.Image); err == nil {
			before[s.Name] = im.ID
		}
	}
	if err := d.composeRun(ctx, uuid, "pull"); err != nil {
		return nil, err
	}
	out := contracts.ComposePullResult{Images: []contracts.ComposePullResultImagesItem{}}
	for _, s := range svcs {
		im, err := e.ImageInspect(ctx, s.Image)
		if err != nil {
			return nil, dkErr(err)
		}
		out.Images = append(out.Images, contracts.ComposePullResultImagesItem{Service: contracts.ComposeServiceName(s.Name),
			Digest: contracts.ImageDigest(im.ID), Changed: before[s.Name] != im.ID})
	}
	return toData(out)
}

func (d *Deps) composeRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ComposeRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	dir := composeDir(uuid)
	out := contracts.ComposeRemoveResult{VolumesRemoved: []contracts.DockerVolumeName{}}
	var vols []string
	if vs, err := e.Volumes(ctx); err == nil {
		for _, v := range vs {
			if v.Labels[docker.LabelComposeProject] == docker.ComposeProject(uuid) {
				vols = append(vols, v.Name)
			}
		}
	}
	if d.FS.Exists(dir + "/compose.yaml") {
		args := []string{"down", "--remove-orphans"}
		if p.RemoveVolumes {
			args = append(args, "-v")
		}
		if err := d.composeRun(ctx, uuid, args...); err != nil {
			return nil, err
		}
		out.Removed = true
	}
	if d.FS.Exists(dir) {
		if err := d.FS.RemoveTree(dir); err != nil {
			return nil, opErr(err)
		}
		out.Removed = true
	}
	if p.RemoveVolumes {
		for _, v := range vols {
			if _, err := e.VolumeInspect(ctx, v); errors.Is(err, docker.ErrNotFound) {
				out.VolumesRemoved = append(out.VolumesRemoved, contracts.DockerVolumeName(v))
			}
		}
	}
	return toData(out)
}

// ---- image update / rollback ----

func rollbackRepo(uuid, svc string) string { return docker.RollbackRepoPrefix + uuid + "-" + svc }

func (d *Deps) serviceContainer(ctx context.Context, e docker.Engine, uuid, svc string) (*docker.Container, error) {
	cs, err := e.Containers(ctx, map[string]string{docker.LabelComposeProject: docker.ComposeProject(uuid), docker.LabelComposeService: svc})
	if err != nil {
		return nil, dkErr(err)
	}
	if len(cs) == 0 {
		return nil, nil
	}
	return &cs[0], nil
}

func (d *Deps) poll() time.Duration {
	if d.DockerPoll > 0 {
		return d.DockerPoll
	}
	return 2 * time.Second
}

// waitHealthy chờ container mới của service chạy với image want: healthy (có healthcheck) hoặc running qua hai lần
// kiểm liên tiếp (không healthcheck). unhealthy/exited/hết giờ → lỗi kèm lý do.
func (d *Deps) waitHealthy(ctx context.Context, e docker.Engine, uuid, svc, want string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	stable := 0
	for {
		c, err := d.serviceContainer(ctx, e, uuid, svc)
		if err != nil {
			return err
		}
		if c != nil && c.ImageID == want {
			det, err := e.Inspect(ctx, c.ID)
			if err != nil {
				return dkErr(err)
			}
			switch {
			case det.Health == "unhealthy":
				return errors.New("container unhealthy")
			case det.State == "exited" || det.State == "dead":
				return fmt.Errorf("container dừng (%s)", det.State)
			case det.Health == "healthy":
				return nil
			case det.Health == "" && det.State == "running":
				stable++
				if stable >= 2 {
					return nil
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("quá %s chưa healthy", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.poll()):
		}
	}
}

// pruneRollbacks giữ keep tag rollback mới nhất của service.
func (d *Deps) pruneRollbacks(ctx context.Context, e docker.Engine, repo string, keep int) {
	imgs, err := e.Images(ctx)
	if err != nil {
		return
	}
	var tags []string
	for _, im := range imgs {
		for _, t := range im.Tags {
			if strings.HasPrefix(t, repo+":") {
				tags = append(tags, t)
			}
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(tags)))
	for i := keep; i < len(tags); i++ {
		_ = e.RemoveImage(ctx, tags[i])
	}
}

func serviceByName(svcs []compose.Service, name string) *compose.Service {
	for i := range svcs {
		if svcs[i].Name == name {
			return &svcs[i]
		}
	}
	return nil
}

func (d *Deps) dockerImageUpdate(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerImageUpdateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	if p.HealthTimeoutSec < 10 || p.HealthTimeoutSec > 300 || p.KeepRollbacks < 1 || p.KeepRollbacks > 5 || len(p.Services) == 0 {
		return nil, dkInvalid("tham số cập nhật ngoài khoảng cho phép")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	svcs, err := d.appliedServices(uuid)
	if err != nil {
		return nil, err
	}
	if err := d.checkBinds(uuid, svcs); err != nil {
		return nil, err
	}
	regs := d.storedRegistryUUIDs()
	out := contracts.DockerImageUpdateResult{Services: []contracts.DockerImageUpdateResultServicesItem{}}
	for _, name := range p.Services {
		s := serviceByName(svcs, string(name))
		if s == nil {
			return nil, dkInvalid("service " + string(name) + " không có trong project")
		}
		c, err := d.serviceContainer(ctx, e, uuid, s.Name)
		if err != nil {
			return nil, err
		}
		if c == nil {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "service " + s.Name + " chưa có container"}
		}
		old := c.ImageID
		if err := e.Pull(ctx, s.Image, d.registryAuthForRef(s.Image, regs)); err != nil {
			return nil, dkErr(err)
		}
		img, err := e.ImageInspect(ctx, s.Image)
		if err != nil {
			return nil, dkErr(err)
		}
		it := contracts.DockerImageUpdateResultServicesItem{Service: name, FromDigest: contracts.ImageDigest(old), ToDigest: contracts.ImageDigest(img.ID), State: "unchanged"}
		if img.ID == old {
			out.Services = append(out.Services, it)
			continue
		}
		repo := rollbackRepo(uuid, s.Name)
		tag := d.now().UTC().Format("20060102150405")
		if err := e.Tag(ctx, old, repo, tag); err != nil {
			return nil, dkErr(err)
		}
		rt := repo + ":" + tag
		it.RollbackTag = &rt
		upErr := d.composeRun(ctx, uuid, "up", "-d", "--no-deps", s.Name)
		if upErr == nil {
			upErr = d.waitHealthy(ctx, e, uuid, s.Name, img.ID, time.Duration(p.HealthTimeoutSec)*time.Second)
		}
		if upErr != nil {
			// Tự quay về: gắn lại tag của service cho image cũ rồi up lại.
			reason := truncate(upErr.Error(), 400)
			r, t := docker.SplitRef(s.Image)
			if err := e.Tag(ctx, old, r, t); err != nil {
				return nil, dkErr(err)
			}
			if err := d.composeRun(ctx, uuid, "up", "-d", "--no-deps", s.Name); err != nil {
				return nil, err
			}
			it.State, it.Reason = "rolled_back", &reason
		} else {
			it.State = "updated"
		}
		d.pruneRollbacks(ctx, e, repo, int(p.KeepRollbacks))
		out.Services = append(out.Services, it)
	}
	return toData(out)
}

func (d *Deps) dockerImageRollback(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerImageRollbackParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	uuid, err := checkProject(p.Project)
	if err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	unlock, err := lockProject(uuid)
	if err != nil {
		return nil, err
	}
	defer unlock()
	svcs, err := d.appliedServices(uuid)
	if err != nil {
		return nil, err
	}
	imgs, err := e.Images(ctx)
	if err != nil {
		return nil, dkErr(err)
	}
	out := contracts.DockerImageRollbackResult{Services: []contracts.DockerImageRollbackResultServicesItem{}}
	for _, name := range p.Services {
		s := serviceByName(svcs, string(name))
		if s == nil {
			return nil, dkInvalid("service " + string(name) + " không có trong project")
		}
		repo := rollbackRepo(uuid, s.Name)
		best, bestID := "", ""
		for _, im := range imgs {
			for _, t := range im.Tags {
				if strings.HasPrefix(t, repo+":") && t > best {
					best, bestID = t, im.ID
				}
			}
		}
		if bestID == "" {
			return nil, &registry.OpError{Code: "not_found", Message: "service " + s.Name + " không có bản rollback"}
		}
		r, t := docker.SplitRef(s.Image)
		if err := e.Tag(ctx, bestID, r, t); err != nil {
			return nil, dkErr(err)
		}
		if err := d.composeRun(ctx, uuid, "up", "-d", "--no-deps", s.Name); err != nil {
			return nil, err
		}
		_ = e.RemoveImage(ctx, best) // bản rollback đã dùng: gỡ tag (image vẫn còn tag của service)
		out.Services = append(out.Services, contracts.DockerImageRollbackResultServicesItem{Service: name, Digest: contracts.ImageDigest(bestID)})
	}
	return toData(out)
}

// SHA256Hex trả sha256 hex (dùng chung với test).
func SHA256Hex(b []byte) string { return sha256hex(b) }
