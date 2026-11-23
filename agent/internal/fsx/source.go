package fsx

// SourceTar (D-108, ADR 0053 §4): agent (root) đọc docroot của panel nguồn và ghi thành luồng tar cho helper uid
// account giải bằng RestoreTar. Đây là cây KHÔNG thuộc account ITSO nào nên không có gốc home; thay vào đó mọi
// thành phần (cả đường dẫn tới docroot) được mở bằng openat + O_NOFOLLOW từ một fd thư mục cha, nên symlink ở bất
// kỳ đâu (kể cả đổi giữa chừng) không dẫn ra ngoài. Chỉ thư mục và file thường có nlink=1 được chép; symlink,
// hardlink (nlink>1), socket, FIFO, thiết bị bị bỏ qua và đếm lý do. Bit setuid/setgid/sticky bị bỏ.

import (
	"archive/tar"
	"bufio"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// SourceStats là kết quả đọc cây nguồn.
type SourceStats struct {
	Files   int64            `json:"files"`
	Bytes   int64            `json:"bytes"`
	Skipped map[string]int64 `json:"skipped"` // lý do → số mục
}

const sourceMaxDepth = 64

// OpenNoFollow mở thư mục abs (đường dẫn tuyệt đối dưới base) đi từ base, mỗi thành phần bằng openat O_NOFOLLOW.
// base là thư mục gốc tin cậy ("/" trên máy thật, thư mục tạm trong sandbox) và không bị kiểm symlink.
func OpenNoFollow(base, abs string) (int, error) {
	if !strings.HasPrefix(abs, "/") || strings.Contains(abs, "//") {
		return -1, fail("invalid_params", "đường dẫn nguồn không hợp lệ")
	}
	fd, err := unix.Open(base, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, mapErr(err, "gốc")
	}
	for _, seg := range strings.Split(strings.Trim(abs, "/"), "/") {
		if seg == "" || seg == "." || seg == ".." {
			unix.Close(fd)
			return -1, fail("invalid_params", "đường dẫn nguồn có thành phần cấm")
		}
		nfd, err := unix.Openat(fd, seg, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			if err == unix.ELOOP || err == unix.ENOTDIR {
				return -1, fail("precondition_failed", "%s: có symlink hoặc không phải thư mục", abs)
			}
			return -1, mapErr(err, abs)
		}
		fd = nfd
	}
	return fd, nil
}

// SourceTar ghi cây thư mục abs thành tar vào w. Vượt maxBytes → lỗi quota_exceeded; vượt maxEntries → lỗi.
func SourceTar(w io.Writer, base, abs string, maxBytes int64, maxEntries int) (SourceStats, error) {
	st := SourceStats{Skipped: map[string]int64{}}
	if maxBytes <= 0 || maxEntries <= 0 {
		return st, fail("invalid_params", "giới hạn không hợp lệ")
	}
	fd, err := OpenNoFollow(base, abs)
	if err != nil {
		return st, err
	}
	bw := bufio.NewWriterSize(w, 256<<10)
	tw := tar.NewWriter(bw)
	s := &sourceWalk{tw: tw, st: &st, maxBytes: maxBytes, maxEntries: maxEntries}
	err = s.dir(fd, "", 0) // dir đóng fd
	if err != nil {
		return st, err
	}
	if err := tw.Close(); err != nil {
		return st, err
	}
	return st, bw.Flush()
}

type sourceWalk struct {
	tw         *tar.Writer
	st         *SourceStats
	maxBytes   int64
	maxEntries int
	entries    int
}

func (s *sourceWalk) skip(reason string) { s.st.Skipped[reason]++ }

func (s *sourceWalk) count() error {
	s.entries++
	if s.entries > s.maxEntries {
		return fail("quota_exceeded", "nguồn có hơn %d mục", s.maxEntries)
	}
	return nil
}

func (s *sourceWalk) dir(fd int, rel string, depth int) error {
	f := os.NewFile(uintptr(fd), rel)
	defer f.Close()
	if depth > sourceMaxDepth {
		s.skip("depth")
		return nil
	}
	names, err := f.Readdirnames(-1)
	if err != nil {
		return mapErr(err, rel)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := s.count(); err != nil {
			return err
		}
		name := n
		if rel != "" {
			name = rel + "/" + n
		}
		var sb unix.Stat_t
		if err := unix.Fstatat(fd, n, &sb, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			s.skip("unreadable")
			continue
		}
		switch sb.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			cfd, err := unix.Openat(fd, n, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				s.skip("changed")
				continue
			}
			if err := s.tw.WriteHeader(&tar.Header{Name: name + "/", Typeflag: tar.TypeDir, Mode: int64(sb.Mode & 0o777), Format: tar.FormatPAX}); err != nil {
				unix.Close(cfd)
				return err
			}
			if err := s.dir(cfd, name, depth+1); err != nil {
				return err
			}
		case unix.S_IFREG:
			if err := s.file(fd, n, name); err != nil {
				return err
			}
		case unix.S_IFLNK:
			s.skip("symlink")
		case unix.S_IFSOCK:
			s.skip("socket")
		case unix.S_IFIFO:
			s.skip("fifo")
		default:
			s.skip("device")
		}
	}
	return nil
}

