package ops

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// UploadDir là thư mục staging upload do panel (user itso) ghi chunk vào (ADR 0019 §5).
const UploadDir = "/var/lib/itso/uploads"

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpFsList:         d.fsList,
			contracts.OpFsStat:         d.fsStat,
			contracts.OpFsRead:         d.fsRead,
			contracts.OpFsWrite:        d.fsWrite,
			contracts.OpFsMkdir:        d.fsMkdir,
			contracts.OpFsRename:       d.fsRename,
			contracts.OpFsMove:         d.fsMove,
			contracts.OpFsCopy:         d.fsCopy,
			contracts.OpFsDelete:       d.fsDelete,
			contracts.OpFsChmod:        d.fsChmod,
			contracts.OpFsArchive:      d.fsArchive,
			contracts.OpFsExtract:      d.fsExtract,
			contracts.OpFsUploadCommit: d.fsUploadCommit,
		}
	})
}

func (d *Deps) streamer() (platform.Streamer, error) {
	s, ok := d.Run.(platform.Streamer)
	if !ok {
		return nil, &registry.OpError{Code: "internal", Message: "runner không hỗ trợ tiến trình luồng"}
	}
	return s, nil
}

// fsReq là một lời gọi helper File Manager.
type fsReq struct {
	acct   contracts.Account
	op     string
	params map[string]any
	stdin  io.Reader // dữ liệu sau dòng yêu cầu (write_stream)
	stdout io.Writer // op cat: nơi nhận nội dung file
	extra  *os.File  // op upload_commit: file staging
}

// helperCred trả uid/gid của account (đã đối chiếu /etc/passwd) và đường dẫn home thật.
func (d *Deps) helperCred(a contracts.Account) (*platform.Cred, string, error) {
	usr, err := d.lookupAccount(a)
	if err != nil {
		return nil, "", err
	}
	home, err := d.FS.Path(homeOf(a.Username))
	if err != nil {
		return nil, "", opErr(err)
	}
	return &platform.Cred{UID: uint32(usr.UID), GID: uint32(usr.GID)}, home, nil
}

// callFS chạy helper dưới uid account (ADR 0019 §1) và trả data JSON. Tiến trình root không mở file trong home.
func (d *Deps) callFS(ctx context.Context, r fsReq) (json.RawMessage, error) {
	st, err := d.streamer()
	if err != nil {
		return nil, err
	}
	cred, home, err := d.helperCred(r.acct)
	if err != nil {
		return nil, err
	}
	line, err := json.Marshal(map[string]any{"op": r.op, "home": home, "params": r.params})
	if err != nil {
		return nil, opErr(err)
	}
	var in io.Reader = bytes.NewReader(append(line, '\n'))
	if r.stdin != nil {
		in = io.MultiReader(in, r.stdin)
	}
	var out, errb bytes.Buffer
	stdout := io.Writer(&out)
	if fsx.StreamsStdout(r.op) {
		stdout = r.stdout
	}
	p := platform.Proc{Bin: "itso-fs-helper", Args: []string{"fs-helper"}, As: cred, Stdin: in, Stdout: stdout, Stderr: &errb}
	if r.extra != nil {
		p.ExtraFiles = []*os.File{r.extra}
	}
	code, err := st.Stream(ctx, p)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &registry.OpError{Code: "deadline_exceeded", Message: "fs-helper: " + ctx.Err().Error(), Retryable: true}
		}
		return nil, &registry.OpError{Code: "internal", Message: "fs-helper: " + err.Error(), Retryable: true}
	}
	raw := out.Bytes()
	if fsx.StreamsStdout(r.op) {
		if code == 0 {
			return json.RawMessage(`{}`), nil
		}
		raw = errb.Bytes()
	}
	var resp fsx.Response
	if err := json.Unmarshal(bytes.TrimSpace(lastLine(raw)), &resp); err != nil {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &registry.OpError{Code: "internal", Message: fmt.Sprintf("fs-helper thoát mã %d: %s", code, msg), Retryable: true}
	}
	if !resp.OK {
		if resp.Error == nil {
			resp.Error = &fsx.Error{Code: "internal", Msg: "fs-helper lỗi không rõ"}
		}
		return nil, &registry.OpError{Code: resp.Error.Code, Message: resp.Error.Msg}
	}
	return resp.Data, nil
}

