package platform

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
)

// Owner là uid:gid mong muốn của một đường dẫn.
type Owner struct{ UID, GID int }

// FS thao tác file hệ thống tính từ gốc Root (máy thật: "/"; test/sandbox: thư mục tạm).
// Khi NoChown (không chạy root), quyền sở hữu mong muốn được ghi vào Owners thay vì chown thật.
type FS struct {
	Root    string
	NoChown bool

	mu     sync.Mutex
	Owners map[string]Owner
}

// NewFS tạo FS với gốc root.
func NewFS(root string, noChown bool) *FS {
	return &FS{Root: root, NoChown: noChown, Owners: map[string]Owner{}}
}

// Path đổi đường dẫn tuyệt đối của hệ thống thành đường dẫn thật dưới Root.
func (f *FS) Path(p string) (string, error) {
	if !strings.HasPrefix(p, "/") || filepath.Clean(p) != p || strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("platform: đường dẫn hệ thống không hợp lệ: %q", p)
	}
	return filepath.Join(f.Root, p), nil
}

// ReadFile đọc file, không theo symlink ở thành phần cuối.
func (f *FS) ReadFile(p string) ([]byte, error) {
	rp, err := f.Path(p)
	if err != nil {
		return nil, err
	}
	fd, err := os.OpenFile(rp, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer fd.Close()
	var b bytes.Buffer
	_, err = b.ReadFrom(fd)
	return b.Bytes(), err
}

// Exists cho biết đường dẫn có tồn tại (không theo symlink).
func (f *FS) Exists(p string) bool {
	rp, err := f.Path(p)
	if err != nil {
		return false
	}
	_, err = os.Lstat(rp)
	return err == nil
}

// WriteAtomic ghi file qua file tạm + fsync + rename. Trả changed=false nếu nội dung, quyền và chủ đã đúng.
func (f *FS) WriteAtomic(p string, data []byte, mode fs.FileMode, owner Owner) (bool, error) {
	rp, err := f.Path(p)
	if err != nil {
		return false, err
	}
	if fi, err := os.Lstat(rp); err == nil {
		if fi.Mode()&fs.ModeSymlink != 0 {
			return false, fmt.Errorf("platform: %s là symlink, từ chối ghi", p)
		}
		if old, err := os.ReadFile(rp); err == nil && bytes.Equal(old, data) && fi.Mode().Perm() == mode.Perm() && f.ownerOK(p, fi, owner) {
			return false, nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(rp), 0o755); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(rp), ".itso-tmp-*")
	if err != nil {
		return false, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Chmod(mode.Perm()); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := f.chownFile(p, tmp, owner); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	return true, os.Rename(tmp.Name(), rp)
}

// EnsureDir tạo thư mục (một cấp, cha phải có) với quyền và chủ đúng; trả changed.
// Thành phần cuối là symlink → lỗi (không bao giờ chown/chmod qua symlink).
func (f *FS) EnsureDir(p string, mode fs.FileMode, owner Owner) (bool, error) {
	rp, err := f.Path(p)
	if err != nil {
		return false, err
	}
	changed := false
	fi, err := os.Lstat(rp)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := os.Mkdir(rp, mode.Perm()); err != nil {
			return false, err
		}
		changed = true
		if fi, err = os.Lstat(rp); err != nil {
			return false, err
		}
	case err != nil:
		return false, err
	case !fi.IsDir():
		return false, fmt.Errorf("platform: %s tồn tại và không phải thư mục", p)
	}
	d, err := os.OpenFile(rp, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY, 0)
	if err != nil {
		return false, err
	}
	defer d.Close()
	// Quyền gồm cả sticky bit (vd. /run/itso/php 1733).
	want := mode & (fs.ModePerm | fs.ModeSticky)
	if fi.Mode()&(fs.ModePerm|fs.ModeSticky) != want {
		if err := d.Chmod(want); err != nil {
			return false, err
		}
		changed = true
	}
	if !f.ownerOK(p, fi, owner) {
		if err := f.chownFile(p, d, owner); err != nil {
			return false, err
		}
		changed = true
	}
	return changed, nil
}

// MkdirAll tạo các thư mục cha (root:root 0755) nếu thiếu.
func (f *FS) MkdirAll(p string) error {
	rp, err := f.Path(p)
	if err != nil {
		return err
	}
	return os.MkdirAll(rp, 0o755)
}

// Remove xóa file (không phải thư mục); trả changed.
func (f *FS) Remove(p string) (bool, error) {
	rp, err := f.Path(p)
	if err != nil {
		return false, err
	}
	err = os.Remove(rp)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	f.mu.Lock()
	delete(f.Owners, p)
	f.mu.Unlock()
	return err == nil, err
}

// OwnerOf trả chủ mong muốn đã ghi (NoChown) hoặc chủ thật.
func (f *FS) OwnerOf(p string) (Owner, bool) {
	if f.NoChown {
		f.mu.Lock()
		defer f.mu.Unlock()
		o, ok := f.Owners[p]
		return o, ok
	}
	rp, err := f.Path(p)
	if err != nil {
		return Owner{}, false
	}
	fi, err := os.Lstat(rp)
	if err != nil {
		return Owner{}, false
	}
	st := fi.Sys().(*syscall.Stat_t)
	return Owner{int(st.Uid), int(st.Gid)}, true
}

func (f *FS) ownerOK(p string, fi fs.FileInfo, want Owner) bool {
	if f.NoChown {
		f.mu.Lock()
		defer f.mu.Unlock()
		got, ok := f.Owners[p]
		return ok && got == want
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == want.UID && int(st.Gid) == want.GID
}

func (f *FS) chownFile(p string, fd *os.File, owner Owner) error {
	if f.NoChown {
		f.mu.Lock()
		f.Owners[p] = owner
		f.mu.Unlock()
		return nil
	}
	return fd.Chown(owner.UID, owner.GID)
}

// Readlink đọc đích symlink (rỗng nếu không phải symlink).
func (f *FS) Readlink(p string) (string, error) {
	rp, err := f.Path(p)
	if err != nil {
		return "", err
	}
	return os.Readlink(rp)
}

// SwapSymlink trỏ link tới target một cách atomic (symlink tạm + rename). target là đường dẫn
// tương đối với thư mục chứa link (không bao giờ ra ngoài Root).
func (f *FS) SwapSymlink(link, target string) (bool, error) {
	if filepath.IsAbs(target) || strings.Contains(target, "..") || strings.ContainsRune(target, 0) {
		return false, fmt.Errorf("platform: đích symlink phải tương đối, không có '..': %q", target)
	}
	if cur, err := f.Readlink(link); err == nil && cur == target {
		return false, nil
	}
	rp, err := f.Path(link)
	if err != nil {
		return false, err
	}
	tmp := filepath.Join(filepath.Dir(rp), ".itso-link-"+filepath.Base(rp))
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, rp)
}

// Rename đổi tên trong cùng Root.
func (f *FS) Rename(from, to string) error {
	a, err := f.Path(from)
	if err != nil {
		return err
	}
	b, err := f.Path(to)
	if err != nil {
		return err
	}
	return os.Rename(a, b)
}

// RemoveTree xóa cây thư mục. Chỉ chấp nhận đường dẫn ≥ 3 cấp (vd. /opt/itso/releases/x) hoặc
// nằm trong danh sách được phép, để lỗi lập trình không thể xóa /, /home, /etc.
func (f *FS) RemoveTree(p string, allowed ...string) error {
	rp, err := f.Path(p)
	if err != nil {
		return err
	}
	ok := strings.Count(p, "/") >= 3
	for _, a := range allowed {
		ok = ok || p == a
	}
	for _, never := range []string{"/", "/home", "/etc", "/var", "/usr", "/opt", "/root"} {
		if p == never {
			ok = false
		}
	}
	if !ok {
		return fmt.Errorf("platform: từ chối xóa cây %q", p)
	}
	return os.RemoveAll(rp)
}

// ReadDir liệt kê tên trong thư mục (đã sắp xếp); thư mục không tồn tại → rỗng. Không theo symlink ở thành phần cuối.
func (f *FS) ReadDir(p string) ([]string, error) {
	rp, err := f.Path(p)
	if err != nil {
		return nil, err
	}
	d, err := os.OpenFile(rp, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_DIRECTORY, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer d.Close()
	names, err := d.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}

// NoSymlinkBelow kiểm mọi thành phần của p nằm dưới base (base không tính) không phải symlink.
// Dùng trước khi root thao tác trong cây do account sở hữu (chặn account đổi thư mục thành symlink).
// Thành phần chưa tồn tại thì dừng kiểm (sẽ được tạo mới bằng Mkdir, không theo symlink).
func (f *FS) NoSymlinkBelow(base, p string) error {
	if p != base && !strings.HasPrefix(p, base+"/") {
		return fmt.Errorf("platform: %s không nằm dưới %s", p, base)
	}
	cur := base
	for _, seg := range strings.Split(strings.TrimPrefix(strings.TrimPrefix(p, base), "/"), "/") {
		if seg == "" {
			continue
		}
		cur += "/" + seg
		rp, err := f.Path(cur)
		if err != nil {
			return err
		}
		fi, err := os.Lstat(rp)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("platform: %s là symlink, từ chối", cur)
		}
	}
	return nil
}

// Tail đọc tối đa n dòng cuối của file (không theo symlink, đọc tối đa maxBytes từ cuối).
// truncated=true khi file còn dòng cũ hơn không được trả.
func (f *FS) Tail(p string, n int, maxBytes int64) ([]string, bool, error) {
	rp, err := f.Path(p)
	if err != nil {
		return nil, false, err
	}
	fd, err := os.OpenFile(rp, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, false, err
	}
	defer fd.Close()
	fi, err := fd.Stat()
	if err != nil {
		return nil, false, err
	}
	if !fi.Mode().IsRegular() {
		return nil, false, fmt.Errorf("platform: %s không phải file thường", p)
	}
	start := int64(0)
	if fi.Size() > maxBytes {
		start = fi.Size() - maxBytes
	}
	buf := make([]byte, fi.Size()-start)
	if _, err := fd.ReadAt(buf, start); err != nil && !errors.Is(err, io.EOF) {
		return nil, false, err
	}
	text := strings.TrimRight(string(buf), "\n")
	if text == "" {
		return []string{}, start > 0, nil
	}
	lines := strings.Split(text, "\n")
	partial := start > 0
	if partial { // dòng đầu bị cắt giữa chừng
		lines = lines[1:]
	}
	truncated := partial
	if len(lines) > n {
		lines, truncated = lines[len(lines)-n:], true
	}
	return lines, truncated, nil
}
