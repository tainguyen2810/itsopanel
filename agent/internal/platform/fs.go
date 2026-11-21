package platform

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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
	if fi.Mode().Perm() != mode.Perm() {
		if err := d.Chmod(mode.Perm()); err != nil {
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
