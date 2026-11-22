package ops

// Op docker.* (Phase 10, D-94…D-98, ADR 0039–0043): agent nói Engine API qua unix socket (internal/docker), không
// nhận lệnh docker tùy ý. Chỉ container/network/volume có nhãn io.itso.* mới được điều khiển/xóa. Registry: mật
// khẩu chỉ qua params (secret_ref thay ở JobRunner), lưu ở /etc/itso/docker-client/config.json 0600.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

const (
	daemonJSONPath   = "/etc/docker/daemon.json"
	dockerClientDir  = "/etc/itso/docker-client" // --config của docker CLI (compose pull dùng auths ở đây)
	dockerRegDir     = "/etc/itso/docker-registries"
	dockerUserRules  = "/etc/itso/docker-user.rules"
	dockerUserUnit   = "/etc/systemd/system/itso-docker-user.service"
	dockerSocketPath = "/var/run/docker.sock"
	dockerHubKey     = "https://index.docker.io/v1/"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpDockerHostStatus:       d.dockerHostStatus,
			contracts.OpDockerHostConfigure:    d.dockerHostConfigure,
			contracts.OpDockerFirewallSync:     d.dockerFirewallSync,
			contracts.OpDockerContainerList:    d.dockerContainerList,
			contracts.OpDockerContainerInspect: d.dockerContainerInspect,
			contracts.OpDockerContainerControl: d.dockerContainerControl,
			contracts.OpDockerContainerLogs:    d.dockerContainerLogs,
			contracts.OpDockerContainerStats:   d.dockerContainerStats,
			contracts.OpDockerImageList:        d.dockerImageList,
			contracts.OpDockerImagePull:        d.dockerImagePull,
			contracts.OpDockerImagePrune:       d.dockerImagePrune,
			contracts.OpDockerRegistryLogin:    d.dockerRegistryLogin,
			contracts.OpDockerVolumeList:       d.dockerVolumeList,
			contracts.OpDockerVolumeCreate:     d.dockerVolumeCreate,
			contracts.OpDockerVolumeRemove:     d.dockerVolumeRemove,
			contracts.OpDockerVolumeBackup:     d.dockerVolumeBackup,
			contracts.OpDockerVolumeRestore:    d.dockerVolumeRestore,
			contracts.OpDockerNetworkList:      d.dockerNetworkList,
			contracts.OpDockerNetworkCreate:    d.dockerNetworkCreate,
			contracts.OpDockerNetworkRemove:    d.dockerNetworkRemove,
		}
	})
}

// engine trả client Engine; chưa cấu hình → docker_unavailable.
func (d *Deps) engine() (docker.Engine, error) {
	if d.Docker == nil {
		return nil, &registry.OpError{Code: "docker_unavailable", Message: "docker chưa được cài/cấu hình trên server", Retryable: true}
	}
	return d.Docker, nil
}

// dkErr đổi lỗi Engine thành mã lỗi agent.
func dkErr(err error) error {
	var oe *registry.OpError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &oe):
		return oe
	case errors.Is(err, docker.ErrUnavailable):
		return &registry.OpError{Code: "docker_unavailable", Message: "docker engine không phản hồi", Retryable: true}
	case errors.Is(err, docker.ErrNotFound):
		return &registry.OpError{Code: "not_found", Message: truncate(err.Error(), 300)}
	case errors.Is(err, docker.ErrConflict):
		return &registry.OpError{Code: "in_use", Message: truncate(err.Error(), 300)}
	case errors.Is(err, docker.ErrAuth):
		return &registry.OpError{Code: "precondition_failed", Message: "registry từ chối xác thực: " + truncate(err.Error(), 250)}
	case errors.Is(err, context.DeadlineExceeded):
		return &registry.OpError{Code: "deadline_exceeded", Message: "docker: quá thời gian", Retryable: true}
	}
	return &registry.OpError{Code: "internal", Message: truncate(err.Error(), 300), Retryable: true}
}

func dkInvalid(msg string) error { return &registry.OpError{Code: "invalid_params", Message: msg} }

func checkHex(id string) error {
	if len(id) < 12 || len(id) > 64 || strings.Trim(id, "0123456789abcdef") != "" {
		return dkInvalid("id container không hợp lệ")
	}
	return nil
}

func checkDockerName(s string, max int) error {
	if s == "" || len(s) > max || strings.Contains(s, "..") || strings.Trim(s, "abcdefghijklmnopqrstuvwxyz0123456789_.-") != "" ||
		strings.ContainsAny(s[:1], "_.-") {
		return dkInvalid("tên không hợp lệ: " + s)
	}
	return nil
}

// projectOf trả uuid project panel của nhãn container/volume/network ("" nếu không do panel quản lý).
func projectOf(labels map[string]string) string {
	if u := labels[docker.LabelProject]; reUUIDStr(u) {
		return u
	}
	if u, ok := strings.CutPrefix(labels[docker.LabelComposeProject], "itso_"); ok && reUUIDStr(u) {
		return u
	}
	return ""
}

