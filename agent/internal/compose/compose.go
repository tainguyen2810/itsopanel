// Package compose là validator Docker Compose của agent (D-96, ADR 0041): nguồn sự thật cho câu hỏi "compose này
// có được chạy không". Chặn theo mã rule (privileged, bind mount hệ thống, docker.sock, host network…), viết lại
// cổng publish về 127.0.0.1:<cổng cấp phát>, thêm giới hạn tài nguyên mặc định và nhãn io.itso.*. Chỉ YAML do
// validator trả (kèm sha256) mới được compose.apply ghi xuống đĩa.
package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// MaxYAML là kích thước compose tối đa (khớp ComposeYaml maxLength).
const MaxYAML = 262144

// Mã rule (ComposeRule).
const (
	RulePrivileged      = "privileged"
	RuleCapAdd          = "cap_add"
	RuleDevices         = "devices"
	RuleBindMount       = "bind_mount"
	RuleHostNetwork     = "host_network"
	RuleHostPID         = "host_pid"
	RuleHostIPC         = "host_ipc"
	RuleHostUserns      = "host_userns"
	RuleSecurityOpt     = "security_opt"
	RuleDockerSocket    = "docker_socket"
	RuleBindMountSystem = "bind_mount_system"
	RuleBuild           = "build"
	RuleServices        = "services"
	RuleYAML            = "yaml"
	RuleReservedPort    = "reserved_port"
	RuleMissingLimits   = "missing_limits"
	RuleLatestTag       = "latest_tag"
)

// Overridable: rule SUPER_ADMIN được ghi đè kèm lý do (ADR 0041 §3). Các rule khác không bao giờ ghi đè được.
var Overridable = map[string]bool{RulePrivileged: true, RuleCapAdd: true, RuleDevices: true, RuleBindMount: true}

// ReservedHostPorts là cổng host không bao giờ được publish (SSH, web, panel).
var ReservedHostPorts = map[int]bool{22: true, 80: true, 443: true, 8443: true}

// SafeCaps là capability được thêm mà không cần ghi đè.
var SafeCaps = map[string]bool{"NET_BIND_SERVICE": true, "CHOWN": true, "SETUID": true, "SETGID": true}

// Override là một ghi đè của SUPER_ADMIN.
type Override struct {
	Rule, Reason, By string
}

// Limits là giới hạn mặc định thêm cho service thiếu.
type Limits struct {
	MemMB int64
	CPUs  float64
	Pids  int64
}

// Options là tham số validate.
type Options struct {
	ProjectUUID   string
	Allocated     []int64
	Defaults      Limits
	Overrides     []Override
	AllowHomeBind bool
}

// Finding là một phát hiện.
type Finding struct {
	Rule, Severity, Service, Path, Message string
	Overridable                            bool
}

// Rewrite là một thay đổi validator áp lên YAML.
type Rewrite struct {
	Service, Path string
	Before        *string
	After         string
}

// PortMap là một cổng publish sau khi viết lại.
type PortMap struct {
	Service       string
	ContainerPort int
	HostPort      int
	Protocol      string
}

// Result là kết quả validate. YAML/SHA256 chỉ có khi OK.
type Result struct {
	OK       bool
	Findings []Finding
	Rewrites []Rewrite
	Ports    []PortMap
	Images   []string
	Volumes  []string
	YAML     []byte
	SHA256   string
}

var (
	reService = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	reVolume  = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	reImage   = regexp.MustCompile(`^([a-z0-9]([a-z0-9.-]{0,252}[a-z0-9])?(:[0-9]{1,5})?/)?[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[0-9a-f]{64})?$`)
	reUUID    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reCap     = regexp.MustCompile(`^(CAP_)?[A-Z_]{2,32}$`)
)

// Khóa service được phép nguyên trạng.
var serviceKeys = map[string]bool{
	"image": true, "command": true, "entrypoint": true, "environment": true, "ports": true, "volumes": true, "networks": true,
	"depends_on": true, "restart": true, "healthcheck": true, "labels": true, "mem_limit": true, "mem_reservation": true,
	"memswap_limit": true, "cpus": true, "cpu_shares": true, "pids_limit": true, "user": true, "working_dir": true,
	"expose": true, "hostname": true, "domainname": true, "tmpfs": true, "read_only": true, "stop_grace_period": true,
	"stop_signal": true, "ulimits": true, "init": true, "tty": true, "stdin_open": true, "shm_size": true, "cap_drop": true,
	"platform": true, "profiles": true, "dns": true, "dns_search": true, "extra_hosts": true, "links": true, "group_add": true,
	"pull_policy": true,
	// kiểm riêng bên dưới
	"privileged": true, "cap_add": true, "devices": true, "device_cgroup_rules": true, "network_mode": true, "pid": true,
	"ipc": true, "userns_mode": true, "security_opt": true, "sysctls": true, "build": true,
}

