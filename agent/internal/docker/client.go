package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// APIVersion là phiên bản Engine API agent dùng (Docker 24+, Ubuntu 24.04 docker.io).
const APIVersion = "v1.43"

// DefaultSocket là socket Engine (root:docker 0660; agent chạy root).
const DefaultSocket = "/var/run/docker.sock"

const (
	maxBody = 8 << 20  // phản hồi JSON tối đa
	maxLogs = 16 << 20 // log tối đa đọc một lần
)

// Client nói Engine API qua unix socket.
type Client struct {
	hc   *http.Client
	base string
}

// NewClient tạo client cho socket (chưa kết nối; lỗi kết nối trả ErrUnavailable ở từng lệnh).
func NewClient(socket string) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 10 * time.Minute,
	}
	return &Client{hc: &http.Client{Transport: tr}, base: "http://docker/" + APIVersion}
}

type apiErr struct {
	Message string `json:"message"`
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, body any, hdr map[string]string, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	lr := io.LimitReader(resp.Body, maxBody)
	if resp.StatusCode >= 400 {
		var e apiErr
		_ = json.NewDecoder(lr).Decode(&e)
		return resp.StatusCode, statusErr(resp.StatusCode, e.Message)
	}
	if out != nil && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotModified {
		if w, ok := out.(io.Writer); ok {
			_, err = io.Copy(w, lr)
			return resp.StatusCode, err
		}
		if err := json.NewDecoder(lr).Decode(out); err != nil {
			return resp.StatusCode, fmt.Errorf("docker: phản hồi không đọc được: %w", err)
		}
	} else {
		_, _ = io.Copy(io.Discard, lr)
	}
	return resp.StatusCode, nil
}

func statusErr(code int, msg string) error {
	if len(msg) > 300 {
		msg = msg[:300]
	}
	switch code {
	case http.StatusNotFound:
		return fmt.Errorf("%w: %s", ErrNotFound, msg)
	case http.StatusConflict:
		return fmt.Errorf("%w: %s", ErrConflict, msg)
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: %s", ErrAuth, msg)
	}
	return fmt.Errorf("docker: HTTP %d: %s", code, msg)
}

func labelFilter(labels map[string]string) url.Values {
	q := url.Values{}
	if len(labels) > 0 {
		var l []string
		for k, v := range labels {
			l = append(l, k+"="+v)
		}
		f, _ := json.Marshal(map[string][]string{"label": l})
		q.Set("filters", string(f))
	}
	return q
}

// Version trả phiên bản engine.
func (c *Client) Version(ctx context.Context) (Version, error) {
	var v struct{ Version, ApiVersion string }
	_, err := c.do(ctx, "GET", "/version", nil, nil, nil, &v)
	return Version{Version: v.Version, APIVersion: v.ApiVersion}, err
}

type apiContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
	Ports   []struct {
		IP          string
		PrivatePort int
		PublicPort  int
		Type        string
	} `json:"Ports"`
	Mounts []Mount `json:"Mounts"`
}

// HealthFromStatus đọc "(healthy)" trong Status của danh sách container.
func HealthFromStatus(s string) string {
	for _, h := range []string{"unhealthy", "healthy", "health: starting"} {
		if strings.Contains(s, "("+h+")") {
			return strings.TrimPrefix(h, "health: ")
		}
	}
	return ""
}

// Containers liệt kê mọi container (kể cả đã dừng), lọc theo nhãn.
func (c *Client) Containers(ctx context.Context, labels map[string]string) ([]Container, error) {
	q := labelFilter(labels)
	q.Set("all", "1")
	var raw []apiContainer
	if _, err := c.do(ctx, "GET", "/containers/json", q, nil, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(raw))
	for _, r := range raw {
		name := ""
		if len(r.Names) > 0 {
			name = strings.TrimPrefix(r.Names[0], "/")
		}
		ct := Container{ID: r.ID, Name: name, Image: r.Image, ImageID: r.ImageID, State: r.State, Status: r.Status,
			Health: HealthFromStatus(r.Status), Labels: r.Labels, Mounts: r.Mounts}
		for _, p := range r.Ports {
			ct.Ports = append(ct.Ports, Port{IP: p.IP, PrivatePort: p.PrivatePort, PublicPort: p.PublicPort, Type: p.Type})
		}
		out = append(out, ct)
	}
	return out, nil
}

