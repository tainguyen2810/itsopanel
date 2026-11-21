package ops

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"path"

	"itso.local/agent/internal/backup"
	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// FileReadMax giới hạn kích thước file tải lẻ từ snapshot (panel stream theo khúc; file lớn hơn thì khôi phục).
const FileReadMax = 512 << 20

// backupFileRead (backup.file.read): đọc một khúc [offset, offset+max_bytes) của một file thường trong snapshot
// bằng `restic dump` (không giải ra đĩa). Kiểm loại + kích thước bằng `restic ls` trước; symlink/thư mục bị từ chối.
func (d *Deps) backupFileRead(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p struct {
		Repo       backup.RepoParams `json:"repo"`
		SnapshotID string            `json:"snapshot_id"`
		Path       string            `json:"path"`
		Offset     int64             `json:"offset"`
		MaxBytes   int64             `json:"max_bytes"`
	}
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !backup.ValidSnapshotID(p.SnapshotID) {
		return nil, bkInvalid("snapshot_id không hợp lệ")
	}
	if err := checkRelPath(p.Path); err != nil || p.Path == "." {
		return nil, bkInvalid("path phải là một file trong snapshot")
	}
	if p.Offset < 0 || p.MaxBytes < 1 || p.MaxBytes > 2<<20 {
		return nil, bkInvalid("offset/max_bytes ngoài giới hạn")
	}
	r, done, err := d.openRepoRead(env, p.Repo)
	if err != nil {
		return nil, err
	}
	defer done()

	parent := path.Dir(p.Path)
	dir := "/"
	if parent != "." {
		dir = "/" + parent
	}
	pr, pw := io.Pipe()
	type lsRes struct {
		nodes []backup.Node
		err   error
	}
	ch := make(chan lsRes, 1)
	go func() {
		n, _, e := backup.ReadNodes(pr, parent, 100000)
		_, _ = io.Copy(io.Discard, pr)
		ch <- lsRes{n, e}
	}()
	code, _, stderr, err := r.restic(ctx, "", nil, pw, "ls", "--json", p.SnapshotID, dir)
	_ = pw.Close()
	got := <-ch
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, r.fail(code, stderr)
	}
	if got.err != nil {
		return nil, opErr(got.err)
	}
	var node *backup.Node
	for i := range got.nodes {
		if got.nodes[i].Name == path.Base(p.Path) {
			node = &got.nodes[i]
		}
	}
	if node == nil {
		return nil, &registry.OpError{Code: "not_found", Message: "snapshot không có " + p.Path}
	}
	if node.Type != "file" {
		return nil, &registry.OpError{Code: "precondition_failed", Message: p.Path + " không phải file thường"}
	}
	if node.Size > FileReadMax {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "file lớn hơn 512 MiB: hãy khôi phục thay vì tải"}
	}
	size := int64(node.Size)
	if p.Offset >= size {
		return toData(contracts.BackupFileReadResult{ContentB64: "", Size: contracts.Bytes(size), Eof: true})
	}
	want := min(p.MaxBytes, size-p.Offset)
	dctx, cancel := context.WithCancel(ctx)
	defer cancel()
	w := &windowWriter{skip: p.Offset, want: want, cancel: cancel}
	code, _, stderr, err = r.restic(dctx, "", nil, w, "dump", p.SnapshotID, "/"+p.Path)
	if int64(len(w.buf)) < want {
		if err != nil && !errors.Is(err, context.Canceled) {
			return nil, err
		}
		if code != 0 {
			return nil, r.fail(code, stderr)
		}
		return nil, &registry.OpError{Code: "precondition_failed", Message: "file trong snapshot ngắn hơn kích thước ghi nhận"}
	}
	return toData(contracts.BackupFileReadResult{ContentB64: base64.StdEncoding.EncodeToString(w.buf), Size: contracts.Bytes(size),
		Eof: p.Offset+want >= size})
}

// windowWriter giữ đúng khúc [skip, skip+want) rồi hủy restic (không đọc phần còn lại của file).
type windowWriter struct {
	skip, want int64
	buf        []byte
	cancel     func()
}

func (w *windowWriter) Write(b []byte) (int, error) {
	n := len(b)
	if w.skip > 0 {
		if int64(len(b)) <= w.skip {
			w.skip -= int64(len(b))
			return n, nil
		}
		b = b[w.skip:]
		w.skip = 0
	}
	if room := w.want - int64(len(w.buf)); room > 0 {
		if int64(len(b)) > room {
			b = b[:room]
		}
		w.buf = append(w.buf, b...)
	}
	if int64(len(w.buf)) >= w.want {
		w.cancel()
		return n, io.ErrShortWrite
	}
	return n, nil
}
