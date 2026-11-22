package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Fake là Engine trong bộ nhớ cho sandbox và test: image theo tham chiếu "trên registry" (Publish đổi bản mới),
// container do ComposeUp tạo, volume, network. Không chạy gì thật.
type Fake struct {
	mu         sync.Mutex
	seq        int
	images     map[string]*Image  // id → image
	remote     map[string]string  // repo:tag → id bản đang có trên registry
	containers map[string]*Detail // id → container
	logs       map[string][]string
	volumes    map[string]*Volume
	networks   map[string]*Network
	// Unavailable: mọi lệnh trả ErrUnavailable (docker chưa cài / daemon dừng).
	Unavailable bool
	// Health (tùy chọn): trạng thái health của container mới tạo cho service/image; mặc định "healthy".
	Health func(service, imageID string) string
	// Creds (tùy chọn): registry host → "user:pass" hợp lệ; nil = mọi đăng nhập đều đúng.
	Creds map[string]string
	// MkdirMount (tùy chọn): tạo thư mục mountpoint của volume mới (sandbox).
	MkdirMount func(path string)
	// Pulls ghi lại tham chiếu đã pull (kèm user nếu có auth).
	Pulls []string
}

// NewFake tạo Fake trống với các network hệ thống.
func NewFake() *Fake {
	f := &Fake{images: map[string]*Image{}, remote: map[string]string{}, containers: map[string]*Detail{},
		logs: map[string][]string{}, volumes: map[string]*Volume{}, networks: map[string]*Network{}}
	for n, drv := range map[string]string{"bridge": "bridge", "host": "host", "none": "null"} {
		f.networks[n] = &Network{ID: f.id("net-" + n), Name: n, Driver: drv}
	}
	return f
}

func (f *Fake) id(seed string) string {
	f.seq++
	h := sha256.Sum256([]byte(fmt.Sprintf("%s#%d", seed, f.seq)))
	return hex.EncodeToString(h[:])
}

func normRef(ref string) string {
	repo, tag := SplitRef(ref)
	return repo + ":" + tag
}

func (f *Fake) up() error {
	if f.Unavailable {
		return ErrUnavailable
	}
	return nil
}

// Publish đặt bản mới của ref trên "registry" (lần pull sau sẽ đổi image id). Trả id mới.
func (f *Fake) Publish(ref string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := "sha256:" + f.id("img-"+ref)
	f.remote[normRef(ref)] = id
	return id
}

// Version trả phiên bản giả.
func (f *Fake) Version(context.Context) (Version, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return Version{}, err
	}
	return Version{Version: "26.1.3", APIVersion: "1.45"}, nil
}

func match(labels, want map[string]string) bool {
	for k, v := range want {
		if labels[k] != v {
			return false
		}
	}
	return true
}

func cloneC(d *Detail) Detail {
	c := *d
	c.Labels = map[string]string{}
	for k, v := range d.Labels {
		c.Labels[k] = v
	}
	c.Ports = append([]Port(nil), d.Ports...)
	c.Mounts = append([]Mount(nil), d.Mounts...)
	return c
}

// Containers liệt kê container theo nhãn (sắp theo tên).
func (f *Fake) Containers(_ context.Context, labels map[string]string) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return nil, err
	}
	out := []Container{}
	for _, c := range f.containers {
		if match(c.Labels, labels) {
			cc := cloneC(c)
			cc.Status = map[string]string{"running": "Up 1 minute", "paused": "Up 1 minute (Paused)"}[c.State]
			if cc.Status == "" {
				cc.Status = "Exited (0) 1 minute ago"
			}
			if c.Health != "" && c.State == "running" {
				h := c.Health
				if h == "starting" {
					h = "health: starting"
				}
				cc.Status += " (" + h + ")"
			}
			out = append(out, cc.Container)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *Fake) find(id string) (*Detail, error) {
	if c, ok := f.containers[id]; ok {
		return c, nil
	}
	for k, c := range f.containers {
		if strings.HasPrefix(k, id) && len(id) >= 12 {
			return c, nil
		}
	}
	return nil, fmt.Errorf("%w: container %s", ErrNotFound, id)
}

// Inspect trả chi tiết container.
func (f *Fake) Inspect(_ context.Context, id string) (Detail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return Detail{}, err
	}
	c, err := f.find(id)
	if err != nil {
		return Detail{}, err
	}
	return cloneC(c), nil
}

