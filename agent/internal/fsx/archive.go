package fsx

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path"
	"strings"

	"golang.org/x/sys/unix"
)

// MaxRatio là tỉ lệ nén tối đa của một mục (chống zip bomb).
const MaxRatio = 100

// Archive nén các đường dẫn thành file target (zip | tar.gz). Chỉ đưa file thường và thư mục; symlink bỏ qua.
func (r *Root) Archive(paths []string, target, format string) (int64, error) {
	if format != "zip" && format != "tar.gz" {
		return 0, fail("invalid_params", "định dạng nén không hỗ trợ")
	}
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(r.writeArchive(pw, paths, format))
	}()
	n, _, err := r.WriteStream(target, pr, -1, false)
	_ = pr.CloseWithError(err)
	return n, err
}

func (r *Root) writeArchive(w io.Writer, paths []string, format string) error {
	var zw *zip.Writer
	var tw *tar.Writer
	var gz *gzip.Writer
	if format == "zip" {
		zw = zip.NewWriter(w)
	} else {
		gz = gzip.NewWriter(w)
		tw = tar.NewWriter(gz)
	}
	add := func(name string, st *unix.Stat_t, f *os.File) error {
		mod := unixTime(st.Mtim.Sec)
		isDir := st.Mode&unix.S_IFMT == unix.S_IFDIR
		if zw != nil {
			h := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: mod}
			if isDir {
				h.Name += "/"
				h.Method = zip.Store
			}
			h.SetMode(os.FileMode(st.Mode & 0o777))
			if isDir {
				h.SetMode(os.ModeDir | os.FileMode(st.Mode&0o777))
			}
			wr, err := zw.CreateHeader(h)
			if err != nil || f == nil {
				return err
			}
			_, err = io.Copy(wr, f)
			return err
		}
		h := &tar.Header{Name: name, Mode: int64(st.Mode & 0o777), ModTime: mod, Typeflag: tar.TypeReg, Size: st.Size}
		if isDir {
			h.Name += "/"
			h.Typeflag, h.Size = tar.TypeDir, 0
		}
		if err := tw.WriteHeader(h); err != nil || f == nil {
			return err
		}
		_, err := io.CopyN(tw, f, st.Size)
		return err
	}
	var walk func(dfd int, name, arc string, depth int) error
	walk = func(dfd int, name, arc string, depth int) error {
		if depth > maxDepth {
			return fail("invalid_params", "thư mục lồng quá sâu")
		}
		ok, st, err := exists(dfd, name)
		if err != nil || !ok {
			return err
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFREG:
			fd, err := unix.Openat(dfd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
			if err != nil {
				return err
			}
			f := os.NewFile(uintptr(fd), name)
			defer f.Close()
			return add(arc, st, f)
		case unix.S_IFDIR:
			if err := add(arc, st, nil); err != nil {
				return err
			}
			fd, err := unix.Openat(dfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return err
			}
			f := os.NewFile(uintptr(fd), name)
			defer f.Close()
			names, err := f.Readdirnames(-1)
			if err != nil {
				return err
			}
			sortStrings(names)
			for _, n := range names {
				if strings.HasPrefix(n, ".itso-tmp-") {
					continue // file tạm (kể cả chính file nén đang ghi)
				}
				if err := walk(fd, n, arc+"/"+n, depth+1); err != nil {
					return err
				}
			}
		}
		return nil // symlink, thiết bị: bỏ qua
	}
	for _, p := range paths {
		dfd, base, err := r.parent(p)
		if err != nil {
			return err
		}
		err = walk(dfd, base, base, 0)
		unix.Close(dfd)
		if err != nil {
			return mapErr(err, p)
		}
	}
	if zw != nil {
		return zw.Close()
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// ExtractResult là kết quả Extract.
type ExtractResult struct {
	Entries int   `json:"entries"`
	Size    int64 `json:"size"`
	Skipped int   `json:"skipped"`
}

// cleanName chuẩn hóa tên mục trong file nén; tên tuyệt đối, có `..` hay ký tự điều khiển → lỗi (zip slip).
func cleanName(n string) (string, error) {
	n = strings.TrimPrefix(strings.ReplaceAll(n, "\\", "/"), "./")
	n = strings.TrimSuffix(n, "/")
	if n == "" || n == "." {
		return "", nil
	}
	if strings.HasPrefix(n, "/") {
		return "", fail("path_outside_home", "mục nén có đường dẫn tuyệt đối: %q", n)
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return "", fail("path_outside_home", "mục nén thoát thư mục (zip slip): %q", n)
		}
	}
	n = path.Clean(n)
	if err := CheckPath(n); err != nil {
		return "", fail("invalid_params", "tên mục nén không hợp lệ: %q", n)
	}
	return n, nil
}

type extractor struct {
	root          *Root // gốc là thư mục tạm
	maxTotal      int64
	maxEntries    int
	res           ExtractResult
	topLevel      map[string]bool
	topLevelOrder []string
}

func (x *extractor) count() error {
	x.res.Entries++
	if x.res.Entries > x.maxEntries {
		return fail("invalid_params", "file nén có quá %d mục", x.maxEntries)
	}
	return nil
}

func (x *extractor) mkdirs(rel string) error {
	cur := ""
	for _, seg := range strings.Split(rel, "/") {
		if cur == "" {
			cur = seg
		} else {
			cur += "/" + seg
		}
		dfd, base, err := x.root.parent(cur)
		if err != nil {
			return err
		}
		err = unix.Mkdirat(dfd, base, 0o755)
		unix.Close(dfd)
		if err != nil && !errors.Is(err, unix.EEXIST) {
			return mapErr(err, cur)
		}
	}
	return nil
}

func (x *extractor) note(name string) {
	top := strings.SplitN(name, "/", 2)[0]
	if !x.topLevel[top] {
		x.topLevel[top] = true
		x.topLevelOrder = append(x.topLevelOrder, top)
	}
}

func (x *extractor) file(name string, mode uint32, src io.Reader, declared, compressed int64) error {
	if err := x.count(); err != nil {
		return err
	}
	if compressed > 0 && declared/compressed > MaxRatio {
		return fail("invalid_params", "mục %q có tỉ lệ nén %d:1 vượt %d:1 (zip bomb)", name, declared/compressed, MaxRatio)
	}
	x.note(name)
	if d := path.Dir(name); d != "." {
		if err := x.mkdirs(d); err != nil {
			return err
		}
	}
	room := x.maxTotal - x.res.Size
	if room < 0 {
		room = 0
	}
	dfd, base, err := x.root.parent(name)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	// Đếm byte THỰC SỰ giải ra (không tin kích thước khai báo trong header).
	cr := &ratioReader{r: src, compressed: compressed}
	n, err := writeInto(dfd, base, cr, room, mode&0o777, false, name)
	if err != nil {
		if Code(err) == "invalid_params" && strings.Contains(err.Error(), "lớn hơn kích thước") {
			return fail("invalid_params", "file nén giải ra vượt %d byte (zip bomb)", x.maxTotal)
		}
		return err
	}
	if cr.err != nil {
		return cr.err
	}
	x.res.Size += n
	return nil
}

// ratioReader dừng khi số byte giải ra vượt MaxRatio × kích thước nén (khi biết).
type ratioReader struct {
	r          io.Reader
	compressed int64
	n          int64
	err        error
}

func (c *ratioReader) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n += int64(k)
	if c.compressed > 0 && c.n > c.compressed*MaxRatio+1<<20 {
		c.err = fail("invalid_params", "tỉ lệ nén thực tế vượt %d:1 (zip bomb)", MaxRatio)
		return k, c.err
	}
	return k, err
}