func nullableUUID(u string) json.RawMessage {
	if u == "" {
		return json.RawMessage("null")
	}
	b, _ := json.Marshal(u)
	return b
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---- host ----

type daemonConfig struct {
	LogDriver       string            `json:"log-driver"`
	LogOpts         map[string]string `json:"log-opts"`
	LiveRestore     bool              `json:"live-restore"`
	NoNewPrivileges bool              `json:"no-new-privileges"`
	UserlandProxy   bool              `json:"userland-proxy"`
}

func daemonJSON(sizeMB, files int64) []byte {
	c := daemonConfig{LogDriver: "json-file", LogOpts: map[string]string{"max-size": fmt.Sprintf("%dm", sizeMB), "max-file": strconv.FormatInt(files, 10)},
		LiveRestore: true, NoNewPrivileges: true, UserlandProxy: false}
	b, _ := json.MarshalIndent(c, "", "  ")
	return append(b, '\n')
}

func (d *Deps) dockerGroupMembers() []string {
	g, err := d.groupByName("docker")
	if err != nil || g == nil {
		return []string{}
	}
	out := []string{}
	for _, m := range g.Members {
		if m != "" {
			out = append(out, m)
		}
	}
	return out
}

func (d *Deps) composeVersion(ctx context.Context) *string {
	res, err := d.run(ctx, "docker", "compose", "version", "--short")
	if err != nil || res.ExitCode != 0 {
		return nil
	}
	v := strings.TrimSpace(string(res.Stdout))
	if v == "" || len(v) > 50 {
		return nil
	}
	return &v
}

func (d *Deps) dockerHostStatus(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerHostStatusParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	out := contracts.DockerHostStatusResult{Checks: []contracts.DockerHostStatusResultChecksItem{}, DockerGroupMembers: []contracts.Username{}}
	members := d.dockerGroupMembers()
	for _, m := range members {
		out.DockerGroupMembers = append(out.DockerGroupMembers, contracts.Username(m))
	}
	var e docker.Engine
	if d.Docker != nil {
		e = d.Docker
		if v, err := e.Version(ctx); err == nil {
			out.Installed = true
			out.EngineVersion, out.APIVersion = strPtr(v.Version), strPtr(v.APIVersion)
		}
	}
	if !out.Installed {
		out.Installed = d.FS.Exists("/usr/bin/dockerd")
	}
	check := func(key string, ok bool, detail string) {
		out.Checks = append(out.Checks, contracts.DockerHostStatusResultChecksItem{Key: key, OK: ok, Detail: detail})
	}
	var dc daemonConfig
	raw, err := d.FS.ReadFile(daemonJSONPath)
	dcOK := err == nil && json.Unmarshal(raw, &dc) == nil && dc.NoNewPrivileges && dc.LogOpts["max-size"] != ""
	check("daemon_json", dcOK, map[bool]string{true: "daemon.json do agent quản lý (log giới hạn, no-new-privileges)",
		false: "chưa cấu hình daemon.json (chạy docker.host.configure)"}[dcOK])
	check("docker_group_empty", len(members) == 0, map[bool]string{true: "nhóm docker trống",
		false: "nhóm docker có " + strings.Join(members, ", ") + " (= quyền root)"}[len(members) == 0])
	ruleOK := d.FS.Exists(dockerUserRules)
	check("docker_user_chain", ruleOK, map[bool]string{true: "chuỗi DOCKER-USER do agent đồng bộ",
		false: "chưa đồng bộ DOCKER-USER (docker.firewall.sync)"}[ruleOK])
	sockOK, sockDetail := true, "socket chỉ root/nhóm docker trống"
	if fi, err := d.FS.Lstat(dockerSocketPath); err == nil {
		if fi.Mode().Perm()&0o007 != 0 {
			sockOK, sockDetail = false, "socket docker mở cho mọi user"
		} else if len(members) > 0 {
			sockOK, sockDetail = false, "nhóm docker có thành viên đọc được socket"
		}
	} else if !out.Installed {
		sockDetail = "docker chưa cài"
	}
	check("socket_root_only", sockOK, sockDetail)
	cv := d.composeVersion(ctx)
	out.ComposeVersion = cv
	check("compose_plugin", cv != nil, map[bool]string{true: "docker compose v2", false: "thiếu plugin docker compose"}[cv != nil])
	if out.Installed && e != nil {
		if cs, err := e.Containers(ctx, nil); err == nil {
			projects := map[string]bool{}
			for _, c := range cs {
				out.Counts.Containers++
				if c.State == "running" {
					out.Counts.Running++
				}
				if u := projectOf(c.Labels); u != "" {
					projects[u] = true
				}
			}
			out.Counts.Projects = int64(len(projects))
		}
		if is, err := e.Images(ctx); err == nil {
			out.Counts.Images = int64(len(is))
		}
		if vs, err := e.Volumes(ctx); err == nil {
			out.Counts.Volumes = int64(len(vs))
		}
	}
	return toData(out)
}

func (d *Deps) dockerHostConfigure(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerHostConfigureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if p.LogMaxSizeMB < 1 || p.LogMaxSizeMB > 1024 || p.LogMaxFile < 1 || p.LogMaxFile > 20 {
		return nil, dkInvalid("giới hạn log ngoài khoảng cho phép")
	}
	changed, err := d.FS.WriteAtomic(daemonJSONPath, daemonJSON(p.LogMaxSizeMB, p.LogMaxFile), 0o644, platform.Owner{})
	if err != nil {
		return nil, opErr(err)
	}
	out := contracts.DockerHostConfigureResult{Changed: changed, RemovedGroupMembers: []contracts.Username{}}
	// Thành viên nhóm docker = root không mật khẩu (ADR 0039 §2): gỡ hết.
	for _, m := range d.dockerGroupMembers() {
		if err := validateUsername(m); err != nil {
			continue
		}
		if _, err := d.must(ctx, "internal", "gpasswd", "-d", m, "docker"); err != nil {
			return nil, err
		}
		out.RemovedGroupMembers = append(out.RemovedGroupMembers, contracts.Username(m))
		out.Changed = true
	}
	if changed {
		if st, err := d.run(ctx, "systemctl", "is-active", "docker.service"); err == nil && st.ExitCode == 0 {
			if _, err := d.must(ctx, "config_test_failed", "systemctl", "restart", "docker.service"); err != nil {
				return nil, err
			}
			out.Restarted = true
		}
	}
	return toData(out)
}

// dockerUserRuleset dựng ruleset iptables-restore cho chuỗi DOCKER-USER (ADR 0042): lưu lượng từ interface public
// tới container chỉ được qua với cổng/nguồn trong open_ports; còn lại DROP. Thứ tự rule quan trọng.
func dockerUserRuleset(pub string, open []contracts.DockerFirewallSyncParamsOpenPortsItem) (string, int) {
	var b strings.Builder
	n := 0
	add := func(r string) { b.WriteString("-A DOCKER-USER " + r + "\n"); n++ }
	b.WriteString("# Quản lý bởi itso-agent (docker.firewall.sync). Không sửa tay.\n*filter\n:DOCKER-USER - [0:0]\n-F DOCKER-USER\n")
	add("-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN")
	add("! -i " + pub + " -j RETURN")
	sorted := append([]contracts.DockerFirewallSyncParamsOpenPortsItem(nil), open...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Port != sorted[j].Port {
			return sorted[i].Port < sorted[j].Port
		}
		return sorted[i].Protocol < sorted[j].Protocol
	})
	for _, o := range sorted {
		if strings.Contains(string(o.Source), ":") {
			continue // IPv6: Docker mặc định không bật ip6tables; bỏ qua
		}
		src := ""
		if string(o.Source) != "0.0.0.0/0" {
			src = " -s " + string(o.Source)
		}
		add(fmt.Sprintf("-i %s -p %s -m conntrack --ctorigdstport %d --ctdir ORIGINAL%s -j RETURN", pub, o.Protocol, o.Port, src))
	}
	add("-i " + pub + " -j DROP")
	add("-j RETURN")
	b.WriteString("COMMIT\n")
	return b.String(), n
}