func lastLine(b []byte) []byte {
	b = bytes.TrimRight(b, "\n")
	if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
		return b[i+1:]
	}
	return b
}

// fsOp kiểm đường dẫn, gọi helper, chuyển data sang kiểu kết quả của op (qua JSON).
func (d *Deps) fsOp(ctx context.Context, acct contracts.Account, op string, params map[string]any, paths []string, out any) (map[string]any, error) {
	for _, p := range paths {
		if err := fsx.CheckPath(p); err != nil {
			return nil, &registry.OpError{Code: fsx.Code(err), Message: err.Error()}
		}
	}
	raw, err := d.callFS(ctx, fsReq{acct: acct, op: op, params: params})
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return nil, opErr(err)
	}
	return toData(out)
}

func relStrings(ps []contracts.RelPath) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = string(p)
	}
	return out
}

func (d *Deps) fsList(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsListParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	limit := int64(5000)
	if p.Limit != nil {
		limit = *p.Limit
	}
	hidden := p.ShowHidden != nil && *p.ShowHidden
	var out contracts.FsListResult
	return d.fsOp(ctx, p.Account, "list", map[string]any{"path": p.Path, "show_hidden": hidden, "limit": limit},
		[]string{string(p.Path)}, &out)
}

func (d *Deps) fsStat(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsStatParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	var out contracts.FsStatResult
	return d.fsOp(ctx, p.Account, "stat", map[string]any{"path": p.Path}, []string{string(p.Path)}, &out)
}

func (d *Deps) fsRead(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsReadParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	off := int64(0)
	if p.Offset != nil {
		off = *p.Offset
	}
	var out contracts.FsReadResult
	return d.fsOp(ctx, p.Account, "read", map[string]any{"path": p.Path, "offset": off, "max_bytes": p.MaxBytes},
		[]string{string(p.Path)}, &out)
}

func (d *Deps) fsWrite(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsWriteParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	params := map[string]any{"path": p.Path, "content_b64": p.ContentB64, "if_sha256": p.IfSHA256}
	if p.Mode != nil {
		m, err := parseMode(string(*p.Mode))
		if err != nil {
			return nil, err
		}
		params["mode"] = m
	}
	var out contracts.FsWriteResult
	return d.fsOp(ctx, p.Account, "write", params, []string{string(p.Path)}, &out)
}

func parseMode(s string) (uint32, error) {
	var m uint32
	if _, err := fmt.Sscanf(s, "%o", &m); err != nil || m > 0o777 {
		return 0, &registry.OpError{Code: "invalid_params", Message: "mode không hợp lệ (chỉ 0000–0777)"}
	}
	return m, nil
}

func (d *Deps) fsMkdir(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsMkdirParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	m, err := parseMode(string(p.Mode))
	if err != nil {
		return nil, err
	}
	var out contracts.FsMkdirResult
	return d.fsOp(ctx, p.Account, "mkdir", map[string]any{"path": p.Path, "mode": m}, []string{string(p.Path)}, &out)
}

func (d *Deps) fsRename(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsRenameParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	var out contracts.FsRenameResult
	return d.fsOp(ctx, p.Account, "rename", map[string]any{"from": p.From, "to": p.To}, []string{string(p.From), string(p.To)}, &out)
}

func (d *Deps) fsMove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsMoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ps := relStrings(p.Paths)
	var out contracts.FsMoveResult
	return d.fsOp(ctx, p.Account, "move", map[string]any{"paths": ps, "target": p.Target}, append(ps, string(p.Target)), &out)
}

func (d *Deps) fsCopy(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsCopyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ps := relStrings(p.Paths)
	var out contracts.FsCopyResult
	return d.fsOp(ctx, p.Account, "copy", map[string]any{"paths": ps, "target": p.Target}, append(ps, string(p.Target)), &out)
}