// Trường được dùng biến nội suy `${VAR}` (giá trị lấy từ .env do panel ghi). Ngoài các trường này, `$` phải viết
// `$$`: nội suy ở ports/volumes/privileged… sẽ vượt qua validator.
var interpolationOK = map[string]bool{"environment": true, "command": true, "entrypoint": true, "healthcheck": true}

// Đường dẫn hệ thống: bind chính nó, thư mục con hoặc thư mục cha của nó đều bị chặn (bind_mount_system).
var systemPaths = []string{"/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/run", "/var/run", "/var/lib", "/var/log",
	"/var/spool", "/var/backups", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt/itso", "/snap", "/tmp", "/var/tmp"}

type validator struct {
	o        Options
	r        Result
	override map[string]Override
	alloc    []int
	used     map[int]bool
	volumes  map[string]bool // tên volume khai báo cấp cao
}

func (v *validator) add(rule, sev, svc, p, msg string) {
	f := Finding{Rule: rule, Severity: sev, Service: svc, Path: p, Message: msg, Overridable: Overridable[rule]}
	if ov, ok := v.override[rule]; ok && f.Overridable && sev == "error" {
		f.Severity = "warning"
		f.Message += " (được ghi đè: " + ov.Reason + ")"
	}
	if len(v.r.Findings) < 500 {
		v.r.Findings = append(v.r.Findings, f)
	}
}

func (v *validator) errf(rule, svc, p, format string, a ...any) {
	v.add(rule, "error", svc, p, fmt.Sprintf(format, a...))
}

func (v *validator) rewrite(svc, p string, before *string, after string) {
	if len(v.r.Rewrites) < 500 {
		v.r.Rewrites = append(v.r.Rewrites, Rewrite{Service: svc, Path: p, Before: before, After: after})
	}
}

// Validate kiểm và viết lại compose. Không bao giờ panic với đầu vào bất kỳ.
func Validate(src []byte, o Options) (res Result) {
	v := &validator{o: o, override: map[string]Override{}, used: map[int]bool{}, volumes: map[string]bool{}}
	defer func() {
		if p := recover(); p != nil {
			res = Result{Findings: []Finding{{Rule: RuleYAML, Severity: "error", Path: "", Message: fmt.Sprint("compose không đọc được: ", p)}}}
		}
		v.normalize(&res)
	}()
	for _, ov := range o.Overrides {
		if Overridable[ov.Rule] {
			v.override[ov.Rule] = ov
		}
	}
	for _, p := range o.Allocated {
		v.alloc = append(v.alloc, int(p))
	}
	if !reUUID.MatchString(o.ProjectUUID) {
		v.errf(RuleYAML, "", "", "project_uuid không hợp lệ")
		return v.r
	}
	if len(src) == 0 || len(src) > MaxYAML || bytes.IndexByte(src, 0) >= 0 {
		v.errf(RuleYAML, "", "", "compose rỗng, quá %d byte hoặc chứa byte NUL", MaxYAML)
		return v.r
	}
	root, err := parse(src)
	if err != nil {
		v.errf(RuleYAML, "", "", "%s", err.Error())
		return v.r
	}
	if !v.structure(root, "", 0) {
		return v.r
	}
	v.top(root)
	if v.r.hasErrors() {
		return v.r
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		v.errf(RuleYAML, "", "", "không ghi lại được YAML: %v", err)
		return v.r
	}
	_ = enc.Close()
	if buf.Len() > MaxYAML {
		v.errf(RuleYAML, "", "", "YAML sau khi viết lại quá %d byte", MaxYAML)
		return v.r
	}
	v.r.YAML = buf.Bytes()
	sum := sha256.Sum256(v.r.YAML)
	v.r.SHA256 = hex.EncodeToString(sum[:])
	v.r.OK = true
	return v.r
}

func (v *validator) normalize(r *Result) {
	if r.Findings == nil {
		r.Findings = []Finding{}
	}
	if r.Rewrites == nil {
		r.Rewrites = []Rewrite{}
	}
	if r.Ports == nil {
		r.Ports = []PortMap{}
	}
	if r.Images == nil {
		r.Images = []string{}
	}
	if r.Volumes == nil {
		r.Volumes = []string{}
	}
	if r.hasErrors() {
		r.OK, r.YAML, r.SHA256 = false, nil, ""
	}
}

func (r *Result) hasErrors() bool {
	for _, f := range r.Findings {
		if f.Severity == "error" {
			return true
		}
	}
	return false
}

// parse đọc đúng một tài liệu YAML thành cây Node (alias KHÔNG được mở rộng ở bước này).
func parse(src []byte) (*yaml.Node, error) {
	dec := yaml.NewDecoder(bytes.NewReader(src))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("YAML lỗi cú pháp: %s", trim(err.Error()))
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("chỉ nhận một tài liệu YAML")
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("compose phải là một mapping")
	}
	return doc.Content[0], nil
}

