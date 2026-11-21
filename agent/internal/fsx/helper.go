package fsx

import (
	"bufio"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"

	"golang.org/x/sys/unix"
)

// Request là yêu cầu gửi cho helper: một dòng JSON trên stdin. Với op write_stream, phần còn lại của stdin là dữ liệu;
// với op cat, stdout là nội dung file; với op upload_commit, fd 3 là file staging do agent (root) mở sẵn.
type Request struct {
	Op     string          `json:"op"`
	Home   string          `json:"home"`
	Params json.RawMessage `json:"params"`
}

// Response là kết quả của helper (một dòng JSON trên stdout, trừ op cat).
type Response struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error *Error          `json:"error,omitempty"`
}

// Params dùng chung của các op helper.
type Params struct {
	Path       string   `json:"path,omitempty"`
	Paths      []string `json:"paths,omitempty"`
	Target     string   `json:"target,omitempty"`
	From       string   `json:"from,omitempty"`
	To         string   `json:"to,omitempty"`
	ShowHidden bool     `json:"show_hidden,omitempty"`
	Limit      int      `json:"limit,omitempty"`
	Offset     int64    `json:"offset,omitempty"`
	MaxBytes   int64    `json:"max_bytes,omitempty"`
	ContentB64 string   `json:"content_b64,omitempty"`
	IfSHA256   *string  `json:"if_sha256,omitempty"`
	Mode       *uint32  `json:"mode,omitempty"`
	Recursive  bool     `json:"recursive,omitempty"`
	Format     string   `json:"format,omitempty"`
	MaxTotal   int64    `json:"max_total_bytes,omitempty"`
	MaxEntries int      `json:"max_entries,omitempty"`
	Size       int64    `json:"size,omitempty"`
	Overwrite  bool     `json:"overwrite,omitempty"`
	Gzip       bool     `json:"gzip,omitempty"`
}

// Serve thực hiện một yêu cầu trên home đã cho. in là phần dữ liệu còn lại của stdin, out là stdout (op cat),
// extra là file staging (op upload_commit). Dùng chung cho helper thật và chế độ sandbox/test (gọi trong tiến trình).
func Serve(req Request, in io.Reader, out io.Writer, extra *os.File) (any, error) {
	var p Params
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, fail("invalid_params", "params helper: %v", err)
		}
	}
	root, err := OpenRoot(req.Home)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	switch req.Op {
	case "list":
		es, trunc, err := root.List(p.Path, p.ShowHidden, p.Limit)
		return map[string]any{"entries": es, "truncated": trunc}, err
	case "stat":
		return root.Stat(p.Path)
	case "read":
		r, err := root.Read(p.Path, p.Offset, p.MaxBytes)
		if err != nil {
			return nil, err
		}
		return map[string]any{"content_b64": base64.StdEncoding.EncodeToString(r.Content), "sha256": r.SHA256,
			"truncated": r.Truncated, "size": r.Size, "file_sha256": r.FileSHA256}, nil
	case "write":
		b, err := base64.StdEncoding.DecodeString(p.ContentB64)
		if err != nil {
			return nil, fail("invalid_params", "content_b64 không hợp lệ")
		}
		sum, n, err := root.Write(p.Path, b, p.IfSHA256, p.Mode)
		return map[string]any{"sha256": sum, "size": n}, err
	case "mkdir":
		mode := uint32(0o755)
		if p.Mode != nil {
			mode = *p.Mode
		}
		c, err := root.Mkdir(p.Path, mode)
		return map[string]any{"created": c}, err
	case "rename":
		return map[string]any{"renamed": true}, root.Rename(p.From, p.To)
	case "move":
		n, err := root.Move(p.Paths, p.Target)
		return map[string]any{"moved": n}, err
	case "copy":
		n, err := root.Copy(p.Paths, p.Target)
		return map[string]any{"copied": n}, err
	case "delete":
		n, err := root.Delete(p.Paths)
		return map[string]any{"deleted": n}, err
	case "chmod":
		if p.Mode == nil {
			return nil, fail("invalid_params", "thiếu mode")
		}
		n, err := root.Chmod(p.Paths, *p.Mode, p.Recursive)
		return map[string]any{"changed": n}, err
	case "archive":
		n, err := root.Archive(p.Paths, p.Target, p.Format)
		return map[string]any{"size": n}, err
	case "extract":
		return root.Extract(p.Path, p.Target, p.MaxTotal, p.MaxEntries)
	case "upload_commit":
		if extra == nil {
			return nil, fail("invalid_params", "thiếu file staging")
		}
		n, sum, err := root.WriteStream(p.Target, extra, p.Size, p.Overwrite)
		if err == nil && n != p.Size {
			_, _ = root.Delete([]string{p.Target})
			return nil, fail("precondition_failed", "file staging có %d byte, mong đợi %d", n, p.Size)
		}
		return map[string]any{"size": n, "sha256": sum}, err
	case "write_stream": // dump DB: dữ liệu từ stdin, tùy chọn nén gzip
		src := in
		if p.Gzip {
			pr, pw := io.Pipe()
			go func() {
				zw := gzip.NewWriter(pw)
				_, err := io.Copy(zw, in)
				if err == nil {
					err = zw.Close()
				}
				pw.CloseWithError(err)
			}()
			src = pr
		}
		n, sum, err := root.WriteStream(p.Target, src, -1, p.Overwrite)
		return map[string]any{"size": n, "sha256": sum}, err
	case "cat": // import DB: nội dung file (tự giải gzip theo magic) ra stdout
		f, err := root.OpenRead(p.Path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		br := bufio.NewReader(f)
		var src io.Reader = br
		if head, _ := br.Peek(2); len(head) == 2 && head[0] == 0x1f && head[1] == 0x8b {
			zr, err := gzip.NewReader(br)
			if err != nil {
				return nil, fail("invalid_params", "%s: gzip hỏng", p.Path)
			}
			defer zr.Close()
			src = zr
		}
		n, err := io.Copy(out, src)
		if err != nil {
			return nil, fail("internal", "đọc %s: %v", p.Path, err)
		}
		return map[string]any{"bytes": n}, nil
	}
	return nil, fail("invalid_params", "op helper không hỗ trợ: %q", req.Op)
}