// Action đổi trạng thái container.
func (f *Fake) Action(_ context.Context, id, action string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	c, err := f.find(id)
	if err != nil {
		return err
	}
	switch action {
	case "start", "restart", "unpause":
		c.State = "running"
	case "stop":
		c.State = "exited"
	case "pause":
		if c.State != "running" {
			return fmt.Errorf("%w: container không chạy", ErrConflict)
		}
		c.State = "paused"
	default:
		return fmt.Errorf("docker: action %q không hỗ trợ", action)
	}
	return nil
}

// Logs trả tail dòng log đã ghi bằng AddLog.
func (f *Fake) Logs(_ context.Context, id string, tail int) ([]string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return nil, false, err
	}
	c, err := f.find(id)
	if err != nil {
		return nil, false, err
	}
	l, cut := SplitLines([]byte(strings.Join(f.logs[c.ID], "\n")), tail)
	return l, cut, nil
}

// AddLog thêm dòng log cho container.
func (f *Fake) AddLog(id string, lines ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs[id] = append(f.logs[id], lines...)
}

// Stats trả số liệu cố định.
func (f *Fake) Stats(_ context.Context, id string) (Stats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return Stats{}, err
	}
	if _, err := f.find(id); err != nil {
		return Stats{}, err
	}
	return Stats{CPUPct: 1.5, MemBytes: 64 << 20, MemLimit: 256 << 20, Pids: 7}, nil
}

// Images liệt kê image (sắp theo id).
func (f *Fake) Images(context.Context) ([]Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return nil, err
	}
	out := []Image{}
	for _, i := range f.images {
		c := *i
		c.Tags = append([]string{}, i.Tags...)
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *Fake) lookup(ref string) *Image {
	if i, ok := f.images[ref]; ok {
		return i
	}
	n := normRef(ref)
	for _, i := range f.images {
		for _, t := range i.Tags {
			if t == n {
				return i
			}
		}
	}
	return nil
}

// ImageInspect tìm image theo id hoặc tag.
func (f *Fake) ImageInspect(_ context.Context, ref string) (Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return Image{}, err
	}
	i := f.lookup(ref)
	if i == nil {
		return Image{}, fmt.Errorf("%w: image %s", ErrNotFound, ref)
	}
	c := *i
	c.Tags = append([]string{}, i.Tags...)
	return c, nil
}

func (f *Fake) untag(tag string) {
	for _, i := range f.images {
		for k, t := range i.Tags {
			if t == tag {
				i.Tags = append(i.Tags[:k:k], i.Tags[k+1:]...)
				break
			}
		}
	}
}

// Pull lấy bản "trên registry" (chưa Publish thì tạo bản đầu tiên) và gắn tag.
func (f *Fake) Pull(_ context.Context, ref string, auth *Auth) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	host := RegistryHost(ref)
	if f.Creds != nil && host != "docker.io" {
		if auth == nil || f.Creds[host] != auth.Username+":"+auth.Password {
			return fmt.Errorf("%w: pull %s", ErrAuth, ref)
		}
	}
	n := normRef(ref)
	id, ok := f.remote[n]
	if !ok {
		id = "sha256:" + f.id("img-"+n)
		f.remote[n] = id
	}
	who := ""
	if auth != nil {
		who = " (" + auth.Username + ")"
	}
	f.Pulls = append(f.Pulls, n+who)
	f.untag(n)
	if i, ok := f.images[id]; ok {
		i.Tags = append(i.Tags, n)
		return nil
	}
	f.images[id] = &Image{ID: id, Tags: []string{n}, Size: 50 << 20, Created: 1763800000 + int64(f.seq)}
	return nil
}