func trim(s string) string {
	if len(s) > 300 {
		return s[:300]
	}
	return s
}

// structure kiểm toàn cây: không alias/anchor/merge, không tag tùy chỉnh, không khóa trùng, độ sâu và số nút có hạn,
// biến nội suy chỉ ở trường cho phép.
func (v *validator) structure(n *yaml.Node, p string, depth int) bool {
	count := 0
	var walk func(n *yaml.Node, p string, depth int, interp bool) bool
	walk = func(n *yaml.Node, p string, depth int, interp bool) bool {
		count++
		if count > 50000 || depth > 50 {
			v.errf(RuleYAML, "", p, "YAML quá lớn hoặc lồng quá sâu")
			return false
		}
		if n.Kind == yaml.AliasNode || n.Anchor != "" {
			v.errf(RuleYAML, "", p, "không nhận anchor/alias YAML (&, *, <<)")
			return false
		}
		if n.Style&yaml.TaggedStyle != 0 || (n.Tag != "" && !strings.HasPrefix(n.Tag, "!!")) {
			v.errf(RuleYAML, "", p, "không nhận tag YAML tường minh")
			return false
		}
		switch n.Kind {
		case yaml.MappingNode:
			seen := map[string]bool{}
			for i := 0; i+1 < len(n.Content); i += 2 {
				k, val := n.Content[i], n.Content[i+1]
				if k.Kind != yaml.ScalarNode || k.Anchor != "" || k.Tag == "!!merge" || k.Value == "<<" {
					v.errf(RuleYAML, "", p, "khóa mapping không hợp lệ (merge/alias)")
					return false
				}
				if seen[k.Value] {
					v.errf(RuleYAML, "", p, "khóa trùng: %s", k.Value)
					return false
				}
				seen[k.Value] = true
				if strings.Contains(k.Value, "$") {
					v.errf(RuleYAML, "", p, "không dùng biến nội suy trong khóa")
					return false
				}
				childInterp := interp
				// services.<svc>.<field>
				if parts := strings.Split(p, "."); len(parts) == 2 && parts[0] == "services" {
					childInterp = interpolationOK[k.Value]
				}
				if !walk(val, join(p, k.Value), depth+1, childInterp) {
					return false
				}
			}
		case yaml.SequenceNode:
			for i, c := range n.Content {
				if !walk(c, fmt.Sprintf("%s[%d]", p, i), depth+1, interp) {
					return false
				}
			}
		case yaml.ScalarNode:
			if !interp && hasInterpolation(n.Value) {
				v.errf(RuleYAML, "", p, "biến nội suy `$` chỉ được dùng trong environment/command/entrypoint/healthcheck (viết `$$` nếu là ký tự thường)")
				return false
			}
		}
		return true
	}
	return walk(n, p, depth, false)
}

func hasInterpolation(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == '$' {
			if i+1 < len(s) && s[i+1] == '$' {
				i++
				continue
			}
			return true
		}
	}
	return false
}

func join(p, k string) string {
	if p == "" {
		return k
	}
	return p + "." + k
}

func mapGet(m *yaml.Node, key string) (*yaml.Node, int) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1], i
		}
	}
	return nil, -1
}

func mapSet(m *yaml.Node, key string, val *yaml.Node) {
	if _, i := mapGet(m, key); i >= 0 {
		m.Content[i+1] = val
		return
	}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, val)
}

func str(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }

