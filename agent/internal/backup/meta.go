package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// Meta là nội dung itso-meta.json kèm mỗi snapshot (ADR 0029 §5), lưu thành snapshot phụ gắn tag MetaTag + of:<id8>.
type Meta struct {
	Version      int               `json:"version"`
	Kind         string            `json:"kind"`
	SnapshotID   string            `json:"snapshot_id"`
	PanelVersion string            `json:"panel_version"`
	ServerUUID   string            `json:"server_uuid"`
	AccountUUID  *string           `json:"account_uuid"`
	WebsiteUUID  *string           `json:"website_uuid"`
	SiteDir      *string           `json:"site_dir"`
	Package      *string           `json:"package"`
	Accounts     *int64            `json:"accounts"`
	Databases    []string          `json:"databases"`
	Packages     []string          `json:"packages,omitempty"`
	CreatedAt    string            `json:"created_at"`
	Manifest     map[string]string `json:"manifest"` // RelPath (trong cây snapshot) → sha256
}

// Mẫu manifest: tối đa ManifestFiles file thường ≤ ManifestMaxBytes, duyệt tối đa ManifestMaxWalk mục.
const (
	ManifestFiles    = 200
	ManifestMaxBytes = 64 << 20
	ManifestMaxWalk  = 200000
)

// SampleManifest chọn mẫu file thường dưới root/sub (đường dẫn thật), không theo symlink, bỏ thư mục loại trừ cố
// định, chọn đều theo thứ tự đường dẫn, băm sha256. Khóa là đường dẫn trong cây snapshot (tương đối với root).
// File đổi trong lúc backup sẽ bị bỏ khỏi manifest bằng Recheck sau khi backup xong.
func SampleManifest(root, sub string) map[string]string {
	start := root
	if sub != "" && sub != "." {
		start = filepath.Join(root, sub)
	}
	skip := map[string]bool{}
	for _, e := range FixedExcludes {
		if !strings.ContainsAny(e, "*?") {
			skip[filepath.Join(root, e)] = true
		}
	}
	var files []string
	walked := 0
	_ = filepath.WalkDir(start, func(p string, de fs.DirEntry, err error) error {
		walked++
		if err != nil || walked > ManifestMaxWalk {
			if de != nil && de.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if de.IsDir() && skip[p] {
			return fs.SkipDir
		}
		if de.Type().IsRegular() {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	pick := files
	if len(files) > ManifestFiles {
		pick = make([]string, 0, ManifestFiles)
		step := float64(len(files)) / float64(ManifestFiles)
		for i := 0; i < ManifestFiles; i++ {
			pick = append(pick, files[int(float64(i)*step)])
		}
	}
	out := map[string]string{}
	for _, p := range pick {
		if h, ok := HashFile(p); ok {
			rel, err := filepath.Rel(root, p)
			if err == nil && !strings.HasPrefix(rel, "..") {
				out[filepath.ToSlash(rel)] = h
			}
		}
	}
	return out
}

// Recheck bỏ khỏi manifest các file đã đổi/mất sau khi backup (tránh báo sai khi kiểm chứng).
func Recheck(root string, m map[string]string) {
	for rel, want := range m {
		if h, ok := HashFile(filepath.Join(root, filepath.FromSlash(rel))); !ok || h != want {
			delete(m, rel)
		}
	}
}

// HashFile băm một file thường (O_NOFOLLOW|O_NONBLOCK: không theo symlink, không treo ở FIFO), ≤ ManifestMaxBytes.
func HashFile(p string) (string, bool) {
	fd, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return "", false
	}
	defer fd.Close()
	st, err := fd.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > ManifestMaxBytes {
		return "", false
	}
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(fd, ManifestMaxBytes+1)); err != nil {
		return "", false
	}
	return hex.EncodeToString(h.Sum(nil)), true
}

// HashingWriter băm dữ liệu đi qua (dump DB → restic --stdin).
type HashingWriter struct {
	W io.Writer
	h hashState
	N int64
}

type hashState interface {
	io.Writer
	Sum([]byte) []byte
}

// NewHashingWriter bọc w.
func NewHashingWriter(w io.Writer) *HashingWriter { return &HashingWriter{W: w, h: sha256.New()} }

func (h *HashingWriter) Write(p []byte) (int, error) {
	n, err := h.W.Write(p)
	_, _ = h.h.Write(p[:n])
	h.N += int64(n)
	return n, err
}

// Sum trả sha256 hex.
func (h *HashingWriter) Sum() string { return hex.EncodeToString(h.h.Sum(nil)) }
