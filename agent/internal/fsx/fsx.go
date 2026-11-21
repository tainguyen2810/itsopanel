// Package fsx là lõi File Manager (D-72, ADR 0019): mọi thao tác file của account đi qua một gốc là fd của
// home, mỗi đường dẫn được kernel resolve bằng openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV),
// nên `..`, symlink trỏ ra ngoài home hay symlink đổi giữa chừng đều không thoát được. Thành phần cuối không đi theo
// symlink khi đổi tên/xóa/chmod. Trên máy thật, package này chỉ chạy trong tiến trình helper đã hạ về uid account
// (xem helper.go); tiến trình root của agent không gọi trực tiếp.
package fsx

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"golang.org/x/sys/unix"
)

// Error là lỗi có mã (khớp mã lỗi agent: path_outside_home, not_found, already_exists, precondition_failed,
// invalid_params, quota_exceeded, internal).
type Error struct {
	Code string `json:"code"`
	Msg  string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

func fail(code, f string, a ...any) error { return &Error{Code: code, Msg: fmt.Sprintf(f, a...)} }

// Code trả mã lỗi của err (internal nếu không rõ).
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "internal"
}

// mapErr đổi errno thành lỗi có mã. what là đường dẫn tương đối (để báo lỗi, không lộ đường dẫn thật).
func mapErr(err error, what string) error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return err
	}
	switch {
	case errors.Is(err, unix.EXDEV), errors.Is(err, unix.ELOOP):
		return fail("path_outside_home", "%s: đường dẫn thoát khỏi home (symlink hoặc mount)", what)
	case errors.Is(err, unix.ENOENT):
		return fail("not_found", "%s: không tồn tại", what)
	case errors.Is(err, unix.EEXIST), errors.Is(err, unix.ENOTEMPTY):
		return fail("already_exists", "%s: đã tồn tại", what)
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
		return fail("precondition_failed", "%s: không có quyền", what)
	case errors.Is(err, unix.ENOTDIR):
		return fail("invalid_params", "%s: không phải thư mục", what)
	case errors.Is(err, unix.EISDIR):
		return fail("invalid_params", "%s: là thư mục", what)
	case errors.Is(err, unix.EDQUOT), errors.Is(err, unix.ENOSPC):
		return fail("quota_exceeded", "%s: hết dung lượng hoặc quota", what)
	case errors.Is(err, unix.EINVAL):
		return fail("invalid_params", "%s: thao tác không hợp lệ", what)
	case errors.Is(err, unix.ENOSYS):
		return fail("precondition_failed", "kernel không hỗ trợ openat2 (cần Linux ≥ 5.6)")
	}
	return fail("internal", "%s: %v", what, err)
}

// resolve là cờ openat2 bắt buộc cho MỌI đường dẫn trong home.
const resolve = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV

// Root là gốc home đã mở.
type Root struct {
	fd int
}

// OpenRoot mở thư mục home (không theo symlink ở chính đường dẫn home).
func OpenRoot(home string) (*Root, error) {
	if !strings.HasPrefix(home, "/") || path.Clean(home) != home {
		return nil, fail("invalid_params", "home không hợp lệ")
	}
	fd, err := unix.Open(home, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, mapErr(err, "home")
	}
	return &Root{fd: fd}, nil
}

// Close đóng fd gốc.
func (r *Root) Close() error { return unix.Close(r.fd) }

// CheckPath kiểm đường dẫn tương đối của File Manager: không tuyệt đối, không `.`/`..`/rỗng giữa chừng,
// không ký tự điều khiển. Cho phép khoảng trắng và ký tự Unicode (tên file thường gặp).
func CheckPath(p string) error {
	if p == "." {
		return nil
	}
	if p == "" || len(p) > 4096 || strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") {
		return fail("invalid_params", "đường dẫn tương đối không hợp lệ")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." || len(seg) > 255 {
			return fail("invalid_params", "đường dẫn có thành phần cấm")
		}
	}
	for _, c := range p {
		if c < 0x20 || c == 0x7f {
			return fail("invalid_params", "đường dẫn có ký tự điều khiển")
		}
	}
	return nil
}

// open mở rel dưới home bằng openat2 (kernel chặn thoát ra ngoài).
func (r *Root) open(rel string, flags int, mode uint32) (int, error) {
	if err := CheckPath(rel); err != nil {
		return -1, err
	}
	fd, err := openBeneath(r.fd, rel, flags, mode)
	return fd, mapErr(err, rel)
}

func openBeneath(dirfd int, rel string, flags int, mode uint32) (int, error) {
	for {
		fd, err := unix.Openat2(dirfd, rel, &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Mode: uint64(mode), Resolve: resolve})
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) { // RESOLVE_BENEATH có thể trả EAGAIN khi có rename đồng thời
			continue
		}
		return fd, err
	}
}

// parent mở thư mục cha của rel (đi theo symlink bên trong home) và trả tên thành phần cuối.
func (r *Root) parent(rel string) (int, string, error) {
	if err := CheckPath(rel); err != nil {
		return -1, "", err
	}
	if rel == "." {
		return -1, "", fail("invalid_params", "không thao tác được trên thư mục gốc home")
	}
	dir, base := path.Split(rel)
	dir = strings.TrimSuffix(dir, "/")
	if dir == "" {
		dir = "."
	}
	fd, err := openBeneath(r.fd, dir, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return -1, "", mapErr(err, dir)
	}
	return fd, base, nil
}