const dockerUserUnitBody = `# Quản lý bởi itso-agent (docker.firewall.sync): nạp lại DOCKER-USER mỗi khi docker khởi động.
[Unit]
Description=ITSO Panel DOCKER-USER rules
After=docker.service
PartOf=docker.service
ConditionPathExists=` + dockerUserRules + `

[Service]
Type=oneshot
ExecStart=/usr/sbin/iptables-restore --noflush ` + dockerUserRules + `
RemainAfterExit=yes

[Install]
WantedBy=docker.service
`

func (d *Deps) dockerFirewallSync(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerFirewallSyncParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkDockerName(p.PublicInterface, 15); err != nil {
		return nil, dkInvalid("public_interface không hợp lệ")
	}
	for _, o := range p.OpenPorts {
		if o.Port < 1 || o.Port > 65535 || (o.Protocol != "tcp" && o.Protocol != "udp") {
			return nil, dkInvalid("open_ports không hợp lệ")
		}
		if _, _, err := net.ParseCIDR(string(o.Source)); err != nil {
			return nil, dkInvalid("source không phải CIDR: " + string(o.Source))
		}
	}
	rules, n := dockerUserRuleset(p.PublicInterface, p.OpenPorts)
	changed, err := d.FS.WriteAtomic(dockerUserRules, []byte(rules), 0o600, platform.Owner{})
	if err != nil {
		return nil, opErr(err)
	}
	uc, err := d.FS.WriteAtomic(dockerUserUnit, []byte(dockerUserUnitBody), 0o644, platform.Owner{})
	if err != nil {
		return nil, opErr(err)
	}
	if uc {
		if _, err := d.must(ctx, "internal", "systemctl", "daemon-reload"); err != nil {
			return nil, err
		}
		if _, err := d.must(ctx, "internal", "systemctl", "enable", "itso-docker-user.service"); err != nil {
			return nil, err
		}
	}
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: "iptables-restore", Args: []string{"--noflush"}, Stdin: []byte(rules)})
	if err != nil {
		return nil, &registry.OpError{Code: "dependency_unavailable", Message: "iptables-restore: " + err.Error(), Retryable: true}
	}
	if res.ExitCode != 0 {
		return nil, cmdFailed("config_test_failed", "iptables-restore", res)
	}
	return toData(contracts.DockerFirewallSyncResult{Rules: int64(n), Changed: changed || uc})
}

// ---- container ----

func (d *Deps) dockerContainerList(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerContainerListParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	var filter map[string]string
	if len(p.ProjectUUID) > 0 && string(p.ProjectUUID) != "null" {
		var u string
		if json.Unmarshal(p.ProjectUUID, &u) != nil || !reUUIDStr(u) {
			return nil, dkInvalid("project_uuid không hợp lệ")
		}
		filter = map[string]string{docker.LabelComposeProject: docker.ComposeProject(u)}
	}
	cs, err := e.Containers(ctx, filter)
	if err != nil {
		return nil, dkErr(err)
	}
	out := contracts.DockerContainerListResult{Containers: []contracts.DockerContainerListResultContainersItem{}}
	for _, c := range cs {
		if len(out.Containers) >= 2000 {
			break
		}
		it := contracts.DockerContainerListResultContainersItem{ID: contracts.ContainerID(c.ID), Name: truncate(c.Name, 200),
			Image: truncate(c.Image, 255), State: normState(c.State), Status: truncate(c.Status, 200), ProjectUUID: nullableUUID(projectOf(c.Labels))}
		if s := c.Labels[docker.LabelComposeService]; s != "" {
			it.Service = &s
		}
		if c.Health != "" {
			h := c.Health
			it.Health = &h
		}
		out.Containers = append(out.Containers, it)
	}
	return toData(out)
}

