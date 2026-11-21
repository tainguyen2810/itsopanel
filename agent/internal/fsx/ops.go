package fsx

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"sort"
	"time"

	"golang.org/x/sys/unix"
)

func sortStrings(s []string) { sort.Strings(s) }

func unixTime(sec int64) time.Time { return time.Unix(sec, 0) }

// MaxEdit là kích thước tối đa đọc/ghi một lần (editor, khúc tải về).
const MaxEdit = 2 << 20

// ReadResult là kết quả Read.
type ReadResult struct {
	Content    []byte
	SHA256     string
	Truncated  bool
	Size       int64
	FileSHA256 *string
}

// Read đọc tối đa max byte của file thường rel từ offset.
func (r *Root) Read(rel string, offset, max int64) (ReadResult, error) {
	if max <= 0 || max > MaxEdit || offset < 0 {
		return ReadResult{}, fail("invalid_params", "max_bytes/offset không hợp lệ")
	}
	fd, err := r.open(rel, unix.O_RDONLY|unix.O_NOCTTY|unix.O_NONBLOCK, 0)
	if err != nil {
		return ReadResult{}, err
	}
	f := os.NewFile(uintptr(fd), rel)
	defer f.Close()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return ReadResult{}, mapErr(err, rel)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return ReadResult{}, fail("invalid_params", "%s: không phải file thường", rel)
	}
	buf := make([]byte, max)
	n, err := f.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return ReadResult{}, mapErr(err, rel)
	}
	buf = buf[:n]
	sum := sha256.Sum256(buf)
	res := ReadResult{Content: buf, SHA256: hex.EncodeToString(sum[:]), Size: st.Size, Truncated: offset+int64(n) < st.Size}
	if offset == 0 && !res.Truncated {
		s := res.SHA256
		res.FileSHA256 = &s
	}
	return res, nil
}

// Write ghi trọn nội dung file rel (atomic). ifSHA khác sha256 hiện tại → precondition_failed; mode nil → giữ quyền cũ
// (file mới: 0644). Ghi qua symlink: thay symlink bằng file (không ghi vào đích của symlink).
func (r *Root) Write(rel string, content []byte, ifSHA *string, mode *uint32) (string, int64, error) {
	if len(content) > MaxEdit {
		return "", 0, fail("invalid_params", "nội dung quá 2 MiB")
	}
	dfd, base, err := r.parent(rel)
	if err != nil {
		return "", 0, err
	}
	defer unix.Close(dfd)
	perm := uint32(0o644)
	ok, st, err := exists(dfd, base)
	if err != nil {
		return "", 0, mapErr(err, rel)
	}
	if ok {
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			return "", 0, fail("invalid_params", "%s: là thư mục", rel)
		case unix.S_IFREG:
			perm = st.Mode & 0o777
		}
	}
	if ifSHA != nil {
		cur := ""
		if ok && st.Mode&unix.S_IFMT == unix.S_IFREG {
			fd, err := unix.Openat(dfd, base, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
			if err != nil {
				return "", 0, mapErr(err, rel)
			}
			f := os.NewFile(uintptr(fd), base)
			h := sha256.New()
			_, err = io.Copy(h, f)
			_ = f.Close()
			if err != nil {
				return "", 0, mapErr(err, rel)
			}
			cur = hex.EncodeToString(h.Sum(nil))
		}
		if cur != *ifSHA {
			return "", 0, fail("precondition_failed", "%s: file đã bị thay đổi (sha256 khác)", rel)
		}
	}
	if mode != nil {
		perm = *mode & 0o777
	}
	n, err := writeInto(dfd, base, bytes.NewReader(content), int64(len(content)), perm, true, rel)
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:]), n, nil
}

// Mkdir tạo thư mục rel (cha phải tồn tại). Đã có thư mục → created=false.
func (r *Root) Mkdir(rel string, mode uint32) (bool, error) {
	dfd, base, err := r.parent(rel)
	if err != nil {
		return false, err
	}
	defer unix.Close(dfd)
	err = unix.Mkdirat(dfd, base, mode&0o777)
	if errors.Is(err, unix.EEXIST) {
		if ok, st, _ := exists(dfd, base); ok && st.Mode&unix.S_IFMT == unix.S_IFDIR {
			return false, nil
		}
	}
	if err != nil {
		return false, mapErr(err, rel)
	}
	_ = fchmodNoFollow(dfd, base, mode&0o777)
	return true, nil
}