func (v *validator) top(root *yaml.Node) {
	for i := 0; i+1 < len(root.Content); i += 2 {
		switch k := root.Content[i].Value; k {
		case "services", "volumes", "networks", "version":
		default:
			v.errf(RuleYAML, "", k, "khóa cấp cao %q không được phép (chỉ services, volumes, networks)", k)
		}
	}
	if vols, _ := mapGet(root, "volumes"); vols != nil {
		v.topVolumes(vols)
	}
	if nets, _ := mapGet(root, "networks"); nets != nil {
		v.topNetworks(nets)
	}
	svcs, _ := mapGet(root, "services")
	if svcs == nil || svcs.Kind != yaml.MappingNode || len(svcs.Content) == 0 {
		v.errf(RuleServices, "", "services", "compose cần ít nhất một service")
		return
	}
	if len(svcs.Content)/2 > 50 {
		v.errf(RuleServices, "", "services", "tối đa 50 service")
		return
	}
	for i := 0; i+1 < len(svcs.Content); i += 2 {
		name := svcs.Content[i].Value
		if !reService.MatchString(name) {
			v.errf(RuleServices, "", "services."+name, "tên service không hợp lệ (chữ thường, số, `_ . -`)")
			continue
		}
		if svcs.Content[i+1].Kind != yaml.MappingNode {
			v.errf(RuleYAML, name, "services."+name, "service phải là mapping")
			continue
		}
		v.service(name, svcs.Content[i+1])
	}
}

func (v *validator) topVolumes(vols *yaml.Node) {
	if vols.Kind != yaml.MappingNode {
		v.errf(RuleYAML, "", "volumes", "volumes phải là mapping")
		return
	}
	for i := 0; i+1 < len(vols.Content); i += 2 {
		name, def := vols.Content[i].Value, vols.Content[i+1]
		p := "volumes." + name
		if !reVolume.MatchString(name) {
			v.errf(RuleYAML, "", p, "tên volume không hợp lệ")
			continue
		}
		v.volumes[name] = true
		full := "itso_" + v.o.ProjectUUID + "_" + name
		if len(v.r.Volumes) < 100 {
			v.r.Volumes = append(v.r.Volumes, full)
		}
		if def.Kind == yaml.ScalarNode && (def.Tag == "!!null" || def.Value == "") {
			continue
		}
		if def.Kind != yaml.MappingNode {
			v.errf(RuleYAML, "", p, "định nghĩa volume phải là mapping")
			continue
		}
		for j := 0; j+1 < len(def.Content); j += 2 {
			k, val := def.Content[j].Value, def.Content[j+1]
			switch k {
			case "driver":
				if val.Value != "local" {
					v.errf(RuleYAML, "", p+".driver", "chỉ nhận driver local")
				}
			case "labels":
				v.checkLabels("", p+".labels", val)
			case "driver_opts":
				v.errf(RuleBindMountSystem, "", p+".driver_opts", "driver_opts (bind trá hình qua type=none,o=bind) không được phép")
			default:
				v.errf(RuleYAML, "", p+"."+k, "khóa volume %q không được phép (external/name trỏ tới volume ngoài project)", k)
			}
		}
	}
}

func (v *validator) topNetworks(nets *yaml.Node) {
	if nets.Kind != yaml.MappingNode {
		v.errf(RuleYAML, "", "networks", "networks phải là mapping")
		return
	}
	for i := 0; i+1 < len(nets.Content); i += 2 {
		name, def := nets.Content[i].Value, nets.Content[i+1]
		p := "networks." + name
		if !reVolume.MatchString(name) || name == "host" || name == "none" || name == "bridge" {
			v.errf(RuleYAML, "", p, "tên network không hợp lệ")
			continue
		}
		if def.Kind == yaml.ScalarNode && (def.Tag == "!!null" || def.Value == "") {
			continue
		}
		if def.Kind != yaml.MappingNode {
			v.errf(RuleYAML, "", p, "định nghĩa network phải là mapping")
			continue
		}
		for j := 0; j+1 < len(def.Content); j += 2 {
			k, val := def.Content[j].Value, def.Content[j+1]
			switch k {
			case "driver":
				if val.Value != "bridge" {
					v.errf(RuleHostNetwork, "", p+".driver", "chỉ nhận driver bridge")
				}
			case "internal":
			case "labels":
				v.checkLabels("", p+".labels", val)
			default:
				v.errf(RuleYAML, "", p+"."+k, "khóa network %q không được phép", k)
			}
		}
	}
}

func truthy(n *yaml.Node) bool {
	if n == nil || n.Kind != yaml.ScalarNode {
		return n != nil
	}
	s := strings.ToLower(n.Value)
	return s != "false" && s != "no" && s != "0" && s != "" && s != "off"
}

func scalars(n *yaml.Node) []string {
	switch n.Kind {
	case yaml.ScalarNode:
		return []string{n.Value}
	case yaml.SequenceNode:
		out := []string{}
		for _, c := range n.Content {
			if c.Kind == yaml.ScalarNode {
				out = append(out, c.Value)
			} else {
				out = append(out, "<"+fmt.Sprint(c.Kind)+">")
			}
		}
		return out
	}
	return []string{"<mapping>"}
}