// Entry là một mục trong thư mục.
type Entry struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Size       int64   `json:"size"`
	Mode       string  `json:"mode"`
	ModifiedAt string  `json:"modified_at"`
	Target     *string `json:"target"`
}

func typeOf(m uint32) string {
	switch m & unix.S_IFMT {
	case unix.S_IFREG:
		return "file"
	case unix.S_IFDIR:
		return "dir"
	case unix.S_IFLNK:
		return "symlink"
	}
	return "other"
}

func modeStr(m uint32) string { return fmt.Sprintf("0%03o", m&0o777) }

func mtime(st *unix.Stat_t) string {
	return unixTime(st.Mtim.Sec).UTC().Format("2006-01-02T15:04:05Z")
}

// List liệt kê thư mục rel (tối đa limit mục, sắp theo tên).
func (r *Root) List(rel string, showHidden bool, limit int) ([]Entry, bool, error) {
	fd, err := r.open(rel, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, false, err
	}
	f := os.NewFile(uintptr(fd), rel)
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, false, mapErr(err, rel)
	}
	sortStrings(names)
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	out := []Entry{}
	truncated := false
	for _, n := range names {
		if !showHidden && strings.HasPrefix(n, ".") {
			continue
		}
		if len(out) >= limit {
			truncated = true
			break
		}
		var st unix.Stat_t
		if err := unix.Fstatat(fd, n, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			continue // bị xóa giữa chừng
		}
		e := Entry{Name: n, Type: typeOf(st.Mode), Size: st.Size, Mode: modeStr(st.Mode), ModifiedAt: mtime(&st)}
		if e.Type == "symlink" {
			buf := make([]byte, 4096)
			if k, err := unix.Readlinkat(fd, n, buf); err == nil {
				t := string(buf[:k])
				e.Target = &t
			}
		}
		out = append(out, e)
	}
	return out, truncated, nil
}

// Stat là thông tin một đường dẫn (không theo symlink ở thành phần cuối).
type Stat struct {
	Exists     bool    `json:"exists"`
	Type       *string `json:"type"`
	Size       int64   `json:"size"`
	Mode       *string `json:"mode"`
	ModifiedAt *string `json:"modified_at"`
}

// Stat đọc thông tin rel.
func (r *Root) Stat(rel string) (Stat, error) {
	var st unix.Stat_t
	if rel == "." {
		if err := unix.Fstat(r.fd, &st); err != nil {
			return Stat{}, mapErr(err, rel)
		}
	} else {
		dfd, base, err := r.parent(rel)
		if err != nil {
			if Code(err) == "not_found" {
				return Stat{}, nil
			}
			return Stat{}, err
		}
		defer unix.Close(dfd)
		if err := unix.Fstatat(dfd, base, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			if errors.Is(err, unix.ENOENT) {
				return Stat{}, nil
			}
			return Stat{}, mapErr(err, rel)
		}
	}
	t, m, mt := typeOf(st.Mode), modeStr(st.Mode), mtime(&st)
	return Stat{Exists: true, Type: &t, Size: st.Size, Mode: &m, ModifiedAt: &mt}, nil
}

// randName sinh tên tạm khó đoán trong cùng thư mục.
func randName(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// exists cho biết dfd/name có tồn tại (không theo symlink).
func exists(dfd int, name string) (bool, *unix.Stat_t, error) {
	var st unix.Stat_t
	err := unix.Fstatat(dfd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	return true, &st, nil
}

// writeInto tạo file tạm trong dfd, chép từ src (tối đa limit byte; -1 = không giới hạn), fsync rồi đổi tên thành
// name. replace=false → name đã tồn tại thì lỗi already_exists (RENAME_NOREPLACE). Trả số byte đã ghi.
func writeInto(dfd int, name string, src io.Reader, limit int64, perm uint32, replace bool, what string) (int64, error) {
	tmp := randName(".itso-tmp-")
	fd, err := unix.Openat(dfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, perm&0o777)
	if err != nil {
		return 0, mapErr(err, what)
	}
	f := os.NewFile(uintptr(fd), tmp)
	cleanup := func() { _ = f.Close(); _ = unix.Unlinkat(dfd, tmp, 0) }
	var n int64
	if limit >= 0 {
		n, err = io.Copy(f, io.LimitReader(src, limit+1))
		if err == nil && n > limit {
			cleanup()
			return 0, fail("invalid_params", "%s: nội dung lớn hơn kích thước khai báo", what)
		}
	} else {
		n, err = io.Copy(f, src)
	}
	if err == nil {
		err = unix.Fchmod(fd, perm&0o777) // umask của tiến trình không được làm lệch quyền mong muốn
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		cleanup()
		return 0, mapErr(err, what)
	}
	if err := f.Close(); err != nil {
		_ = unix.Unlinkat(dfd, tmp, 0)
		return 0, mapErr(err, what)
	}
	flags := uint(unix.RENAME_NOREPLACE)
	if replace {
		flags = 0
	}
	if err := unix.Renameat2(dfd, tmp, dfd, name, flags); err != nil {
		_ = unix.Unlinkat(dfd, tmp, 0)
		return 0, mapErr(err, what)
	}
	return n, nil
}