// Tag gắn repo:tag cho image (gỡ tag đó khỏi image khác).
func (f *Fake) Tag(_ context.Context, id, repo, tag string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	i := f.lookup(id)
	if i == nil {
		return fmt.Errorf("%w: image %s", ErrNotFound, id)
	}
	n := repo + ":" + tag
	f.untag(n)
	i.Tags = append(i.Tags, n)
	return nil
}

// RemoveImage xóa tag (ref là tag) hoặc image (ref là id); image đang có container dùng → ErrConflict.
func (f *Fake) RemoveImage(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	i := f.lookup(ref)
	if i == nil {
		return fmt.Errorf("%w: image %s", ErrNotFound, ref)
	}
	if !strings.HasPrefix(ref, "sha256:") && len(i.Tags) > 1 {
		f.untag(normRef(ref))
		return nil
	}
	for _, c := range f.containers {
		if c.ImageID == i.ID {
			return fmt.Errorf("%w: image đang được container %s dùng", ErrConflict, c.ID[:12])
		}
	}
	delete(f.images, i.ID)
	return nil
}

// Login kiểm Creds.
func (f *Fake) Login(_ context.Context, a Auth) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	if f.Creds != nil && f.Creds[a.ServerAddress] != a.Username+":"+a.Password {
		return fmt.Errorf("%w: sai thông tin đăng nhập", ErrAuth)
	}
	return nil
}

// Volumes liệt kê volume.
func (f *Fake) Volumes(context.Context) ([]Volume, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return nil, err
	}
	out := []Volume{}
	for _, v := range f.volumes {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// VolumeInspect trả volume.
func (f *Fake) VolumeInspect(_ context.Context, name string) (Volume, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return Volume{}, err
	}
	v, ok := f.volumes[name]
	if !ok {
		return Volume{}, fmt.Errorf("%w: volume %s", ErrNotFound, name)
	}
	return *v, nil
}

func (f *Fake) createVolume(name string, labels map[string]string) {
	v := &Volume{Name: name, Driver: "local", Mountpoint: "/var/lib/docker/volumes/" + name + "/_data", Labels: labels}
	f.volumes[name] = v
	if f.MkdirMount != nil {
		f.MkdirMount(v.Mountpoint)
	}
}

// CreateVolume tạo volume (đã có → ErrConflict).
func (f *Fake) CreateVolume(_ context.Context, name string, labels map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	if _, ok := f.volumes[name]; ok {
		return fmt.Errorf("%w: volume %s đã có", ErrConflict, name)
	}
	f.createVolume(name, labels)
	return nil
}

func (f *Fake) volumeUsed(name string) bool {
	for _, c := range f.containers {
		for _, m := range c.Mounts {
			if m.Type == "volume" && m.Name == name {
				return true
			}
		}
	}
	return false
}

// RemoveVolume xóa volume (đang được container dùng → ErrConflict).
func (f *Fake) RemoveVolume(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	if _, ok := f.volumes[name]; !ok {
		return fmt.Errorf("%w: volume %s", ErrNotFound, name)
	}
	if f.volumeUsed(name) {
		return fmt.Errorf("%w: volume đang được dùng", ErrConflict)
	}
	delete(f.volumes, name)
	return nil
}