func (v *validator) service(name string, s *yaml.Node) {
	base := "services." + name
	for i := 0; i+1 < len(s.Content); i += 2 {
		k, val := s.Content[i].Value, s.Content[i+1]
		p := base + "." + k
		if !serviceKeys[k] {
			v.errf(RuleYAML, name, p, "khóa %q không được phép trong service", k)
			continue
		}
		switch k {
		case "build":
			v.errf(RuleBuild, name, p, "không build image từ context trên host; dùng image từ registry")
		case "privileged":
			if truthy(val) {
				v.errf(RulePrivileged, name, p, "container privileged có toàn quyền host")
			}
		case "cap_add":
			for _, c := range scalars(val) {
				cu := strings.TrimPrefix(strings.ToUpper(c), "CAP_")
				if !reCap.MatchString(strings.ToUpper(c)) || !SafeCaps[cu] {
					v.errf(RuleCapAdd, name, p, "cap_add %s cần SUPER_ADMIN ghi đè", c)
				}
			}
		case "devices", "device_cgroup_rules":
			v.errf(RuleDevices, name, p, "truy cập thiết bị host cần SUPER_ADMIN ghi đè")
		case "network_mode":
			switch m := val.Value; {
			case m == "host":
				v.errf(RuleHostNetwork, name, p, "network_mode host dùng chung network stack của host")
			case m == "none" || m == "bridge" || strings.HasPrefix(m, "service:"):
			default:
				v.errf(RuleHostNetwork, name, p, "network_mode %q không được phép", m)
			}
		case "pid":
			if val.Value != "" {
				v.errf(RuleHostPID, name, p, "pid %q: không chia sẻ PID namespace", val.Value)
			}
		case "ipc":
			if m := val.Value; m != "private" && m != "shareable" && !strings.HasPrefix(m, "service:") {
				v.errf(RuleHostIPC, name, p, "ipc %q: không chia sẻ IPC của host/container khác", m)
			}
		case "userns_mode":
			v.errf(RuleHostUserns, name, p, "userns_mode không được phép")
		case "security_opt":
			for _, o := range scalars(val) {
				switch strings.ReplaceAll(o, "=", ":") {
				case "no-new-privileges", "no-new-privileges:true":
				default:
					v.errf(RuleSecurityOpt, name, p, "security_opt %q làm yếu cách ly (seccomp/apparmor/label)", o)
				}
			}
		case "sysctls":
			v.errf(RuleSecurityOpt, name, p, "sysctls không được phép")
		case "volumes":
			v.serviceVolumes(name, p, val)
		case "labels":
			v.checkLabels(name, p, val)
		}
	}
	img, _ := mapGet(s, "image")
	_, hasBuild := mapGet(s, "build")
	switch {
	case img == nil || img.Kind != yaml.ScalarNode || img.Value == "":
		if hasBuild < 0 {
			v.errf(RuleServices, name, base+".image", "service cần image")
		}
	case !reImage.MatchString(img.Value) || strings.Contains(img.Value, ".."):
		v.errf(RuleYAML, name, base+".image", "image %q không hợp lệ", trim(img.Value))
	default:
		if len(v.r.Images) < 100 {
			v.r.Images = append(v.r.Images, img.Value)
		}
		if _, tag := splitTag(img.Value); tag == "" || tag == "latest" {
			v.add(RuleLatestTag, "warning", name, base+".image", "image không ghim tag (latest): cập nhật sẽ khó đoán và khó quay về")
		}
	}
	if ports, _ := mapGet(s, "ports"); ports != nil {
		v.servicePorts(name, base+".ports", ports)
	}
	v.limits(name, base, s)
	v.labels(name, base, s)
}

// splitTag trả repo và tag ("" nếu không có tag và không có digest; "@" nếu ghim digest).
func splitTag(ref string) (string, string) {
	if i := strings.Index(ref, "@"); i >= 0 {
		return ref[:i], "@"
	}
	slash := strings.LastIndex(ref, "/")
	if i := strings.LastIndex(ref, ":"); i > slash {
		return ref[:i], ref[i+1:]
	}
	return ref, ""
}

func (v *validator) checkLabels(svc, p string, n *yaml.Node) {
	var keys, vals []string
	switch n.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			keys, vals = append(keys, n.Content[i].Value), append(vals, n.Content[i+1].Value)
		}
	case yaml.SequenceNode:
		for _, c := range n.Content {
			k, val, _ := strings.Cut(c.Value, "=")
			keys, vals = append(keys, k), append(vals, val)
		}
	default:
		v.errf(RuleYAML, svc, p, "labels phải là mapping hoặc danh sách")
		return
	}
	for i, k := range keys {
		// Nhãn do chính validator gắn (validate lại YAML đã viết lại) được giữ nếu đúng giá trị.
		if svc != "" && ((k == "io.itso.project" && vals[i] == v.o.ProjectUUID) || (k == "io.itso.service" && vals[i] == svc)) {
			continue
		}
		if strings.HasPrefix(k, "io.itso.") || strings.HasPrefix(k, "com.docker.compose.") {
			v.errf(RuleYAML, svc, p, "nhãn %q dành riêng cho panel/compose", k)
		}
	}
}

