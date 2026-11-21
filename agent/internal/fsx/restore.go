package fsx

import (
	"archive/tar"
	"errors"
	"io"
	"path"

	"golang.org/x/sys/unix"
)

// Skip là một mục không được khôi phục và lý do (ADR 0032 §2).
type Skip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"` // symlink | device | setuid
}

// RestoreResult là kết quả RestoreTar.
type RestoreResult struct {
	Entries int    `json:"entries"`
	Size    int64  `json:"size"`
	Skipped []Skip `json:"skipped"`
}

const maxSkipReport = 1000

// RestoreTar giải luồng tar (không nén) do agent root dựng từ staging vào thư mục target CHƯA tồn tại, dưới uid
// account (ADR 0032): giải vào thư mục tạm cạnh target rồi đổi tên nguyên tử; chỉ tạo thư mục và file thường;
// symlink/thiết bị/FIFO bị bỏ; bit setuid/setgid/sticky bị bỏ; không bao giờ ghi qua symlink có sẵn (openat2 BENEATH).
func (r *Root) RestoreTar(target string, src io.Reader, maxTotal int64, maxEntries int) (RestoreResult, error) {
	if target == "." || maxTotal <= 0 || maxEntries <= 0 {
		return RestoreResult{}, fail("invalid_params", "đích khôi phục hoặc giới hạn không hợp lệ")
	}
	if err := CheckPath(target); err != nil {
		return RestoreResult{}, err
	}
	if d := path.Dir(target); d != "." {
		if err := (&extractor{root: r}).mkdirs(d); err != nil {
			return RestoreResult{}, err
		}
	}
	dfd, base, err := r.parent(target)
	if err != nil {
		return RestoreResult{}, err
	}
	defer unix.Close(dfd)
	if ok, _, _ := exists(dfd, base); ok {
		return RestoreResult{}, fail("already_exists", "%s: đã tồn tại", target)
	}
	tmp := randName(".itso-restore-")
	if err := unix.Mkdirat(dfd, tmp, 0o700); err != nil {
		return RestoreResult{}, mapErr(err, target)
	}
	done := false
	defer func() {
		if !done {
			_ = removeAll(dfd, tmp, 0)
		}
	}()
	tmpfd, err := openBeneath(dfd, tmp, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return RestoreResult{}, mapErr(err, target)
	}
	x := &extractor{root: &Root{fd: tmpfd}, maxTotal: maxTotal, maxEntries: maxEntries, topLevel: map[string]bool{}}
	defer x.root.Close()
	res := RestoreResult{Skipped: []Skip{}}
	skip := func(name, reason string) {
		if len(res.Skipped) < maxSkipReport {
			res.Skipped = append(res.Skipped, Skip{Path: name, Reason: reason})
		}
	}
	tr := tar.NewReader(src)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return RestoreResult{}, fail("invalid_params", "luồng tar hỏng: %v", err)
		}
		name, err := cleanName(h.Name)
		if err != nil {
			return RestoreResult{}, err
		}
		if name == "" {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := x.count(); err != nil {
				return RestoreResult{}, err
			}
			if err := x.mkdirs(name); err != nil {
				return RestoreResult{}, err
			}
		case tar.TypeReg, tar.TypeRegA: //nolint:staticcheck // TypeRegA: tar cũ
			if h.Mode&0o7000 != 0 {
				skip(name, "setuid") // vẫn khôi phục nội dung, chỉ bỏ bit đặc biệt
			}
			if err := x.file(name, uint32(h.Mode)&0o777, tr, h.Size, 0); err != nil {
				return RestoreResult{}, err
			}
		case tar.TypeSymlink, tar.TypeLink:
			skip(name, "symlink")
		default:
			skip(name, "device")
		}
	}
	if err := unix.Fchmodat(dfd, tmp, 0o755, 0); err != nil {
		return RestoreResult{}, mapErr(err, target)
	}
	if err := unix.Renameat2(dfd, tmp, dfd, base, unix.RENAME_NOREPLACE); err != nil {
		return RestoreResult{}, mapErr(err, target)
	}
	done = true
	res.Entries, res.Size = x.res.Entries, x.res.Size
	return res, nil
}

// Exchange hoán đổi nguyên tử hai đường dẫn đã tồn tại (renameat2 RENAME_EXCHANGE): dùng khi khôi phục ghi đè
// website, bản đang chạy chuyển sang tên của bản khôi phục (ADR 0032 §4).
func (r *Root) Exchange(a, b string) error {
	for _, p := range []string{a, b} {
		if p == "." {
			return fail("invalid_params", "không hoán đổi được gốc home")
		}
		if err := CheckPath(p); err != nil {
			return err
		}
	}
	da, ba, err := r.parent(a)
	if err != nil {
		return err
	}
	defer unix.Close(da)
	db, bb, err := r.parent(b)
	if err != nil {
		return err
	}
	defer unix.Close(db)
	for _, x := range []struct {
		fd   int
		name string
	}{{da, ba}, {db, bb}} {
		ok, st, _ := exists(x.fd, x.name)
		if !ok {
			return fail("not_found", "%s: không tồn tại", x.name)
		}
		if st.Mode&unix.S_IFMT != unix.S_IFDIR {
			return fail("precondition_failed", "%s: không phải thư mục", x.name)
		}
	}
	return mapErr(unix.Renameat2(da, ba, db, bb, unix.RENAME_EXCHANGE), a)
}
