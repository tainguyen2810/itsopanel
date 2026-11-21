package backup

import (
	"archive/tar"
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"filippo.io/age"
)

// PanelFile là một mục trong tar của backup panel (ADR 0031 §4): tên trong tar → file thật.
type PanelFile struct {
	Name string // tên trong tar, tương đối (vd. itso.dump, etc/itso/env)
	Path string // đường dẫn thật trên máy
}

// PanelFiles liệt kê dump DB panel + cây /etc/itso (chỉ file thường, không theo symlink), sắp xếp ổn định.
func PanelFiles(dumpPath, etcItso string) ([]PanelFile, error) {
	out := []PanelFile{{Name: "itso.dump", Path: dumpPath}}
	err := filepath.WalkDir(etcItso, func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !de.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(etcItso, p)
		if err != nil {
			return err
		}
		// Không chép lại chính khóa SSH backup? Có: cần để đọc đích SFTP sau DR.
		out = append(out, PanelFile{Name: "etc/itso/" + filepath.ToSlash(rel), Path: p})
		return nil
	})
	return out, err
}

// WritePanelArchive ghi tar(files) mã hóa age tới recipient (khóa công khai X25519 của panel) vào w.
// Khóa riêng không bao giờ có trên máy chủ (chỉ trong bộ khôi phục).
func WritePanelArchive(w io.Writer, recipient string, files []PanelFile, now time.Time) error {
	rcpt, err := age.ParseX25519Recipient(recipient)
	if err != nil {
		return &Error{Code: "invalid_params", Msg: "age_recipient không hợp lệ"}
	}
	enc, err := age.Encrypt(w, rcpt)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(enc)
	for _, f := range files {
		if err := addFile(tw, f, now); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return enc.Close()
}

func addFile(tw *tar.Writer, f PanelFile, now time.Time) error {
	fd, err := os.OpenFile(f.Path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer fd.Close()
	st, err := fd.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("%s: không phải file thường", f.Name)
	}
	if err := tw.WriteHeader(&tar.Header{Name: f.Name, Mode: int64(st.Mode().Perm()), Size: st.Size(), ModTime: now,
		Typeflag: tar.TypeReg, Format: tar.FormatPAX}); err != nil {
		return err
	}
	_, err = io.CopyN(tw, fd, st.Size())
	return err
}

// ExtractPanelArchive giải mã age bằng khóa riêng (AGE-SECRET-KEY-1…) và giải tar vào dst (thư mục thật, root 0700):
// chỉ file thường, tên tương đối không `..`, tối đa maxBytes.
func ExtractPanelArchive(r io.Reader, identity, dst string, maxBytes int64) ([]string, error) {
	id, err := age.ParseX25519Identity(strings.TrimSpace(identity))
	if err != nil {
		return nil, &Error{Code: "invalid_params", Msg: "khóa riêng panel không hợp lệ"}
	}
	dec, err := age.Decrypt(r, id)
	if err != nil {
		return nil, &Error{Code: "repo_auth_failed", Msg: "không giải mã được backup panel bằng khóa riêng này"}
	}
	tr := tar.NewReader(bufio.NewReader(dec))
	var names []string
	var total int64
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return names, nil
		}
		if err != nil {
			return nil, &Error{Code: "precondition_failed", Msg: "tar backup panel hỏng: " + err.Error()}
		}
		name := path.Clean(h.Name)
		if h.Typeflag != tar.TypeReg || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "..") || strings.Contains(name, "/../") {
			return nil, &Error{Code: "precondition_failed", Msg: "mục lạ trong backup panel: " + h.Name}
		}
		total += h.Size
		if total > maxBytes {
			return nil, &Error{Code: "precondition_failed", Msg: "backup panel vượt giới hạn kích thước"}
		}
		full := filepath.Join(dst, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return nil, err
		}
		out, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, os.FileMode(h.Mode)&0o600|0o400)
		if err != nil {
			return nil, err
		}
		_, err = io.CopyN(out, tr, h.Size)
		cerr := out.Close()
		if err != nil || cerr != nil {
			return nil, errors.Join(err, cerr)
		}
		names = append(names, name)
	}
}

// Kit là bộ khôi phục dạng văn bản (kitText ở web) mà SA lưu offline; dùng cho `itso backup prune|panel-restore`.
type Kit struct {
	DestName        string
	DestType        string
	DestinationUUID string
	Config          map[string]string
	Repos           []KitRepo
	PublicKey       string
	PrivateKey      string
}

// KitRepo là một repo trong bộ khôi phục.
type KitRepo struct {
	Label, Path, Password string
}

// ParseKit đọc bộ khôi phục. Định dạng:
//
//	destination: <tên> (<loại>)
//	destination_uuid: <uuid>
//	  <khóa>: <giá trị>
//	repositories:
//	- <nhãn>
//	  repo: <đường dẫn>
//	  password: <mật khẩu>
//	panel_public_key: age1…
//	panel_private_key: AGE-SECRET-KEY-1…
func ParseKit(text string) (Kit, error) {
	k := Kit{Config: map[string]string{}}
	inRepos := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		key, val, _ := strings.Cut(t, ":")
		val = strings.TrimSpace(val)
		switch {
		case strings.HasPrefix(line, "destination:"):
			if i := strings.LastIndex(val, " ("); i > 0 && strings.HasSuffix(val, ")") {
				k.DestName, k.DestType = val[:i], val[i+2:len(val)-1]
			}
		case strings.HasPrefix(line, "destination_uuid:"):
			k.DestinationUUID = val
		case strings.HasPrefix(line, "repositories:"):
			inRepos = true
		case strings.HasPrefix(line, "panel_public_key:"):
			k.PublicKey, inRepos = val, false
		case strings.HasPrefix(line, "panel_private_key:"):
			k.PrivateKey, inRepos = val, false
		case inRepos && strings.HasPrefix(t, "- "):
			k.Repos = append(k.Repos, KitRepo{Label: strings.TrimPrefix(t, "- ")})
		case inRepos && len(k.Repos) > 0 && key == "repo":
			k.Repos[len(k.Repos)-1].Path = val
		case inRepos && len(k.Repos) > 0 && key == "password":
			k.Repos[len(k.Repos)-1].Password = val
		case !inRepos && strings.HasPrefix(line, "  "):
			k.Config[key] = val
		}
	}
	if k.DestType == "" || len(k.Repos) == 0 {
		return k, &Error{Code: "invalid_params", Msg: "bộ khôi phục thiếu đích hoặc repo"}
	}
	for _, r := range k.Repos {
		if !reRepoPath.MatchString(r.Path) || len(r.Password) < 16 {
			return k, &Error{Code: "invalid_params", Msg: "repo trong bộ khôi phục không hợp lệ: " + r.Path}
		}
	}
	return k, nil
}