// classifyBind phân loại nguồn bind mount.
func (v *validator) classifyBind(svc, p, src string) {
	switch {
	case strings.HasPrefix(src, "~"):
		v.errf(RuleBindMountSystem, svc, p, "bind thư mục home của root (~) không được phép")
	case strings.HasPrefix(src, "."):
		c := path.Clean(src)
		if c != "data" && !strings.HasPrefix(c, "data/") {
			v.errf(RuleBindMountSystem, svc, p, "bind tương đối chỉ được trong ./data của project (%s)", src)
		}
	case strings.HasPrefix(src, "/"):
		c := path.Clean(src)
		if strings.Contains(c, "docker.sock") || strings.Contains(c, "containerd.sock") || strings.HasSuffix(c, ".sock") {
			v.errf(RuleDockerSocket, svc, p, "mount socket %s = quyền root trên host", c)
			return
		}
		if c == "/" {
			v.errf(RuleBindMountSystem, svc, p, "bind / của host")
			return
		}
		for _, sp := range systemPaths {
			if c == sp || strings.HasPrefix(c, sp+"/") || strings.HasPrefix(sp, c+"/") {
				v.errf(RuleBindMountSystem, svc, p, "bind đường dẫn hệ thống %s", c)
				return
			}
		}
		if c == "/home" || strings.HasPrefix(c, "/home/") || strings.HasPrefix("/home", c+"/") {
			if !v.o.AllowHomeBind {
				v.errf(RuleBindMountSystem, svc, p, "bind /home (dữ liệu account) không được phép")
				return
			}
		}
		v.errf(RuleBindMount, svc, p, "bind thư mục host %s cần SUPER_ADMIN ghi đè", c)
	default:
		v.errf(RuleYAML, svc, p, "nguồn bind %q không hợp lệ", src)
	}
}

func (v *validator) namedVolume(svc, p, name string) {
	if !reVolume.MatchString(name) {
		v.errf(RuleYAML, svc, p, "tên volume %q không hợp lệ", name)
		return
	}
	if !v.volumes[name] {
		v.errf(RuleYAML, svc, p, "volume %q chưa khai báo ở volumes cấp cao", name)
	}
}

func (v *validator) serviceVolumes(svc, p string, n *yaml.Node) {
	if n.Kind != yaml.SequenceNode {
		v.errf(RuleYAML, svc, p, "volumes phải là danh sách")
		return
	}
	for i, it := range n.Content {
		ip := fmt.Sprintf("%s[%d]", p, i)
		switch it.Kind {
		case yaml.ScalarNode:
			parts := strings.Split(it.Value, ":")
			if len(parts) == 1 {
				continue // volume ẩn danh: chỉ đường dẫn trong container
			}
			if len(parts) > 3 {
				v.errf(RuleYAML, svc, ip, "cú pháp volume không hợp lệ")
				continue
			}
			src := parts[0]
			if strings.HasPrefix(src, "/") || strings.HasPrefix(src, ".") || strings.HasPrefix(src, "~") {
				v.classifyBind(svc, ip, src)
			} else {
				v.namedVolume(svc, ip, src)
			}
		case yaml.MappingNode:
			typ, src := "volume", ""
			for j := 0; j+1 < len(it.Content); j += 2 {
				k, val := it.Content[j].Value, it.Content[j+1]
				switch k {
				case "type":
					typ = val.Value
				case "source":
					src = val.Value
				case "target", "read_only", "consistency", "volume", "tmpfs":
				case "bind":
					if pr, _ := mapGet(val, "propagation"); pr != nil && pr.Value != "private" && pr.Value != "rprivate" {
						v.errf(RuleBindMountSystem, svc, ip, "bind propagation %q lan mount ra host", pr.Value)
					}
				default:
					v.errf(RuleYAML, svc, ip+"."+k, "khóa volume %q không được phép", k)
				}
			}
			switch typ {
			case "tmpfs":
			case "volume":
				if src != "" {
					v.namedVolume(svc, ip, src)
				}
			case "bind":
				v.classifyBind(svc, ip, src)
			default:
				v.errf(RuleYAML, svc, ip, "loại mount %q không được phép", typ)
			}
		default:
			v.errf(RuleYAML, svc, ip, "mục volume không hợp lệ")
		}
	}
}