// Extract giải nén archive vào thư mục target (tạo nếu chưa có). Giải vào thư mục tạm trong target rồi mới đổi tên
// từng mục cấp cao nhất; trùng tên → already_exists và không thay đổi gì.
func (r *Root) Extract(archive, target string, maxTotal int64, maxEntries int) (ExtractResult, error) {
	if maxTotal <= 0 || maxEntries <= 0 {
		return ExtractResult{}, fail("invalid_params", "giới hạn giải nén không hợp lệ")
	}
	src, err := r.OpenRead(archive)
	if err != nil {
		return ExtractResult{}, err
	}
	defer src.Close()
	if target != "." {
		if _, err := r.Mkdir(target, 0o755); err != nil {
			return ExtractResult{}, err
		}
	}
	tfd, err := r.open(target, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return ExtractResult{}, err
	}
	defer unix.Close(tfd)
	tmp := randName(".itso-extract-")
	if err := unix.Mkdirat(tfd, tmp, 0o700); err != nil {
		return ExtractResult{}, mapErr(err, target)
	}
	defer func() { _ = removeAll(tfd, tmp, 0) }()
	tmpfd, err := openBeneath(tfd, tmp, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return ExtractResult{}, mapErr(err, target)
	}
	x := &extractor{root: &Root{fd: tmpfd}, maxTotal: maxTotal, maxEntries: maxEntries, topLevel: map[string]bool{}}
	defer x.root.Close()

	head := make([]byte, 4)
	if _, err := io.ReadFull(src, head); err != nil {
		return ExtractResult{}, fail("invalid_params", "%s: không phải file nén hỗ trợ", archive)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return ExtractResult{}, mapErr(err, archive)
	}
	switch {
	case bytes.Equal(head, []byte("PK\x03\x04")):
		err = x.zip(src)
	case head[0] == 0x1f && head[1] == 0x8b:
		err = x.tarGz(src)
	default:
		err = fail("invalid_params", "%s: chỉ hỗ trợ .zip và .tar.gz", archive)
	}
	if err != nil {
		return ExtractResult{}, err
	}
	for _, top := range x.topLevelOrder {
		if ok, _, _ := exists(tfd, top); ok {
			return ExtractResult{}, fail("already_exists", "%s/%s: đã tồn tại", target, top)
		}
	}
	for _, top := range x.topLevelOrder {
		if err := unix.Renameat2(tmpfd, top, tfd, top, unix.RENAME_NOREPLACE); err != nil {
			return ExtractResult{}, mapErr(err, top)
		}
	}
	return x.res, nil
}