func normState(s string) string {
	switch s {
	case "running", "exited", "paused", "restarting", "created", "dead":
		return s
	case "removing":
		return "exited"
	}
	return "created"
}

func (d *Deps) dockerContainerInspect(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerContainerInspectParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkHex(string(p.ID)); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	c, err := e.Inspect(ctx, string(p.ID))
	if err != nil {
		return nil, dkErr(err)
	}
	out := contracts.DockerContainerInspectResult{ID: contracts.ContainerID(c.ID), ImageDigest: contracts.ImageDigest(c.ImageID),
		State: c.State, RestartCount: int64(c.RestartCount), Privileged: c.Privileged,
		Mounts: []contracts.DockerContainerInspectResultMountsItem{}, Ports: []contracts.DockerContainerInspectResultPortsItem{}}
	for _, m := range c.Mounts {
		if (m.Type == "volume" || m.Type == "bind" || m.Type == "tmpfs") && len(out.Mounts) < 100 {
			src := m.Source
			if m.Type == "volume" && m.Name != "" {
				src = m.Name
			}
			out.Mounts = append(out.Mounts, contracts.DockerContainerInspectResultMountsItem{Type: m.Type, Source: truncate(src, 4096), Target: truncate(m.Destination, 4096)})
		}
	}
	for _, pt := range c.Ports {
		ip := pt.IP
		if ip == "" {
			ip = "0.0.0.0"
		}
		if pt.PublicPort < 1 || pt.PublicPort > 65535 || pt.PrivatePort < 1 || net.ParseIP(ip) == nil || len(out.Ports) >= 100 {
			continue
		}
		proto := pt.Type
		if proto != "udp" {
			proto = "tcp"
		}
		out.Ports = append(out.Ports, contracts.DockerContainerInspectResultPortsItem{HostIP: contracts.IPAddress(ip),
			HostPort: contracts.Port(pt.PublicPort), ContainerPort: contracts.Port(pt.PrivatePort), Protocol: proto})
	}
	return toData(out)
}

// managedContainer trả container nếu do panel quản lý (nhãn io.itso.project); container khác → precondition_failed.
func managedContainer(ctx context.Context, e docker.Engine, id string) (docker.Detail, error) {
	c, err := e.Inspect(ctx, id)
	if err != nil {
		return c, dkErr(err)
	}
	if projectOf(c.Labels) == "" {
		return c, &registry.OpError{Code: "precondition_failed", Message: "container không do panel quản lý (thiếu nhãn io.itso.project)"}
	}
	return c, nil
}

func (d *Deps) dockerContainerControl(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerContainerControlParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkHex(string(p.ID)); err != nil {
		return nil, err
	}
	if p.Action != "start" && p.Action != "stop" && p.Action != "restart" {
		return nil, dkInvalid("action không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	c, err := managedContainer(ctx, e, string(p.ID))
	if err != nil {
		return nil, err
	}
	if err := e.Action(ctx, c.ID, p.Action); err != nil {
		return nil, dkErr(err)
	}
	after, err := e.Inspect(ctx, c.ID)
	if err != nil {
		return nil, dkErr(err)
	}
	return toData(contracts.DockerContainerControlResult{State: after.State})
}

func (d *Deps) dockerContainerLogs(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerContainerLogsParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkHex(string(p.ID)); err != nil {
		return nil, err
	}
	if p.Lines < 1 || p.Lines > 5000 {
		return nil, dkInvalid("lines ngoài 1–5000")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	lines, cut, err := e.Logs(ctx, string(p.ID), int(p.Lines))
	if err != nil {
		return nil, dkErr(err)
	}
	return toData(contracts.DockerContainerLogsResult{Lines: lines, Truncated: cut})
}

func (d *Deps) dockerContainerStats(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerContainerStatsParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	out := contracts.DockerContainerStatsResult{Stats: []contracts.DockerContainerStatsResultStatsItem{}}
	for _, id := range p.Ids {
		if err := checkHex(string(id)); err != nil {
			return nil, err
		}
		s, err := e.Stats(ctx, string(id))
		if errors.Is(err, docker.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, dkErr(err)
		}
		it := contracts.DockerContainerStatsResultStatsItem{ID: id, CPUPct: max(s.CPUPct, 0), MemMB: float64(s.MemBytes) / (1 << 20), Pids: s.Pids}
		if s.MemLimit > 0 && s.MemLimit < 1<<50 {
			l := float64(s.MemLimit) / (1 << 20)
			it.MemLimitMB = &l
		}
		out.Stats = append(out.Stats, it)
	}
	return toData(out)
}

// ---- image ----

func isRollbackTag(t string) bool { return strings.HasPrefix(t, docker.RollbackRepoPrefix) }

func (d *Deps) inUseImages(ctx context.Context, e docker.Engine) (map[string]bool, error) {
	cs, err := e.Containers(ctx, nil)
	if err != nil {
		return nil, err
	}
	used := map[string]bool{}
	for _, c := range cs {
		used[c.ImageID] = true
	}
	return used, nil
}

func (d *Deps) dockerImageList(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerImageListParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	imgs, err := e.Images(ctx)
	if err != nil {
		return nil, dkErr(err)
	}
	used, err := d.inUseImages(ctx, e)
	if err != nil {
		return nil, dkErr(err)
	}
	out := contracts.DockerImageListResult{Images: []contracts.DockerImageListResultImagesItem{}}
	for _, im := range imgs {
		if len(out.Images) >= 5000 {
			break
		}
		rb := false
		tags := []string{}
		for _, t := range im.Tags {
			rb = rb || isRollbackTag(t)
			if len(tags) < 50 {
				tags = append(tags, truncate(t, 255))
			}
		}
		out.Images = append(out.Images, contracts.DockerImageListResultImagesItem{ID: contracts.ImageDigest(im.ID), Tags: tags,
			SizeBytes: contracts.Bytes(im.Size), CreatedAt: time.Unix(im.Created, 0).UTC().Format(time.RFC3339), InUse: used[im.ID],
			Dangling: len(im.Tags) == 0, Rollback: rb})
	}
	return toData(out)
}

type registryInfo struct {
	Host     string `json:"host"`
	Username string `json:"username"`
}

type clientConfig struct {
	Auths map[string]struct {
		Auth string `json:"auth"`
	} `json:"auths"`
}

func authKey(host string) string {
	if host == "docker.io" {
		return dockerHubKey
	}
	return host
}

// registryAuth trả thông tin đăng nhập registry đã lưu cho image ref (kiểm host của ref khớp registry).
func (d *Deps) registryAuth(ref, regUUID string) (*docker.Auth, error) {
	if !reUUIDStr(regUUID) {
		return nil, dkInvalid("registry_uuid không hợp lệ")
	}
	raw, err := d.FS.ReadFile(dockerRegDir + "/" + regUUID + ".json")
	if err != nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "registry chưa đăng nhập trên server (docker.registry.login)"}
	}
	var ri registryInfo
	if json.Unmarshal(raw, &ri) != nil {
		return nil, &registry.OpError{Code: "internal", Message: "thông tin registry hỏng"}
	}
	if docker.RegistryHost(ref) != ri.Host {
		return nil, dkInvalid("image " + ref + " không thuộc registry " + ri.Host)
	}
	var cc clientConfig
	if raw, err := d.FS.ReadFile(dockerClientDir + "/config.json"); err == nil {
		_ = json.Unmarshal(raw, &cc)
	}
	a, ok := cc.Auths[authKey(ri.Host)]
	if !ok {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "registry chưa đăng nhập trên server"}
	}
	dec, err := base64.StdEncoding.DecodeString(a.Auth)
	user, pass, ok2 := strings.Cut(string(dec), ":")
	if err != nil || !ok2 {
		return nil, &registry.OpError{Code: "internal", Message: "thông tin đăng nhập registry hỏng"}
	}
	return &docker.Auth{Username: user, Password: pass, ServerAddress: authKey(ri.Host)}, nil
}