type apiDetail struct {
	ID           string `json:"Id"`
	Name         string `json:"Name"`
	Image        string `json:"Image"`
	RestartCount int    `json:"RestartCount"`
	Config       struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
		Tty    bool              `json:"Tty"`
	} `json:"Config"`
	State struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	HostConfig struct {
		Privileged bool `json:"Privileged"`
	} `json:"HostConfig"`
	Mounts          []Mount `json:"Mounts"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
	} `json:"NetworkSettings"`
}

func (c *Client) inspect(ctx context.Context, id string) (apiDetail, error) {
	var r apiDetail
	_, err := c.do(ctx, "GET", "/containers/"+url.PathEscape(id)+"/json", nil, nil, nil, &r)
	return r, err
}

// Inspect trả chi tiết container.
func (c *Client) Inspect(ctx context.Context, id string) (Detail, error) {
	r, err := c.inspect(ctx, id)
	if err != nil {
		return Detail{}, err
	}
	d := Detail{Container: Container{ID: r.ID, Name: strings.TrimPrefix(r.Name, "/"), Image: r.Config.Image, ImageID: r.Image,
		State: r.State.Status, Labels: r.Config.Labels, Mounts: r.Mounts}, RestartCount: r.RestartCount, Privileged: r.HostConfig.Privileged}
	if r.State.Health != nil {
		d.Health = r.State.Health.Status
	}
	for k, binds := range r.NetworkSettings.Ports {
		port, proto, _ := strings.Cut(k, "/")
		pp, _ := strconv.Atoi(port)
		for _, b := range binds {
			hp, _ := strconv.Atoi(b.HostPort)
			d.Ports = append(d.Ports, Port{IP: b.HostIP, PrivatePort: pp, PublicPort: hp, Type: proto})
		}
	}
	return d, nil
}

// Action chạy start/stop/restart/pause/unpause.
func (c *Client) Action(ctx context.Context, id, action string) error {
	switch action {
	case "start", "stop", "restart", "pause", "unpause":
	default:
		return fmt.Errorf("docker: action %q không hỗ trợ", action)
	}
	_, err := c.do(ctx, "POST", "/containers/"+url.PathEscape(id)+"/"+action, nil, nil, nil, nil)
	return err
}

// Logs đọc tail dòng log (stdout+stderr); tách khung multiplex khi container không có TTY.
func (c *Client) Logs(ctx context.Context, id string, tail int) ([]string, bool, error) {
	r, err := c.inspect(ctx, id)
	if err != nil {
		return nil, false, err
	}
	q := url.Values{"stdout": {"1"}, "stderr": {"1"}, "tail": {strconv.Itoa(tail)}}
	var buf limitedWriter
	buf.max = maxLogs
	if _, err := c.do(ctx, "GET", "/containers/"+url.PathEscape(id)+"/logs", q, nil, nil, &buf); err != nil {
		return nil, false, err
	}
	data := buf.b.Bytes()
	if !r.Config.Tty {
		data = Demux(data)
	}
	lines, cut := SplitLines(data, tail)
	return lines, cut || buf.cut, nil
}

type limitedWriter struct {
	b   bytes.Buffer
	max int
	cut bool
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if room := w.max - w.b.Len(); room < len(p) {
		w.cut = true
		if room > 0 {
			w.b.Write(p[:room])
		}
		return len(p), nil
	}
	return w.b.Write(p)
}

// Demux bỏ header 8 byte (stream, 0,0,0, size uint32 BE) của luồng log multiplex.
func Demux(b []byte) []byte {
	var out bytes.Buffer
	for len(b) >= 8 {
		n := int(binary.BigEndian.Uint32(b[4:8]))
		b = b[8:]
		if n > len(b) {
			n = len(b)
		}
		out.Write(b[:n])
		b = b[n:]
	}
	return out.Bytes()
}

// SplitLines tách dòng, giữ tối đa max dòng cuối, cắt dòng quá 8192 byte.
func SplitLines(b []byte, max int) ([]string, bool) {
	cut := false
	var lines []string
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), maxLogs)
	for sc.Scan() {
		l := strings.ToValidUTF8(sc.Text(), "?")
		if len(l) > 8192 {
			l, cut = l[:8192], true
			l = strings.ToValidUTF8(l, "")
		}
		lines = append(lines, l)
	}
	if len(lines) > max {
		lines, cut = lines[len(lines)-max:], true
	}
	if lines == nil {
		lines = []string{}
	}
	return lines, cut
}

// Stats đọc số liệu một lần.
func (c *Client) Stats(ctx context.Context, id string) (Stats, error) {
	var r struct {
		CPUStats struct {
			CPUUsage struct {
				TotalUsage uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
			OnlineCPUs  int    `json:"online_cpus"`
		} `json:"cpu_stats"`
		PreCPUStats struct {
			CPUUsage struct {
				TotalUsage uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
			SystemUsage uint64 `json:"system_cpu_usage"`
		} `json:"precpu_stats"`
		MemoryStats struct {
			Usage int64 `json:"usage"`
			Limit int64 `json:"limit"`
			Stats struct {
				InactiveFile int64 `json:"inactive_file"`
			} `json:"stats"`
		} `json:"memory_stats"`
		PidsStats struct {
			Current int64 `json:"current"`
		} `json:"pids_stats"`
	}
	if _, err := c.do(ctx, "GET", "/containers/"+url.PathEscape(id)+"/stats", url.Values{"stream": {"false"}}, nil, nil, &r); err != nil {
		return Stats{}, err
	}
	s := Stats{MemBytes: r.MemoryStats.Usage - r.MemoryStats.Stats.InactiveFile, MemLimit: r.MemoryStats.Limit, Pids: r.PidsStats.Current}
	if s.MemBytes < 0 {
		s.MemBytes = 0
	}
	cpu := float64(r.CPUStats.CPUUsage.TotalUsage) - float64(r.PreCPUStats.CPUUsage.TotalUsage)
	sys := float64(r.CPUStats.SystemUsage) - float64(r.PreCPUStats.SystemUsage)
	if cpu > 0 && sys > 0 {
		n := r.CPUStats.OnlineCPUs
		if n == 0 {
			n = 1
		}
		s.CPUPct = cpu / sys * float64(n) * 100
	}
	return s, nil
}

// Images liệt kê image.
func (c *Client) Images(ctx context.Context) ([]Image, error) {
	var raw []struct {
		ID       string   `json:"Id"`
		RepoTags []string `json:"RepoTags"`
		Size     int64    `json:"Size"`
		Created  int64    `json:"Created"`
	}
	if _, err := c.do(ctx, "GET", "/images/json", nil, nil, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Image, 0, len(raw))
	for _, r := range raw {
		out = append(out, Image{ID: r.ID, Tags: cleanTags(r.RepoTags), Size: r.Size, Created: r.Created})
	}
	return out, nil
}

func cleanTags(t []string) []string {
	out := []string{}
	for _, x := range t {
		if x != "<none>:<none>" {
			out = append(out, x)
		}
	}
	return out
}

// ImageInspect trả image theo tham chiếu hoặc id.
func (c *Client) ImageInspect(ctx context.Context, ref string) (Image, error) {
	var r struct {
		ID       string   `json:"Id"`
		RepoTags []string `json:"RepoTags"`
		Size     int64    `json:"Size"`
		Created  string   `json:"Created"`
	}
	if _, err := c.do(ctx, "GET", "/images/"+ref+"/json", nil, nil, nil, &r); err != nil {
		return Image{}, err
	}
	t, _ := time.Parse(time.RFC3339Nano, r.Created)
	return Image{ID: r.ID, Tags: cleanTags(r.RepoTags), Size: r.Size, Created: t.Unix()}, nil
}

func authHeader(a *Auth) map[string]string {
	if a == nil {
		return nil
	}
	b, _ := json.Marshal(a)
	return map[string]string{"X-Registry-Auth": base64.URLEncoding.EncodeToString(b)}
}

// Pull kéo image; lỗi nằm trong luồng JSON (HTTP 200) nên phải đọc hết.
func (c *Client) Pull(ctx context.Context, ref string, auth *Auth) error {
	repo, tag := SplitRef(ref)
	q := url.Values{"fromImage": {repo}, "tag": {tag}}
	if i := strings.Index(ref, "@"); i >= 0 {
		q.Set("tag", ref[i+1:])
	}
	var buf limitedWriter
	buf.max = maxBody
	if _, err := c.do(ctx, "POST", "/images/create", q, nil, authHeader(auth), &buf); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(buf.b.Bytes()))
	for {
		var m struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return nil // luồng bị cắt ở giới hạn: đã nhận phần lớn tiến trình, kiểm lại bằng ImageInspect
		}
		if m.Error != "" {
			if strings.Contains(m.Error, "unauthorized") || strings.Contains(m.Error, "denied") {
				return fmt.Errorf("%w: %s", ErrAuth, m.Error)
			}
			if strings.Contains(m.Error, "not found") || strings.Contains(m.Error, "manifest unknown") {
				return fmt.Errorf("%w: %s", ErrNotFound, m.Error)
			}
			return fmt.Errorf("docker: pull lỗi: %s", m.Error)
		}
	}
}

// Tag gắn repo:tag cho image.
func (c *Client) Tag(ctx context.Context, id, repo, tag string) error {
	_, err := c.do(ctx, "POST", "/images/"+id+"/tag", url.Values{"repo": {repo}, "tag": {tag}}, nil, nil, nil)
	return err
}

// RemoveImage xóa image (không force: image đang dùng → ErrConflict).
func (c *Client) RemoveImage(ctx context.Context, ref string) error {
	_, err := c.do(ctx, "DELETE", "/images/"+ref, nil, nil, nil, nil)
	return err
}

// Login kiểm thông tin đăng nhập registry (POST /auth); không lưu gì phía engine.
func (c *Client) Login(ctx context.Context, a Auth) error {
	_, err := c.do(ctx, "POST", "/auth", nil, a, nil, nil)
	return err
}

type apiVolume struct {
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Mountpoint string            `json:"Mountpoint"`
	Labels     map[string]string `json:"Labels"`
}

// Volumes liệt kê volume.
func (c *Client) Volumes(ctx context.Context) ([]Volume, error) {
	var r struct{ Volumes []apiVolume }
	if _, err := c.do(ctx, "GET", "/volumes", nil, nil, nil, &r); err != nil {
		return nil, err
	}
	out := make([]Volume, 0, len(r.Volumes))
	for _, v := range r.Volumes {
		out = append(out, Volume(v))
	}
	return out, nil
}

// VolumeInspect trả một volume.
func (c *Client) VolumeInspect(ctx context.Context, name string) (Volume, error) {
	var v apiVolume
	_, err := c.do(ctx, "GET", "/volumes/"+url.PathEscape(name), nil, nil, nil, &v)
	return Volume(v), err
}

// CreateVolume tạo volume driver local.
func (c *Client) CreateVolume(ctx context.Context, name string, labels map[string]string) error {
	_, err := c.do(ctx, "POST", "/volumes/create", nil, map[string]any{"Name": name, "Driver": "local", "Labels": labels}, nil, nil)
	return err
}

// RemoveVolume xóa volume (đang dùng → ErrConflict).
func (c *Client) RemoveVolume(ctx context.Context, name string) error {
	_, err := c.do(ctx, "DELETE", "/volumes/"+url.PathEscape(name), nil, nil, nil, nil)
	return err
}

// Networks liệt kê network (đếm container bằng inspect từng network).
func (c *Client) Networks(ctx context.Context) ([]Network, error) {
	type apiNet struct {
		ID         string            `json:"Id"`
		Name       string            `json:"Name"`
		Driver     string            `json:"Driver"`
		Internal   bool              `json:"Internal"`
		Labels     map[string]string `json:"Labels"`
		Containers map[string]any    `json:"Containers"`
	}
	var raw []apiNet
	if _, err := c.do(ctx, "GET", "/networks", nil, nil, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Network, 0, len(raw))
	for _, n := range raw {
		var full apiNet
		if _, err := c.do(ctx, "GET", "/networks/"+url.PathEscape(n.ID), nil, nil, nil, &full); err == nil {
			n.Containers = full.Containers
		}
		out = append(out, Network{ID: n.ID, Name: n.Name, Driver: n.Driver, Internal: n.Internal, Labels: n.Labels, Containers: len(n.Containers)})
	}
	return out, nil
}

// CreateNetwork tạo network bridge.
func (c *Client) CreateNetwork(ctx context.Context, name string, internal bool, labels map[string]string) error {
	_, err := c.do(ctx, "POST", "/networks/create", nil, map[string]any{"Name": name, "Driver": "bridge", "Internal": internal,
		"Labels": labels, "CheckDuplicate": true}, nil, nil)
	return err
}

// RemoveNetwork xóa network.
func (c *Client) RemoveNetwork(ctx context.Context, name string) error {
	_, err := c.do(ctx, "DELETE", "/networks/"+url.PathEscape(name), nil, nil, nil, nil)
	return err
}