// Rename đổi tên/chuyển from → to (không ghi đè).
func (r *Root) Rename(from, to string) error {
	sfd, sbase, err := r.parent(from)
	if err != nil {
		return err
	}
	defer unix.Close(sfd)
	dfd, dbase, err := r.parent(to)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	return mapErr(unix.Renameat2(sfd, sbase, dfd, dbase, unix.RENAME_NOREPLACE), from)
}

// Move chuyển các đường dẫn vào thư mục target (giữ tên).
func (r *Root) Move(paths []string, target string) (int, error) {
	tfd, err := r.open(target, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return 0, err
	}
	defer unix.Close(tfd)
	n := 0
	for _, p := range paths {
		sfd, base, err := r.parent(p)
		if err != nil {
			return n, err
		}
		err = unix.Renameat2(sfd, base, tfd, base, unix.RENAME_NOREPLACE)
		unix.Close(sfd)
		if err != nil {
			return n, mapErr(err, p)
		}
		n++
	}
	return n, nil
}

// Copy chép các đường dẫn vào thư mục target (đệ quy; symlink chép thành symlink, không đi theo).
func (r *Root) Copy(paths []string, target string) (int, error) {
	tfd, err := r.open(target, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return 0, err
	}
	defer unix.Close(tfd)
	n := 0
	for _, p := range paths {
		sfd, base, err := r.parent(p)
		if err != nil {
			return n, err
		}
		err = copyEntry(sfd, base, tfd, base, 0)
		unix.Close(sfd)
		if err != nil {
			return n, mapErr(err, p)
		}
		n++
	}
	return n, nil
}

const maxDepth = 64