func (d *Deps) fsDelete(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsDeleteParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ps := relStrings(p.Paths)
	var out contracts.FsDeleteResult
	return d.fsOp(ctx, p.Account, "delete", map[string]any{"paths": ps}, ps, &out)
}

func (d *Deps) fsChmod(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsChmodParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	m, err := parseMode(string(p.Mode))
	if err != nil {
		return nil, err
	}
	ps := relStrings(p.Paths)
	var out contracts.FsChmodResult
	return d.fsOp(ctx, p.Account, "chmod", map[string]any{"paths": ps, "mode": m, "recursive": p.Recursive}, ps, &out)
}

func (d *Deps) fsArchive(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsArchiveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ps := relStrings(p.Paths)
	var out contracts.FsArchiveResult
	return d.fsOp(ctx, p.Account, "archive", map[string]any{"paths": ps, "target": p.Target, "format": p.Format},
		append(ps, string(p.Target)), &out)
}

func (d *Deps) fsExtract(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsExtractParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	var out contracts.FsExtractResult
	return d.fsOp(ctx, p.Account, "extract", map[string]any{"path": p.Archive, "target": p.Target,
		"max_total_bytes": p.MaxTotalBytes, "max_entries": p.MaxEntries}, []string{string(p.Archive), string(p.Target)}, &out)
}

// fsUploadCommit: agent (root) mở file staging trong thư mục cố định (O_NOFOLLOW, phải là file thường, đúng kích thước)
// rồi chuyển fd cho helper; helper ghi vào home dưới uid account. Thành công thì xóa file staging.
func (d *Deps) fsUploadCommit(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.FsUploadCommitParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := fsx.CheckPath(string(p.Target)); err != nil || p.Target == "." {
		return nil, &registry.OpError{Code: "invalid_params", Message: "target không hợp lệ"}
	}
	staging := UploadDir + "/" + string(p.UploadUUID) + ".part"
	rp, err := d.FS.Path(staging)
	if err != nil {
		return nil, opErr(err)
	}
	f, err := os.OpenFile(rp, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, &registry.OpError{Code: "not_found", Message: "không có file staging của phiên upload"}
		}
		return nil, &registry.OpError{Code: "precondition_failed", Message: "không mở được file staging"}
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != p.Size {
		return nil, &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("file staging phải là file thường %d byte", p.Size)}
	}
	raw, err := d.callFS(ctx, fsReq{acct: p.Account, op: "upload_commit", extra: f,
		params: map[string]any{"target": p.Target, "size": p.Size, "overwrite": p.Overwrite}})
	if err != nil {
		return nil, err
	}
	var out contracts.FsUploadCommitResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, opErr(err)
	}
	_ = os.Remove(rp)
	return toData(out)
}

// SandboxFSHelper chạy helper trong tiến trình (sandbox/test): không đổi uid; home là đường dẫn dưới gốc FS giả.
func SandboxFSHelper(_ context.Context, p platform.Proc) (int, error) {
	br := bufio.NewReader(p.Stdin)
	line, err := br.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return 2, nil
	}
	var req fsx.Request
	if err := json.Unmarshal(line, &req); err != nil {
		return 2, nil
	}
	var extra *os.File
	if len(p.ExtraFiles) > 0 {
		extra = p.ExtraFiles[0]
	}
	data, err := fsx.Serve(req, br, p.Stdout, extra)
	resp := fsx.Response{OK: err == nil}
	if err != nil {
		var e *fsx.Error
		if !errors.As(err, &e) {
			e = &fsx.Error{Code: "internal", Msg: err.Error()}
		}
		resp.Error = e
	} else if fsx.StreamsStdout(req.Op) {
		return 0, nil
	} else {
		resp.Data, _ = json.Marshal(data)
	}
	b, _ := json.Marshal(resp)
	if fsx.StreamsStdout(req.Op) {
		if p.Stderr != nil {
			_, _ = p.Stderr.Write(append(b, '\n'))
		}
		return 3, nil
	}
	_, _ = p.Stdout.Write(append(b, '\n'))
	return 0, nil
}