func (x *extractor) zip(f *os.File) error {
	st, err := f.Stat()
	if err != nil {
		return err
	}
	zr, err := zip.NewReader(f, st.Size())
	if err != nil {
		return fail("invalid_params", "file zip hỏng: %v", err)
	}
	if len(zr.File) > x.maxEntries {
		return fail("invalid_params", "file nén có quá %d mục", x.maxEntries)
	}
	for _, e := range zr.File {
		name, err := cleanName(e.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		m := e.Mode()
		switch {
		case m.IsDir():
			if err := x.count(); err != nil {
				return err
			}
			x.note(name)
			if err := x.mkdirs(name); err != nil {
				return err
			}
		case m.IsRegular():
			rc, err := e.Open()
			if err != nil {
				return fail("invalid_params", "mục zip hỏng: %v", err)
			}
			err = x.file(name, uint32(m.Perm()), rc, int64(e.UncompressedSize64), int64(e.CompressedSize64))
			rc.Close()
			if err != nil {
				return err
			}
		default: // symlink, thiết bị, FIFO
			x.res.Skipped++
		}
	}
	return nil
}

func (x *extractor) tarGz(f *os.File) error {
	gz, err := gzip.NewReader(bufio.NewReader(f))
	if err != nil {
		return fail("invalid_params", "file gzip hỏng: %v", err)
	}
	defer gz.Close()
	st, _ := f.Stat()
	// Tỉ lệ nén của tar.gz đo trên toàn file: tổng giải ra không quá MaxRatio × kích thước file nén.
	if lim := st.Size() * MaxRatio; lim < x.maxTotal && lim > 0 {
		x.maxTotal = lim + 1<<20
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fail("invalid_params", "file tar hỏng: %v", err)
		}
		name, err := cleanName(h.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := x.count(); err != nil {
				return err
			}
			x.note(name)
			if err := x.mkdirs(name); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA: //nolint:staticcheck // TypeRegA: tar cũ
			if err := x.file(name, uint32(h.Mode)&0o777, tr, h.Size, 0); err != nil {
				return err
			}
		default: // symlink, hardlink, thiết bị, FIFO
			x.res.Skipped++
		}
	}
}