// registryAuthForRef tìm registry đã lưu theo host của ref trong danh sách uuid (compose pull, image update).
func (d *Deps) registryAuthForRef(ref string, uuids []string) *docker.Auth {
	for _, u := range uuids {
		if a, err := d.registryAuth(ref, u); err == nil {
			return a
		}
	}
	return nil
}

// storedRegistryUUIDs liệt kê registry đã đăng nhập trên server.
func (d *Deps) storedRegistryUUIDs() []string {
	names, _ := d.FS.ReadDir(dockerRegDir)
	var out []string
	for _, n := range names {
		if u, ok := strings.CutSuffix(n, ".json"); ok && reUUIDStr(u) {
			out = append(out, u)
		}
	}
	return out
}

func checkImageRef(ref string) error {
	if ref == "" || len(ref) > 255 || strings.Contains(ref, "..") || strings.HasPrefix(ref, "-") ||
		strings.ContainsAny(ref, " \t\r\n$;&|`'\"\\<>(){}") {
		return dkInvalid("image không hợp lệ")
	}
	return nil
}

func (d *Deps) dockerImagePull(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerImagePullParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ref := string(p.Image)
	if err := checkImageRef(ref); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	var auth *docker.Auth
	if len(p.RegistryUUID) > 0 && string(p.RegistryUUID) != "null" {
		var u string
		if json.Unmarshal(p.RegistryUUID, &u) != nil {
			return nil, dkInvalid("registry_uuid không hợp lệ")
		}
		if auth, err = d.registryAuth(ref, u); err != nil {
			return nil, err
		}
	}
	before, _ := e.ImageInspect(ctx, ref)
	if err := e.Pull(ctx, ref, auth); err != nil {
		return nil, dkErr(err)
	}
	after, err := e.ImageInspect(ctx, ref)
	if err != nil {
		return nil, dkErr(err)
	}
	return toData(contracts.DockerImagePullResult{Digest: contracts.ImageDigest(after.ID), Changed: before.ID != after.ID})
}

func (d *Deps) dockerImagePrune(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerImagePruneParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	imgs, err := e.Images(ctx)
	if err != nil {
		return nil, dkErr(err)
	}
	used, err := d.inUseImages(ctx, e)
	if err != nil {
		return nil, dkErr(err)
	}
	out := contracts.DockerImagePruneResult{}
	for _, im := range imgs {
		rb := false
		for _, t := range im.Tags {
			rb = rb || isRollbackTag(t)
		}
		dangling := len(im.Tags) == 0
		if used[im.ID] || (rb && p.KeepRollback) || (p.DanglingOnly && !dangling) {
			continue
		}
		if err := e.RemoveImage(ctx, im.ID); err != nil {
			if errors.Is(err, docker.ErrConflict) || errors.Is(err, docker.ErrNotFound) {
				continue // image cha của image khác hoặc vừa bị xóa
			}
			return nil, dkErr(err)
		}
		out.Removed++
		out.ReclaimedBytes += contracts.Bytes(im.Size)
	}
	return toData(out)
}