var reHome = regexp.MustCompile(`^/home/[a-z][a-z0-9]{2,15}$`)

// HelperMain là điểm vào `itso-agent fs-helper`: chạy dưới uid account (agent đặt Credential), bật no_new_privs,
// từ chối chạy bằng root, chỉ nhận home dạng /home/<username> thuộc đúng uid đang chạy. Trả mã thoát.
func HelperMain(stdin io.Reader, stdout, stderr io.Writer) int {
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fmt.Fprintln(stderr, "fs-helper: no_new_privs:", err)
		return 2
	}
	uid := os.Getuid()
	if uid == 0 || os.Geteuid() == 0 {
		fmt.Fprintln(stderr, "fs-helper: từ chối chạy bằng root")
		return 2
	}
	br := bufio.NewReaderSize(stdin, 64<<10)
	line, err := br.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(stderr, "fs-helper: đọc yêu cầu:", err)
		return 2
	}
	var req Request
	resp := Response{}
	if err := json.Unmarshal(line, &req); err != nil {
		resp.Error = &Error{Code: "invalid_params", Msg: "yêu cầu helper không phải JSON"}
	} else if !reHome.MatchString(req.Home) {
		resp.Error = &Error{Code: "invalid_params", Msg: "home không hợp lệ"}
	} else if err := checkHomeGroup(req.Home, uid); err != nil {
		resp.Error = &Error{Code: Code(err), Msg: err.Error()}
	} else {
		var extra *os.File
		if req.Op == "upload_commit" {
			extra = os.NewFile(3, "staging")
		}
		data, err := Serve(req, br, stdout, extra)
		if err != nil {
			var e *Error
			if !errors.As(err, &e) {
				e = &Error{Code: "internal", Msg: err.Error()}
			}
			resp.Error = e
		} else if req.Op != "cat" {
			resp.OK = true
			resp.Data, _ = json.Marshal(data)
		} else {
			return 0
		}
	}
	if req.Op == "cat" && resp.Error != nil {
		b, _ := json.Marshal(resp)
		fmt.Fprintln(stderr, string(b))
		return 3
	}
	b, _ := json.Marshal(resp)
	fmt.Fprintln(stdout, string(b))
	return 0
}

// checkHomeGroup: home phải có group = uid đang chạy (07 §5: root:<account> 0750) — helper không bao giờ làm việc
// trên home của account khác dù panel/agent truyền sai.
func checkHomeGroup(home string, uid int) error {
	var st unix.Stat_t
	if err := unix.Lstat(home, &st); err != nil {
		return mapErr(err, "home")
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR || int(st.Gid) != os.Getgid() || (int(st.Uid) != 0 && int(st.Uid) != uid) {
		return fail("precondition_failed", "home không thuộc account đang chạy")
	}
	return nil
}