func (s *sourceWalk) file(dfd int, n, name string) error {
	ffd, err := unix.Openat(dfd, n, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		s.skip("changed")
		return nil
	}
	f := os.NewFile(uintptr(ffd), name)
	defer f.Close()
	var sb unix.Stat_t
	if err := unix.Fstat(ffd, &sb); err != nil || sb.Mode&unix.S_IFMT != unix.S_IFREG {
		s.skip("changed")
		return nil
	}
	if sb.Nlink > 1 {
		s.skip("hardlink")
		return nil
	}
	if s.st.Bytes+sb.Size > s.maxBytes {
		return fail("quota_exceeded", "nguồn vượt %d byte (max_bytes)", s.maxBytes)
	}
	if err := s.tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: int64(sb.Mode & 0o777), Size: sb.Size,
		ModTime: time.Unix(sb.Mtim.Sec, 0), Format: tar.FormatPAX}); err != nil {
		return err
	}
	// File co lại giữa chừng: đệm 0 cho đủ kích thước đã khai (tar không cho thiếu); lớn lên: chỉ chép phần đã khai.
	n64, err := io.CopyN(s.tw, f, sb.Size)
	if err == io.EOF {
		if _, err := io.CopyN(s.tw, zeroReader{}, sb.Size-n64); err != nil {
			return err
		}
		s.skip("truncated")
	} else if err != nil {
		return err
	}
	s.st.Files++
	s.st.Bytes += sb.Size
	return nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// SourceSize là số liệu cây nguồn cho kế hoạch import (không đọc nội dung file).
type SourceSize struct {
	Files           int64
	Bytes           int64
	SymlinksOutside int64
	Truncated       bool
}

// MeasureSource đếm file thường và byte dưới abs (không theo symlink), đếm symlink trỏ ra ngoài abs.
// Dừng ở maxEntries mục (Truncated=true).
func MeasureSource(base, abs string, maxEntries int) (SourceSize, error) {
	var out SourceSize
	fd, err := OpenNoFollow(base, abs)
	if err != nil {
		return out, err
	}
	n := 0
	var walk func(fd int, dir string, depth int)
	walk = func(fd int, dir string, depth int) {
		f := os.NewFile(uintptr(fd), dir)
		defer f.Close()
		if depth > sourceMaxDepth || out.Truncated {
			return
		}
		names, err := f.Readdirnames(-1)
		if err != nil {
			return
		}
		for _, name := range names {
			if n++; n > maxEntries {
				out.Truncated = true
				return
			}
			var sb unix.Stat_t
			if unix.Fstatat(fd, name, &sb, unix.AT_SYMLINK_NOFOLLOW) != nil {
				continue
			}
			switch sb.Mode & unix.S_IFMT {
			case unix.S_IFDIR:
				if cfd, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0); err == nil {
					walk(cfd, dir+"/"+name, depth+1)
				}
			case unix.S_IFREG:
				if sb.Nlink == 1 {
					out.Files++
					out.Bytes += sb.Size
				}
			case unix.S_IFLNK:
				buf := make([]byte, 4096)
				k, err := unix.Readlinkat(fd, name, buf)
				if err != nil {
					continue
				}
				if !LinkInside(abs, dir, string(buf[:k])) {
					out.SymlinksOutside++
				}
			}
		}
	}
	walk(fd, abs, 0)
	return out, nil
}

// LinkInside cho biết symlink nằm trong thư mục dir (tuyệt đối) với đích target có trỏ vào trong root không
// (chỉ xét chuỗi, không resolve tiếp các symlink trung gian — đủ để cảnh báo, copy vốn bỏ mọi symlink).
func LinkInside(root, dir, target string) bool {
	p := target
	if !strings.HasPrefix(p, "/") {
		p = dir + "/" + p
	}
	p = path.Clean(p)
	return p == root || strings.HasPrefix(p, root+"/")
}