// registryHostOf trả host[:port] của URL HTTPS registry (docker hub chuẩn hóa thành docker.io).
func registryHostOf(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", dkInvalid("url registry phải là https://host[:port]")
	}
	h := strings.ToLower(u.Host)
	switch h {
	case "docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com":
		return "docker.io", nil
	}
	if strings.Trim(h, "abcdefghijklmnopqrstuvwxyz0123456789.-:[]") != "" {
		return "", dkInvalid("host registry không hợp lệ")
	}
	return h, nil
}

func (d *Deps) dockerRegistryLogin(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerRegistryLoginParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !reUUIDStr(string(p.RegistryUUID)) {
		return nil, dkInvalid("registry_uuid không hợp lệ")
	}
	host, err := registryHostOf(string(p.URL))
	if err != nil {
		return nil, err
	}
	if p.Username == "" || len(p.Username) > 200 || strings.Trim(p.Username, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._@-") != "" {
		return nil, dkInvalid("username không hợp lệ")
	}
	for _, r := range p.Password {
		if r < 0x21 || r > 0x7e {
			return nil, dkInvalid("password chứa ký tự không cho phép")
		}
	}
	if p.Password == "" || len(p.Password) > 1024 {
		return nil, dkInvalid("password không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	if err := e.Login(ctx, docker.Auth{Username: p.Username, Password: p.Password, ServerAddress: authKey(host)}); err != nil {
		if errors.Is(err, docker.ErrAuth) {
			return toData(contracts.DockerRegistryLoginResult{OK: false, Message: "registry từ chối thông tin đăng nhập"})
		}
		return nil, dkErr(err)
	}
	if err := d.ensureTree(dockerClientDir, 0o700); err != nil {
		return nil, opErr(err)
	}
	var cc map[string]any
	if raw, err := d.FS.ReadFile(dockerClientDir + "/config.json"); err == nil {
		_ = json.Unmarshal(raw, &cc)
	}
	if cc == nil {
		cc = map[string]any{}
	}
	auths, _ := cc["auths"].(map[string]any)
	if auths == nil {
		auths = map[string]any{}
	}
	auths[authKey(host)] = map[string]string{"auth": base64.StdEncoding.EncodeToString([]byte(p.Username + ":" + p.Password))}
	cc["auths"] = auths
	b, _ := json.MarshalIndent(cc, "", "  ")
	if _, err := d.FS.WriteAtomic(dockerClientDir+"/config.json", append(b, '\n'), 0o600, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	if err := d.ensureTree(dockerRegDir, 0o700); err != nil {
		return nil, opErr(err)
	}
	ri, _ := json.Marshal(registryInfo{Host: host, Username: p.Username})
	if _, err := d.FS.WriteAtomic(dockerRegDir+"/"+string(p.RegistryUUID)+".json", ri, 0o600, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	return toData(contracts.DockerRegistryLoginResult{OK: true, Message: "đăng nhập " + host + " thành công"})
}

// ---- volume ----

func volumeUsers(cs []docker.Container) map[string][]docker.Container {
	out := map[string][]docker.Container{}
	for _, c := range cs {
		for _, m := range c.Mounts {
			if m.Type == "volume" && m.Name != "" {
				out[m.Name] = append(out[m.Name], c)
			}
		}
	}
	return out
}

func (d *Deps) dockerVolumeList(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerVolumeListParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	vs, err := e.Volumes(ctx)
	if err != nil {
		return nil, dkErr(err)
	}
	cs, err := e.Containers(ctx, nil)
	if err != nil {
		return nil, dkErr(err)
	}
	users := volumeUsers(cs)
	out := contracts.DockerVolumeListResult{Volumes: []contracts.DockerVolumeListResultVolumesItem{}}
	for _, v := range vs {
		if checkDockerName(v.Name, 128) != nil || len(out.Volumes) >= 5000 {
			continue // volume ẩn danh (hex 64) vẫn hợp lệ; tên lạ bỏ qua
		}
		it := contracts.DockerVolumeListResultVolumesItem{Name: contracts.DockerVolumeName(v.Name), Driver: truncate(v.Driver, 50),
			UsedBy: []contracts.ContainerID{}, ProjectUUID: nullableUUID(projectOf(v.Labels))}
		for _, c := range users[v.Name] {
			if len(it.UsedBy) < 100 {
				it.UsedBy = append(it.UsedBy, contracts.ContainerID(c.ID))
			}
		}
		out.Volumes = append(out.Volumes, it)
	}
	return toData(out)
}

func (d *Deps) dockerVolumeCreate(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerVolumeCreateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkDockerName(string(p.Name), 128); err != nil {
		return nil, err
	}
	if !reUUIDStr(string(p.ProjectUUID)) {
		return nil, dkInvalid("project_uuid không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	err = e.CreateVolume(ctx, string(p.Name), map[string]string{docker.LabelProject: string(p.ProjectUUID)})
	if errors.Is(err, docker.ErrConflict) {
		return toData(contracts.DockerVolumeCreateResult{Created: false})
	}
	if err != nil {
		return nil, dkErr(err)
	}
	return toData(contracts.DockerVolumeCreateResult{Created: true})
}

func (d *Deps) dockerVolumeRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerVolumeRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkDockerName(string(p.Name), 128); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	cs, err := e.Containers(ctx, nil)
	if err != nil {
		return nil, dkErr(err)
	}
	if u := volumeUsers(cs)[string(p.Name)]; len(u) > 0 {
		return nil, &registry.OpError{Code: "in_use", Message: fmt.Sprintf("volume đang được %d container dùng (%s)", len(u), u[0].Name)}
	}
	err = e.RemoveVolume(ctx, string(p.Name))
	if errors.Is(err, docker.ErrNotFound) {
		return toData(contracts.DockerVolumeRemoveResult{Removed: false})
	}
	if err != nil {
		return nil, dkErr(err)
	}
	return toData(contracts.DockerVolumeRemoveResult{Removed: true})
}

// volumeMount trả mountpoint (đường dẫn hệ thống) của volume local, kiểm nằm dưới /var/lib/docker/volumes.
func volumeMount(ctx context.Context, e docker.Engine, name string) (string, error) {
	v, err := e.VolumeInspect(ctx, name)
	if err != nil {
		return "", dkErr(err)
	}
	if v.Driver != "local" || path.Clean(v.Mountpoint) != "/var/lib/docker/volumes/"+name+"/_data" {
		return "", &registry.OpError{Code: "precondition_failed", Message: "chỉ backup/restore volume driver local"}
	}
	return v.Mountpoint, nil
}

func serverOfRepo(p string) string {
	parts := strings.Split(p, "/")
	if len(parts) >= 3 && parts[0] == "itso" && reUUIDStr(parts[1]) {
		return parts[1]
	}
	return ""
}

func (d *Deps) dockerVolumeBackup(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo        backup.RepoParams `json:"repo"`
		Volumes     []string          `json:"volumes"`
		Consistency string            `json:"consistency"`
		Tags        []string          `json:"tags"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	repo, err := backup.ParseRepo(p.Repo)
	if err != nil {
		return nil, bkErr(err)
	}
	server := serverOfRepo(repo.Path)
	if repo.AccountUUID() != "" || server == "" {
		return nil, dkInvalid("volume docker chỉ backup vào repo server")
	}
	for _, t := range p.Tags {
		if !backup.ValidTag(t) {
			return nil, dkInvalid("tag không hợp lệ: " + t)
		}
	}
	if len(p.Volumes) == 0 || len(p.Volumes) > 50 || (p.Consistency != "pause" && p.Consistency != "none") {
		return nil, dkInvalid("volumes/consistency không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	var mounts []string
	for _, v := range p.Volumes {
		if err := checkDockerName(v, 128); err != nil {
			return nil, err
		}
		m, err := volumeMount(ctx, e, v)
		if err != nil {
			return nil, err
		}
		real, err := d.FS.Path(m)
		if err != nil {
			return nil, opErr(err)
		}
		mounts = append(mounts, real)
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	out := contracts.DockerVolumeBackupResult{Paused: []contracts.ContainerID{}}
	if p.Consistency == "pause" {
		cs, err := e.Containers(ctx, nil)
		if err != nil {
			return nil, dkErr(err)
		}
		users := volumeUsers(cs)
		seen := map[string]bool{}
		for _, v := range p.Volumes {
			for _, c := range users[v] {
				if c.State != "running" || seen[c.ID] {
					continue
				}
				seen[c.ID] = true
				if err := e.Action(ctx, c.ID, "pause"); err != nil {
					d.unpause(e, out.Paused)
					return nil, dkErr(err)
				}
				out.Paused = append(out.Paused, contracts.ContainerID(c.ID))
			}
		}
		// Luôn unpause, kể cả khi op bị hủy (context riêng).
		defer d.unpause(e, out.Paused)
	}
	args := []string{"backup", "--json", "--quiet", "--host", server}
	for _, t := range append([]string{"itso", "type:docker"}, p.Tags...) {
		args = append(args, "--tag", t)
	}
	args = append(dedupTags(args), "--")
	args = append(args, mounts...)
	code, raw, stderr, err := r.restic(ctx, "", nil, nil, args...)
	if err != nil {
		return nil, err
	}
	sum, err := r.summary(code, raw, stderr)
	if err != nil {
		return nil, err
	}
	out.SnapshotID, out.SizeBytes = contracts.ResticSnapshotID(sum.SnapshotID), contracts.Bytes(sum.TotalBytes)
	return toData(out)
}

func (d *Deps) unpause(e docker.Engine, ids []contracts.ContainerID) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for _, id := range ids {
		_ = e.Action(ctx, string(id), "unpause")
	}
}

func (d *Deps) dockerVolumeRestore(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo       backup.RepoParams `json:"repo"`
		SnapshotID string            `json:"snapshot_id"`
		Volume     string            `json:"volume"`
		Mode       string            `json:"mode"`
		Target     string            `json:"target"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if len(p.SnapshotID) < 8 || len(p.SnapshotID) > 64 || strings.Trim(p.SnapshotID, "0123456789abcdef") != "" {
		return nil, dkInvalid("snapshot_id không hợp lệ")
	}
	for _, n := range []string{p.Volume, p.Target} {
		if err := checkDockerName(n, 128); err != nil {
			return nil, err
		}
	}
	if p.Mode != "new" && p.Mode != "overwrite" {
		return nil, dkInvalid("mode không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	repo, err := backup.ParseRepo(p.Repo)
	if err != nil {
		return nil, bkErr(err)
	}
	if repo.AccountUUID() != "" {
		return nil, dkInvalid("volume docker chỉ restore từ repo server")
	}
	_, existsErr := e.VolumeInspect(ctx, p.Target)
	switch {
	case p.Mode == "new" && existsErr == nil:
		return nil, &registry.OpError{Code: "already_exists", Message: "volume đích đã tồn tại"}
	case p.Mode == "overwrite" && existsErr != nil:
		return nil, dkErr(existsErr)
	}
	if p.Mode == "overwrite" {
		cs, err := e.Containers(ctx, nil)
		if err != nil {
			return nil, dkErr(err)
		}
		for _, c := range volumeUsers(cs)[p.Target] {
			if c.State == "running" || c.State == "paused" || c.State == "restarting" {
				return nil, &registry.OpError{Code: "in_use", Message: "dừng container " + c.Name + " trước khi ghi đè volume"}
			}
		}
	}
	// Đường dẫn của volume nguồn trong snapshot: mountpoint chuẩn (agent backup đúng đường dẫn này).
	srcMount, err := d.FS.Path("/var/lib/docker/volumes/" + p.Volume + "/_data")
	if err != nil {
		return nil, opErr(err)
	}
	r, done, err := d.openRepo(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()
	stage, clean, err := d.staging("vol-" + opDirName(env.OpID))
	if err != nil {
		return nil, err
	}
	defer clean()
	code, _, stderr, err := r.restic(ctx, "", nil, nil, "restore", p.SnapshotID, "--target", stage, "--include", srcMount)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	src := filepath.Join(stage, filepath.FromSlash(srcMount))
	if fi, err := os.Lstat(src); err != nil || !fi.IsDir() {
		return nil, &registry.OpError{Code: "not_found", Message: "snapshot không chứa volume " + p.Volume}
	}
	if p.Mode == "new" {
		labels := map[string]string{}
		if v, err := e.VolumeInspect(ctx, p.Volume); err == nil && v.Labels[docker.LabelProject] != "" {
			labels[docker.LabelProject] = v.Labels[docker.LabelProject]
		}
		if err := e.CreateVolume(ctx, p.Target, labels); err != nil {
			return nil, dkErr(err)
		}
	}
	m, err := volumeMount(ctx, e, p.Target)
	if err != nil {
		return nil, err
	}
	dst, err := d.FS.Path(m)
	if err != nil {
		return nil, opErr(err)
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return nil, opErr(err)
	}
	if err := clearDir(dst); err != nil {
		return nil, opErr(err)
	}
	if err := copyTree(src, dst, !d.Sandbox); err != nil {
		return nil, opErr(err)
	}
	return toData(contracts.DockerVolumeRestoreResult{Restored: true, Volume: contracts.DockerVolumeName(p.Target)})
}

func clearDir(dir string) error {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// copyTree chép cây staging (agent sở hữu) vào volume: thư mục, file thường, symlink (không theo); giữ mode và
// chủ sở hữu (chown chỉ khi chạy root). Thiết bị/FIFO bị bỏ.
func copyTree(src, dst string, chown bool) error {
	return filepath.WalkDir(src, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil || rel == "." {
			return err
		}
		target := filepath.Join(dst, rel)
		fi, err := de.Info()
		if err != nil {
			return err
		}
		switch {
		case de.IsDir():
			if err := os.Mkdir(target, fi.Mode().Perm()); err != nil && !os.IsExist(err) {
				return err
			}
		case fi.Mode()&fs.ModeSymlink != 0:
			l, err := os.Readlink(p)
			if err != nil {
				return err
			}
			if err := os.Symlink(l, target); err != nil {
				return err
			}
		case fi.Mode().IsRegular():
			if err := copyFile(p, target, fi.Mode().Perm()); err != nil {
				return err
			}
		default:
			return nil
		}
		if chown {
			if uid, gid, ok := statOwner(fi); ok {
				_ = os.Lchown(target, uid, gid)
			}
		}
		return nil
	})
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// ---- network ----

var systemNetworks = map[string]bool{"bridge": true, "host": true, "none": true}

func (d *Deps) dockerNetworkList(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerNetworkListParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	ns, err := e.Networks(ctx)
	if err != nil {
		return nil, dkErr(err)
	}
	out := contracts.DockerNetworkListResult{Networks: []contracts.DockerNetworkListResultNetworksItem{}}
	for _, n := range ns {
		if checkHex(n.ID) != nil || len(out.Networks) >= 1000 {
			continue
		}
		out.Networks = append(out.Networks, contracts.DockerNetworkListResultNetworksItem{ID: n.ID, Name: truncate(n.Name, 200),
			Driver: truncate(n.Driver, 50), Internal: n.Internal, Containers: int64(n.Containers)})
	}
	return toData(out)
}

func (d *Deps) dockerNetworkCreate(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerNetworkCreateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkDockerName(string(p.Name), 63); err != nil || systemNetworks[string(p.Name)] {
		return nil, dkInvalid("tên network không hợp lệ")
	}
	if !reUUIDStr(string(p.ProjectUUID)) {
		return nil, dkInvalid("project_uuid không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	err = e.CreateNetwork(ctx, string(p.Name), p.Internal, map[string]string{docker.LabelProject: string(p.ProjectUUID)})
	if errors.Is(err, docker.ErrConflict) {
		return toData(contracts.DockerNetworkCreateResult{Created: false})
	}
	if err != nil {
		return nil, dkErr(err)
	}
	return toData(contracts.DockerNetworkCreateResult{Created: true})
}

func (d *Deps) dockerNetworkRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.DockerNetworkRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	name := string(p.Name)
	if err := checkDockerName(name, 63); err != nil || systemNetworks[name] {
		return nil, dkInvalid("tên network không hợp lệ")
	}
	e, err := d.engine()
	if err != nil {
		return nil, err
	}
	ns, err := e.Networks(ctx)
	if err != nil {
		return nil, dkErr(err)
	}
	for _, n := range ns {
		if n.Name != name {
			continue
		}
		if projectOf(n.Labels) == "" {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "network không do panel quản lý"}
		}
		if n.Containers > 0 {
			return nil, &registry.OpError{Code: "in_use", Message: fmt.Sprintf("network đang có %d container", n.Containers)}
		}
		if err := e.RemoveNetwork(ctx, name); err != nil {
			return nil, dkErr(err)
		}
		return toData(contracts.DockerNetworkRemoveResult{Removed: true})
	}
	return toData(contracts.DockerNetworkRemoveResult{Removed: false})
}