func copyEntry(sfd int, sname string, dfd int, dname string, depth int) error {
	if depth > maxDepth {
		return fail("invalid_params", "thư mục lồng quá sâu")
	}
	ok, st, err := exists(sfd, sname)
	if err != nil {
		return err
	}
	if !ok {
		return unix.ENOENT
	}
	if e, _, _ := exists(dfd, dname); e {
		return unix.EEXIST
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		if err := unix.Mkdirat(dfd, dname, 0o700); err != nil {
			return err
		}
		src, err := unix.Openat(sfd, sname, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		dst, err := unix.Openat(dfd, dname, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			unix.Close(src)
			return err
		}
		defer unix.Close(dst)
		f := os.NewFile(uintptr(src), sname)
		names, err := f.Readdirnames(-1)
		if err != nil {
			f.Close()
			return err
		}
		for _, n := range names {
			if err := copyEntry(src, n, dst, n, depth+1); err != nil {
				f.Close()
				return err
			}
		}
		f.Close()
		return unix.Fchmod(dst, st.Mode&0o777)
	case unix.S_IFREG:
		src, err := unix.Openat(sfd, sname, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		f := os.NewFile(uintptr(src), sname)
		defer f.Close()
		_, err = writeInto(dfd, dname, f, -1, st.Mode&0o777, false, dname)
		return err
	case unix.S_IFLNK:
		buf := make([]byte, 4096)
		k, err := unix.Readlinkat(sfd, sname, buf)
		if err != nil {
			return err
		}
		return unix.Symlinkat(string(buf[:k]), dfd, dname)
	}
	return nil // thiết bị/FIFO/socket: bỏ qua
}

// Delete xóa các đường dẫn (thư mục: đệ quy). Symlink bị xóa là link, không phải đích.
func (r *Root) Delete(paths []string) (int, error) {
	n := 0
	for _, p := range paths {
		dfd, base, err := r.parent(p)
		if err != nil {
			return n, err
		}
		err = removeAll(dfd, base, 0)
		unix.Close(dfd)
		if err != nil {
			return n, mapErr(err, p)
		}
		n++
	}
	return n, nil
}

func removeAll(dfd int, name string, depth int) error {
	if depth > maxDepth {
		return fail("invalid_params", "thư mục lồng quá sâu")
	}
	ok, st, err := exists(dfd, name)
	if err != nil {
		return err
	}
	if !ok {
		return unix.ENOENT
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return unix.Unlinkat(dfd, name, 0)
	}
	fd, err := unix.Openat(dfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	names, err := f.Readdirnames(-1)
	if err != nil {
		f.Close()
		return err
	}
	for _, n := range names {
		if err := removeAll(fd, n, depth+1); err != nil && !errors.Is(err, unix.ENOENT) {
			f.Close()
			return err
		}
	}
	f.Close()
	return unix.Unlinkat(dfd, name, unix.AT_REMOVEDIR)
}

// fchmodNoFollow đổi quyền dfd/name mà không đi theo symlink: mở O_PATH|O_NOFOLLOW rồi chmod qua fd đó.
func fchmodNoFollow(dfd int, name string, mode uint32) error {
	fd, err := unix.Openat(dfd, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return nil // không đổi quyền symlink
	}
	// fchmodat trên fd O_PATH với AT_EMPTY_PATH (Linux ≥ 6.6); kernel cũ: đi qua /proc/self/fd (fd đã cố định đối tượng).
	if err := unix.Fchmodat(fd, "", mode, unix.AT_EMPTY_PATH); err == nil {
		return nil
	}
	return unix.Chmod("/proc/self/fd/"+itoa(fd), mode)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// Chmod đổi quyền (chỉ 0o777, không bao giờ setuid/setgid/sticky). recursive: thư mục con nhận mode cộng bit x nơi có r.
func (r *Root) Chmod(paths []string, mode uint32, recursive bool) (int, error) {
	mode &= 0o777
	n := 0
	for _, p := range paths {
		dfd, base, err := r.parent(p)
		if err != nil {
			return n, err
		}
		c, err := chmodEntry(dfd, base, mode, recursive, 0)
		unix.Close(dfd)
		n += c
		if err != nil {
			return n, mapErr(err, p)
		}
	}
	return n, nil
}

func dirMode(m uint32) uint32 { return m | (m&0o444)>>2 }

func chmodEntry(dfd int, name string, mode uint32, recursive bool, depth int) (int, error) {
	if depth > maxDepth {
		return 0, fail("invalid_params", "thư mục lồng quá sâu")
	}
	ok, st, err := exists(dfd, name)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, unix.ENOENT
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFLNK:
		return 0, nil
	case unix.S_IFDIR:
		m := mode
		if recursive {
			m = dirMode(mode)
		}
		if err := fchmodNoFollow(dfd, name, m); err != nil {
			return 0, err
		}
		if !recursive {
			return 1, nil
		}
		fd, err := unix.Openat(dfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return 1, err
		}
		f := os.NewFile(uintptr(fd), name)
		defer f.Close()
		names, err := f.Readdirnames(-1)
		if err != nil {
			return 1, err
		}
		c := 1
		for _, n := range names {
			k, err := chmodEntry(fd, n, mode, true, depth+1)
			c += k
			if err != nil {
				return c, err
			}
		}
		return c, nil
	default:
		return 1, fchmodNoFollow(dfd, name, mode)
	}
}

// WriteStream ghi src vào file rel (atomic, tối đa limit byte, -1 = không giới hạn). Trả kích thước và sha256.
func (r *Root) WriteStream(rel string, src io.Reader, limit int64, replace bool) (int64, string, error) {
	dfd, base, err := r.parent(rel)
	if err != nil {
		return 0, "", err
	}
	defer unix.Close(dfd)
	if ok, st, _ := exists(dfd, base); ok && st.Mode&unix.S_IFMT == unix.S_IFDIR {
		return 0, "", fail("invalid_params", "%s: là thư mục", rel)
	}
	h := sha256.New()
	n, err := writeInto(dfd, base, io.TeeReader(src, h), limit, 0o640, replace, rel)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

// OpenRead mở file thường rel để đọc tuần tự (import DB, tải về).
func (r *Root) OpenRead(rel string) (*os.File, error) {
	fd, err := r.open(rel, unix.O_RDONLY|unix.O_NOCTTY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return nil, fail("invalid_params", "%s: không phải file thường", rel)
	}
	return os.NewFile(uintptr(fd), rel), nil
}