type portSpec struct {
	host      int // 0 = không chỉ định
	container int
	proto     string
	before    string
	node      int
}

func parseShortPort(s string) (portSpec, error) {
	ps := portSpec{proto: "tcp", before: s}
	if base, proto, ok := strings.Cut(s, "/"); ok {
		if proto != "tcp" && proto != "udp" {
			return ps, fmt.Errorf("giao thức %q không hỗ trợ", proto)
		}
		s, ps.proto = base, proto
	}
	if strings.HasPrefix(s, "[") { // [ipv6]:host:container
		end := strings.Index(s, "]")
		if end < 0 || end+1 >= len(s) || s[end+1] != ':' {
			return ps, errors.New("cú pháp cổng không hợp lệ")
		}
		s = "x" + s[end+1:]
	}
	parts := strings.Split(s, ":")
	var hostS, ctS string
	switch len(parts) {
	case 1:
		ctS = parts[0]
	case 2:
		hostS, ctS = parts[0], parts[1]
	case 3:
		hostS, ctS = parts[1], parts[2]
	default:
		return ps, errors.New("cú pháp cổng không hợp lệ")
	}
	if strings.Contains(hostS, "-") || strings.Contains(ctS, "-") {
		return ps, errors.New("không nhận dải cổng")
	}
	c, err := strconv.Atoi(ctS)
	if err != nil || c < 1 || c > 65535 {
		return ps, fmt.Errorf("cổng container %q không hợp lệ", ctS)
	}
	ps.container = c
	if hostS != "" {
		h, err := strconv.Atoi(hostS)
		if err != nil || h < 1 || h > 65535 {
			return ps, fmt.Errorf("cổng host %q không hợp lệ", hostS)
		}
		ps.host = h
	}
	return ps, nil
}

func (v *validator) servicePorts(svc, p string, n *yaml.Node) {
	if n.Kind != yaml.SequenceNode {
		v.errf(RuleYAML, svc, p, "ports phải là danh sách")
		return
	}
	var specs []portSpec
	for i, it := range n.Content {
		ip := fmt.Sprintf("%s[%d]", p, i)
		var ps portSpec
		var err error
		switch it.Kind {
		case yaml.ScalarNode:
			ps, err = parseShortPort(it.Value)
		case yaml.MappingNode:
			short := ""
			tgt, _ := mapGet(it, "target")
			pub, _ := mapGet(it, "published")
			proto, _ := mapGet(it, "protocol")
			for j := 0; j+1 < len(it.Content); j += 2 {
				switch it.Content[j].Value {
				case "target", "published", "protocol", "host_ip", "mode", "name", "app_protocol":
				default:
					err = fmt.Errorf("khóa cổng %q không được phép", it.Content[j].Value)
				}
			}
			if tgt == nil {
				err = errors.New("thiếu target")
			}
			if err == nil {
				short = tgt.Value
				if pub != nil && pub.Value != "" {
					short = pub.Value + ":" + short
				}
				if proto != nil && proto.Value != "" {
					short += "/" + proto.Value
				}
				ps, err = parseShortPort(short)
				ps.before = "target=" + tgt.Value
				if pub != nil {
					ps.before += " published=" + pub.Value
				}
			}
		default:
			err = errors.New("mục cổng không hợp lệ")
		}
		if err != nil {
			v.errf(RuleYAML, svc, ip, "%s", err.Error())
			continue
		}
		if ReservedHostPorts[ps.host] {
			v.errf(RuleReservedPort, svc, ip, "cổng host %d dành cho SSH/web/panel", ps.host)
			continue
		}
		ps.node = i
		specs = append(specs, ps)
	}
	if v.r.hasErrors() {
		return
	}
	// Cổng host đã nằm trong danh sách cấp phát được giữ nguyên (validate lại YAML đã viết lại cho kết quả như cũ).
	assigned := make([]int, len(specs))
	for i, ps := range specs {
		for _, a := range v.alloc {
			if a == ps.host && !v.used[a] {
				assigned[i], v.used[a] = a, true
				break
			}
		}
	}
	for i := range specs {
		if assigned[i] != 0 {
			continue
		}
		for _, a := range v.alloc {
			if !v.used[a] {
				assigned[i], v.used[a] = a, true
				break
			}
		}
		if assigned[i] == 0 {
			v.errf(RuleServices, svc, fmt.Sprintf("%s[%d]", p, specs[i].node), "thiếu cổng cấp phát (dải 20000–29999) cho cổng publish này")
			return
		}
	}
	for i, ps := range specs {
		after := fmt.Sprintf("127.0.0.1:%d:%d/%s", assigned[i], ps.container, ps.proto)
		n.Content[ps.node] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: after, Style: yaml.DoubleQuotedStyle}
		if ps.before != after {
			b := ps.before
			v.rewrite(svc, fmt.Sprintf("%s[%d]", p, ps.node), &b, after)
		}
		if len(v.r.Ports) < 200 {
			v.r.Ports = append(v.r.Ports, PortMap{Service: svc, ContainerPort: ps.container, HostPort: assigned[i], Protocol: ps.proto})
		}
	}
}

