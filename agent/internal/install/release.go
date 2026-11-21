package install

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"itso.local/agent/internal/platform"
)

// Manifest là manifest.json của một bản phát hành (ký Ed25519, D-65).
type Manifest struct {
	Name           string     `json:"name"`
	Version        string     `json:"version"`
	CreatedAt      string     `json:"created_at"`
	MinFromVersion string     `json:"min_from_version"`
	BreakingDB     bool       `json:"breaking_db"`
	Artifacts      []Artifact `json:"artifacts"`
}

// Artifact là một file của bản phát hành kèm checksum.
type Artifact struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"` // tarball | binary | sbom
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

var reVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`)
var reArtifact = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// Release là bản phát hành đã kiểm chữ ký, nằm trong một thư mục.
type Release struct {
	Dir      string
	Manifest Manifest
	Tarball  Artifact
}

// loadRelease đọc manifest.json + manifest.sig từ dir (đường dẫn thật trên máy, không qua FS gốc),
// kiểm chữ ký Ed25519 và checksum tarball.
func (e *Env) loadRelease(dir string) (*Release, error) {
	if dir == "" {
		return nil, errors.New("thiếu thư mục bản phát hành (--release-dir)")
	}
	if len(e.PubKey) != ed25519.PublicKeySize {
		return nil, errors.New("binary itso không có khóa công khai phát hành (build thiếu -ldflags)")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("đọc manifest: %w", err)
	}
	sig, err := os.ReadFile(filepath.Join(dir, "manifest.sig"))
	if err != nil {
		return nil, fmt.Errorf("đọc chữ ký: %w", err)
	}
	if !ed25519.Verify(e.PubKey, raw, sig) {
		return nil, errors.New("chữ ký manifest KHÔNG hợp lệ: từ chối bản phát hành")
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("manifest sai định dạng: %w", err)
	}
	if !reVersion.MatchString(m.Version) || (m.MinFromVersion != "" && !reVersion.MatchString(m.MinFromVersion)) {
		return nil, fmt.Errorf("phiên bản trong manifest không hợp lệ: %q", m.Version)
	}
	r := &Release{Dir: dir, Manifest: m}
	for _, a := range m.Artifacts {
		if !reArtifact.MatchString(a.Name) {
			return nil, fmt.Errorf("tên artifact không hợp lệ: %q", a.Name)
		}
		if a.Kind == "tarball" {
			r.Tarball = a
		}
	}
	if r.Tarball.Name == "" {
		return nil, errors.New("manifest không có tarball")
	}
	sum, err := fileSHA256(filepath.Join(dir, r.Tarball.Name))
	if err != nil {
		return nil, err
	}
	if sum != r.Tarball.SHA256 {
		return nil, fmt.Errorf("sha256 tarball sai: %s ≠ %s", sum, r.Tarball.SHA256)
	}
	return r, nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p) //nolint:gosec // đường dẫn từ manifest đã kiểm tên
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// CompareVersions so sánh "a.b.c[-pre]": -1, 0, 1. Bản có -pre nhỏ hơn bản không có.
func CompareVersions(a, b string) int {
	split := func(v string) ([3]int, string) {
		core, pre, _ := strings.Cut(v, "-")
		var n [3]int
		for i, p := range strings.SplitN(core, ".", 3) {
			n[i], _ = strconv.Atoi(p)
		}
		return n, pre
	}
	na, pa := split(a)
	nb, pb := split(b)
	for i := 0; i < 3; i++ {
		if na[i] != nb[i] {
			if na[i] < nb[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case pa == pb:
		return 0
	case pa == "":
		return 1
	case pb == "":
		return -1
	case pa < pb:
		return -1
	}
	return 1
}

// extract giải nén tarball vào /opt/itso/releases/<ver>. Từ chối entry tuyệt đối, "..",
// symlink/hardlink trỏ ra ngoài; idempotent (thư mục đã có + checksums khớp → bỏ qua).
func (e *Env) extract(r *Release) (string, error) {
	dest := ReleasesDir + "/" + r.Manifest.Version
	if e.FS.Exists(dest+"/.complete") && e.readFile(dest+"/.complete") == r.Tarball.SHA256+"\n" {
		return dest, nil
	}
	tmp := ReleasesDir + "/.tmp-" + r.Manifest.Version
	if err := e.FS.MkdirAll(ReleasesDir); err != nil {
		return "", err
	}
	_ = e.FS.RemoveTree(tmp)
	f, err := os.Open(filepath.Join(r.Dir, r.Tarball.Name))
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	tr := tar.NewReader(gz)
	root, _ := e.FS.Path(tmp)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("tarball hỏng: %w", err)
		}
		for _, part := range strings.Split(h.Name, "/") {
			if part == ".." {
				return "", fmt.Errorf("tarball có đường dẫn nguy hiểm: %q", h.Name)
			}
		}
		name := path.Clean(h.Name)
		// Bỏ thư mục gốc "itso-<ver>/".
		if i := strings.IndexByte(name, '/'); i >= 0 {
			name = name[i+1:]
		} else {
			continue
		}
		if name == "" || path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") || strings.ContainsRune(name, 0) {
			return "", fmt.Errorf("tarball có đường dẫn nguy hiểm: %q", h.Name)
		}
		target := filepath.Join(root, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			mode := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				mode = 0o755
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode) //nolint:gosec // target dưới root đã kiểm
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(out, io.LimitReader(tr, 2<<30)); err != nil { //nolint:gosec // giới hạn 2 GiB/file
				_ = out.Close()
				return "", err
			}
			if err := out.Close(); err != nil {
				return "", err
			}
		case tar.TypeSymlink:
			// Chỉ symlink tương đối nằm trong release (vendor/bin…).
			resolved := path.Clean(path.Join(path.Dir(name), h.Linkname))
			if path.IsAbs(h.Linkname) || resolved == ".." || strings.HasPrefix(resolved, "../") {
				return "", fmt.Errorf("tarball có symlink ra ngoài: %q → %q", h.Name, h.Linkname)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			if err := os.Symlink(h.Linkname, target); err != nil {
				return "", err
			}
		default:
			return "", fmt.Errorf("tarball có loại entry không cho phép (%c): %q", h.Typeflag, h.Name)
		}
	}
	_ = e.FS.RemoveTree(dest)
	if err := e.FS.Rename(tmp, dest); err != nil {
		return "", err
	}
	if _, err := e.FS.WriteAtomic(dest+"/.complete", []byte(r.Tarball.SHA256+"\n"), 0o644, platform.Owner{}); err != nil {
		return "", err
	}
	return dest, nil
}

// CurrentVersion trả phiên bản đang trỏ bởi /opt/itso/current ("" nếu chưa cài).
func (e *Env) CurrentVersion() string {
	t, err := e.FS.Readlink(CurrentLink)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(t, "releases/")
}

// activate trỏ current tới version.
func (e *Env) activate(version string) error {
	_, err := e.FS.SwapSymlink(CurrentLink, "releases/"+version)
	return err
}

// releases trả các phiên bản đã giải nén, mới nhất trước.
func (e *Env) releases() []string {
	rp, err := e.FS.Path(ReleasesDir)
	if err != nil {
		return nil
	}
	ents, _ := os.ReadDir(rp)
	var vs []string
	for _, d := range ents {
		if d.IsDir() && reVersion.MatchString(d.Name()) {
			vs = append(vs, d.Name())
		}
	}
	sort.Slice(vs, func(i, j int) bool { return CompareVersions(vs[i], vs[j]) > 0 })
	return vs
}

// prune giữ KeepRelease bản mới nhất, không bao giờ xóa bản current và previous.
func (e *Env) prune(st *State) {
	keep := map[string]bool{e.CurrentVersion(): true, st.Previous: true}
	for i, v := range e.releases() {
		if i < KeepRelease || keep[v] {
			continue
		}
		if err := e.FS.RemoveTree(ReleasesDir + "/" + v); err == nil {
			e.printf("  đã xóa bản cũ %s\n", v)
		}
	}
}

var panelUnits = []string{"itso-agent.service", "itso-gateway.service", "itso-web.service", "itso-worker@1.service", "itso-scheduler.timer"}

// healthy kiểm các unit chính đang chạy (lặp HealthTries lần).
func (e *Env) healthy(ctx context.Context) error {
	tries := e.HealthTries
	if tries < 1 {
		tries = 1
	}
	var last error
	for i := 0; i < tries; i++ {
		last = nil
		for _, u := range []string{"itso-agent.service", "itso-web.service"} {
			if r := e.try(ctx, "systemctl", "is-active", u); strings.TrimSpace(string(r.Stdout)) != "active" {
				last = fmt.Errorf("%s không chạy (%s)", u, strings.TrimSpace(string(r.Stdout)))
			}
		}
		if last == nil {
			return nil
		}
		if i+1 < tries {
			select {
			case <-time.After(e.HealthDelay):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return last
}

// artisan chạy lệnh artisan cố định của release hiện tại dưới user itso.
func (e *Env) artisan(ctx context.Context, args ...string) (platform.Result, error) {
	cred, err := e.as("itso")
	if err != nil {
		return platform.Result{}, err
	}
	return e.run(ctx, platform.Cmd{Bin: "frankenphp", Args: append([]string{"php-cli", CurrentLink + "/api/artisan"}, args...), As: cred})
}

// Update cập nhật lên bản trong dir (10 §7). Lỗi sau khi đổi symlink → tự rollback.
func (e *Env) Update(ctx context.Context, dir string) error {
	var st State
	if _, err := e.readJSON(StateFile, &st); err != nil {
		return err
	}
	cur := e.CurrentVersion()
	if cur == "" {
		return errors.New("chưa cài ITSO Panel (chạy itso install)")
	}
	r, err := e.loadRelease(dir)
	if err != nil {
		return err
	}
	nv := r.Manifest.Version
	if CompareVersions(nv, cur) <= 0 {
		return fmt.Errorf("bản %s không mới hơn bản đang chạy %s", nv, cur)
	}
	if r.Manifest.MinFromVersion != "" && CompareVersions(cur, r.Manifest.MinFromVersion) < 0 {
		return fmt.Errorf("bản %s cần cập nhật từ ≥ %s (đang %s)", nv, r.Manifest.MinFromVersion, cur)
	}
	e.printf("Cập nhật %s → %s\n", cur, nv)
	// Sao lưu DB panel + /etc/itso trước khi đổi gì.
	bdir := BackupDir + "/pre-update"
	if err := e.FS.MkdirAll(bdir); err != nil {
		return err
	}
	dump, _ := e.FS.Path(bdir + "/" + cur + ".dump")
	pg, err := e.as("postgres")
	if err != nil {
		return err
	}
	if _, err := e.run(ctx, platform.Cmd{Bin: "pg_dump", Args: []string{"--cluster", "16/itso", "-Fc", "-f", dump, "itso"}, As: pg}); err != nil {
		return fmt.Errorf("sao lưu DB trước cập nhật: %w", err)
	}
	if err := e.copyTree(EtcDir, bdir+"/"+cur+"-etc"); err != nil {
		return err
	}
	if _, err := e.extract(r); err != nil {
		return err
	}
	if _, err := e.artisan(ctx, "down", "--retry=15"); err != nil {
		e.printf("  cảnh báo: không bật được maintenance: %v\n", err)
	}
	fail := func(cause error) error {
		e.printf("  LỖI: %v → rollback về %s\n", cause, cur)
		if err := e.activate(cur); err != nil {
			return fmt.Errorf("%v; rollback lỗi: %w", cause, err)
		}
		_ = e.installUnits(ctx)
		_, _ = e.cmd(ctx, "systemctl", "restart", "itso.target")
		_, _ = e.artisan(ctx, "up")
		return fmt.Errorf("cập nhật thất bại, đã rollback về %s: %w", cur, cause)
	}
	if err := e.activate(nv); err != nil {
		return fail(err)
	}
	if err := e.linkEnv(); err != nil {
		return fail(err)
	}
	if _, err := e.artisan(ctx, "migrate", "--force"); err != nil {
		return fail(err)
	}
	if err := e.installUnits(ctx); err != nil {
		return fail(err)
	}
	if _, err := e.cmd(ctx, "systemctl", "restart", "itso.target"); err != nil {
		return fail(err)
	}
	if err := e.healthy(ctx); err != nil {
		return fail(err)
	}
	if _, err := e.artisan(ctx, "up"); err != nil {
		e.printf("  cảnh báo: artisan up lỗi: %v\n", err)
	}
	st.Previous, st.Version = cur, nv
	if err := e.saveState(&st); err != nil {
		return err
	}
	e.prune(&st)
	e.printf("Đã cập nhật lên %s (bản trước %s giữ để rollback)\n", nv, cur)
	return nil
}

// Rollback trỏ current về bản trước (state.previous) và khởi động lại.
func (e *Env) Rollback(ctx context.Context) error {
	var st State
	if _, err := e.readJSON(StateFile, &st); err != nil {
		return err
	}
	cur := e.CurrentVersion()
	if st.Previous == "" || !e.FS.Exists(ReleasesDir+"/"+st.Previous) {
		return errors.New("không có bản trước để rollback")
	}
	prev := st.Previous
	if err := e.activate(prev); err != nil {
		return err
	}
	if err := e.installUnits(ctx); err != nil {
		return err
	}
	if _, err := e.cmd(ctx, "systemctl", "restart", "itso.target"); err != nil {
		return err
	}
	st.Previous, st.Version = cur, prev
	if err := e.saveState(&st); err != nil {
		return err
	}
	e.printf("Đã rollback %s → %s. Migration chỉ mở rộng (expand-only) nên DB tương thích; nếu bản mới có breaking_db, khôi phục dump trong %s/pre-update.\n", cur, prev, BackupDir)
	return nil
}

// copyTree sao chép file thường của cây src sang dst (giữ quyền, không theo symlink).
func (e *Env) copyTree(src, dst string) error {
	rs, err := e.FS.Path(src)
	if err != nil {
		return err
	}
	return filepath.WalkDir(rs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(rs, p)
		target := dst
		if rel != "." {
			target = dst + "/" + filepath.ToSlash(rel)
		}
		if d.IsDir() {
			return e.FS.MkdirAll(target)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p) //nolint:gosec // dưới /etc/itso
		if err != nil {
			return err
		}
		_, err = e.FS.WriteAtomic(target, b, fi.Mode().Perm()&0o700, platform.Owner{})
		return err
	})
}