// Networks liệt kê network.
func (f *Fake) Networks(context.Context) ([]Network, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return nil, err
	}
	out := []Network{}
	for _, n := range f.networks {
		c := *n
		c.Containers = 0
		for _, ct := range f.containers {
			if ct.Labels[LabelComposeProject] != "" && n.Name == ct.Labels[LabelComposeProject]+"_default" {
				c.Containers++
			}
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// CreateNetwork tạo network.
func (f *Fake) CreateNetwork(_ context.Context, name string, internal bool, labels map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	if _, ok := f.networks[name]; ok {
		return fmt.Errorf("%w: network %s đã có", ErrConflict, name)
	}
	f.networks[name] = &Network{ID: f.id("net-" + name), Name: name, Driver: "bridge", Internal: internal, Labels: labels}
	return nil
}

// RemoveNetwork xóa network.
func (f *Fake) RemoveNetwork(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	if _, ok := f.networks[name]; !ok {
		return fmt.Errorf("%w: network %s", ErrNotFound, name)
	}
	delete(f.networks, name)
	return nil
}

// ServiceSpec là phần của một service compose mà Fake cần để dựng container.
type ServiceSpec struct {
	Name    string
	Image   string
	Ports   []Port
	Volumes []string // tên volume compose (chưa có tiền tố project)
	Labels  map[string]string
}

// ComposeUp mô phỏng `docker compose up -d` cho các service: pull image còn thiếu, tạo volume/network
// `<project>_<name>`, thay container cũ của service bằng container mới (id mới, health theo Health).
func (f *Fake) ComposeUp(project string, svcs []ServiceSpec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.up(); err != nil {
		return err
	}
	if _, ok := f.networks[project+"_default"]; !ok {
		f.networks[project+"_default"] = &Network{ID: f.id("net-" + project), Name: project + "_default", Driver: "bridge",
			Labels: map[string]string{LabelComposeProject: project}}
	}
	for _, s := range svcs {
		img := f.lookup(s.Image)
		if img == nil {
			n := normRef(s.Image)
			id, ok := f.remote[n]
			if !ok {
				id = "sha256:" + f.id("img-"+n)
				f.remote[n] = id
			}
			img = &Image{ID: id, Tags: []string{n}, Size: 50 << 20, Created: 1763800000}
			f.images[id] = img
		}
		var old *Detail
		for _, c := range f.containers {
			if c.Labels[LabelComposeProject] == project && c.Labels[LabelComposeService] == s.Name {
				old = c
			}
		}
		if old != nil && old.ImageID == img.ID && old.State == "running" {
			continue // không đổi gì: compose giữ container
		}
		if old != nil {
			delete(f.containers, old.ID)
		}
		labels := map[string]string{LabelComposeProject: project, LabelComposeService: s.Name}
		for k, v := range s.Labels {
			labels[k] = v
		}
		health := "healthy"
		if f.Health != nil {
			health = f.Health(s.Name, img.ID)
		}
		c := &Detail{Container: Container{ID: f.id("ct-" + project + s.Name), Name: project + "-" + s.Name + "-1", Image: s.Image,
			ImageID: img.ID, State: "running", Health: health, Labels: labels, Ports: s.Ports}}
		if health == "exited" {
			c.State, c.Health = "exited", ""
		}
		for _, v := range s.Volumes {
			full := project + "_" + v
			if _, ok := f.volumes[full]; !ok {
				f.createVolume(full, map[string]string{LabelComposeProject: project})
			}
			c.Mounts = append(c.Mounts, Mount{Type: "volume", Name: full, Source: f.volumes[full].Mountpoint, Destination: "/data/" + v})
		}
		f.containers[c.ID] = c
	}
	return nil
}

// ComposeDown xóa container của project (không thuộc keep); removeVolumes xóa volume có nhãn project.
// Trả số container đang chạy đã dừng.
func (f *Fake) ComposeDown(project string, keep map[string]bool, removeVolumes bool) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for id, c := range f.containers {
		if c.Labels[LabelComposeProject] == project && !keep[c.Labels[LabelComposeService]] {
			if c.State == "running" {
				n++
			}
			delete(f.containers, id)
		}
	}
	if keep == nil {
		delete(f.networks, project+"_default")
		if removeVolumes {
			for name, v := range f.volumes {
				if v.Labels[LabelComposeProject] == project {
					delete(f.volumes, name)
				}
			}
		}
	}
	return n
}

// AddContainer thêm container tùy ý (test: container không do panel quản lý).
func (f *Fake) AddContainer(d Detail) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := d
	f.containers[c.ID] = &c
}