func (v *validator) limits(svc, base string, s *yaml.Node) {
	var added []string
	d := v.o.Defaults
	if n, _ := mapGet(s, "mem_limit"); n == nil && d.MemMB > 0 {
		val := fmt.Sprintf("%dm", d.MemMB)
		mapSet(s, "mem_limit", str(val))
		v.rewrite(svc, base+".mem_limit", nil, val)
		added = append(added, "mem_limit="+val)
	}
	if n, _ := mapGet(s, "cpus"); n == nil && d.CPUs > 0 {
		val := strconv.FormatFloat(d.CPUs, 'f', -1, 64)
		if !strings.Contains(val, ".") {
			val += ".0"
		}
		mapSet(s, "cpus", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: val})
		v.rewrite(svc, base+".cpus", nil, val)
		added = append(added, "cpus="+val)
	}
	if n, _ := mapGet(s, "pids_limit"); n == nil && d.Pids > 0 {
		val := strconv.FormatInt(d.Pids, 10)
		mapSet(s, "pids_limit", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: val})
		v.rewrite(svc, base+".pids_limit", nil, val)
		added = append(added, "pids_limit="+val)
	}
	if len(added) > 0 {
		v.add(RuleMissingLimits, "warning", svc, base, "thiếu giới hạn tài nguyên, đã thêm mặc định: "+strings.Join(added, ", "))
	}
}

// labels gắn io.itso.project / io.itso.service (đổi labels dạng danh sách sang mapping).
func (v *validator) labels(svc, base string, s *yaml.Node) {
	l, _ := mapGet(s, "labels")
	m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	if l != nil && l.Kind == yaml.MappingNode {
		m = l
	} else if l != nil && l.Kind == yaml.SequenceNode {
		for _, c := range l.Content {
			k, val, _ := strings.Cut(c.Value, "=")
			m.Content = append(m.Content, str(k), str(val))
		}
	}
	mapSet(m, "io.itso.project", str(v.o.ProjectUUID))
	mapSet(m, "io.itso.service", str(svc))
	mapSet(s, "labels", m)
}

// Service là phần của YAML đã validate mà agent cần khi chạy (cổng, volume, bind tương đối).
type Service struct {
	Name     string
	Image    string
	Ports    []PortMap
	Volumes  []string // volume có tên (chưa có tiền tố project)
	RelBinds []string // nguồn bind tương đối (./data/…)
}

// Services đọc YAML đã qua Validate.
func Services(src []byte) ([]Service, error) {
	root, err := parse(src)
	if err != nil {
		return nil, err
	}
	svcs, _ := mapGet(root, "services")
	if svcs == nil || svcs.Kind != yaml.MappingNode {
		return nil, errors.New("thiếu services")
	}
	var out []Service
	for i := 0; i+1 < len(svcs.Content); i += 2 {
		s := Service{Name: svcs.Content[i].Value}
		def := svcs.Content[i+1]
		if img, _ := mapGet(def, "image"); img != nil {
			s.Image = img.Value
		}
		if ports, _ := mapGet(def, "ports"); ports != nil {
			for _, p := range ports.Content {
				ps, err := parseShortPort(p.Value)
				if err != nil {
					return nil, err
				}
				s.Ports = append(s.Ports, PortMap{Service: s.Name, ContainerPort: ps.container, HostPort: ps.host, Protocol: ps.proto})
			}
		}
		if vols, _ := mapGet(def, "volumes"); vols != nil {
			for _, it := range vols.Content {
				src := ""
				if it.Kind == yaml.ScalarNode {
					if parts := strings.Split(it.Value, ":"); len(parts) > 1 {
						src = parts[0]
					}
				} else if sn, _ := mapGet(it, "source"); sn != nil {
					src = sn.Value
				}
				switch {
				case src == "":
				case strings.HasPrefix(src, "."):
					s.RelBinds = append(s.RelBinds, path.Clean(src))
				case !strings.HasPrefix(src, "/"):
					s.Volumes = append(s.Volumes, src)
				}
			}
		}
		out = append(out, s)
	}
	return out, nil
}
