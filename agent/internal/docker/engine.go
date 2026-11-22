// Package docker là client Docker Engine API của agent (D-94, ADR 0039): nói HTTP qua unix socket
// /var/run/docker.sock, có timeout và giới hạn kích thước phản hồi; không gọi CLI docker. Fake (bộ nhớ) dùng cho
// sandbox và test.
package docker

import (
	"context"
	"errors"
	"strings"
)

// Lỗi chuẩn hóa từ Engine.
var (
	ErrUnavailable = errors.New("docker: engine không phản hồi")
	ErrNotFound    = errors.New("docker: không tìm thấy")
	ErrConflict    = errors.New("docker: xung đột trạng thái")
	ErrAuth        = errors.New("docker: xác thực registry thất bại")
)

// Nhãn do agent/compose gắn.
const (
	LabelProject        = "io.itso.project" // uuid project
	LabelService        = "io.itso.service"
	LabelComposeProject = "com.docker.compose.project" // itso_<uuid>
	LabelComposeService = "com.docker.compose.service"
	RollbackRepoPrefix  = "itso-rollback/"
)

// Port là một cổng publish của container.
type Port struct {
	IP          string
	PrivatePort int
	PublicPort  int
	Type        string // tcp | udp
}

// Mount là một mount của container.
type Mount struct {
	Type        string // volume | bind | tmpfs
	Name        string // tên volume (type volume)
	Source      string
	Destination string
}

// Container là một mục của GET /containers/json.
type Container struct {
	ID      string
	Name    string
	Image   string // tham chiếu image khi tạo (Config.Image)
	ImageID string // sha256:…
	State   string // running | exited | paused | restarting | created | dead
	Status  string
	Health  string // healthy | unhealthy | starting | ""
	Labels  map[string]string
	Ports   []Port
	Mounts  []Mount
}

// Detail là kết quả GET /containers/{id}/json (phần agent dùng).
type Detail struct {
	Container
	RestartCount int
	Privileged   bool
}

// Image là một image cục bộ.
type Image struct {
	ID      string
	Tags    []string
	Size    int64
	Created int64 // unix
}

// Volume là một volume.
type Volume struct {
	Name       string
	Driver     string
	Mountpoint string
	Labels     map[string]string
}

// Network là một network.
type Network struct {
	ID         string
	Name       string
	Driver     string
	Internal   bool
	Labels     map[string]string
	Containers int
}

// Stats là số liệu một lần (stream=false).
type Stats struct {
	CPUPct   float64
	MemBytes int64
	MemLimit int64 // 0 = không giới hạn
	Pids     int64
}

// Version là thông tin engine.
type Version struct {
	Version    string
	APIVersion string
}

// Auth là thông tin đăng nhập registry gửi kèm pull (X-Registry-Auth).
type Auth struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	ServerAddress string `json:"serveraddress"`
}

// Engine là tập thao tác agent cần.
type Engine interface {
	Version(ctx context.Context) (Version, error)
	Containers(ctx context.Context, labels map[string]string) ([]Container, error)
	Inspect(ctx context.Context, id string) (Detail, error)
	// Action: start | stop | restart | pause | unpause.
	Action(ctx context.Context, id, action string) error
	Logs(ctx context.Context, id string, tail int) ([]string, bool, error)
	Stats(ctx context.Context, id string) (Stats, error)
	Images(ctx context.Context) ([]Image, error)
	ImageInspect(ctx context.Context, ref string) (Image, error)
	Pull(ctx context.Context, ref string, auth *Auth) error
	Tag(ctx context.Context, id, repo, tag string) error
	RemoveImage(ctx context.Context, ref string) error
	Login(ctx context.Context, auth Auth) error
	Volumes(ctx context.Context) ([]Volume, error)
	VolumeInspect(ctx context.Context, name string) (Volume, error)
	CreateVolume(ctx context.Context, name string, labels map[string]string) error
	RemoveVolume(ctx context.Context, name string) error
	Networks(ctx context.Context) ([]Network, error)
	CreateNetwork(ctx context.Context, name string, internal bool, labels map[string]string) error
	RemoveNetwork(ctx context.Context, name string) error
}

// ComposeProject là tên project compose của một project panel (`-p itso_<uuid>`).
func ComposeProject(uuid string) string { return "itso_" + uuid }

// SplitRef tách tham chiếu image thành repo và tag (mặc định "latest"); digest bị bỏ.
func SplitRef(ref string) (repo, tag string) {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	slash := strings.LastIndex(ref, "/")
	if i := strings.LastIndex(ref, ":"); i > slash {
		return ref[:i], ref[i+1:]
	}
	return ref, "latest"
}

// RegistryHost trả host registry của tham chiếu ("docker.io" khi không có).
func RegistryHost(ref string) string {
	first, _, ok := strings.Cut(ref, "/")
	if !ok || (!strings.ContainsAny(first, ".:") && first != "localhost") {
		return "docker.io"
	}
	return first
}
