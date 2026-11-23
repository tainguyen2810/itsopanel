package ops

// import.db_dump (Phase 12, D-108): DB MariaDB/MySQL của panel nguồn không thuộc account ITSO nào nên account không
// tự dump được. Root dump qua socket (mariadb-dump --user=root, xác thực unix_socket), luồng đi thẳng vào helper uid
// account (write_stream) → file dump nằm trong home account; panel nạp vào DB mới bằng db.mysql.import dưới uid
// account. Đếm số bảng trong luồng để báo cáo khác biệt. Không có mật khẩu nào trong params.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{contracts.OpImportDBDump: d.importDBDump}
	})
}

// checkImportSourceDB: tên hợp lệ, không phải DB hệ thống, không thuộc account ITSO (tiền tố <user>_ có /home/<user>/.itso).
func (d *Deps) checkImportSourceDB(name string) error {
	if !reDBName.MatchString(name) || reserved[name] {
		return invalidOp(fmt.Sprintf("source_db: tên %q không hợp lệ hoặc là DB hệ thống", name))
	}
	if u, _, ok := strings.Cut(name, "_"); ok && validate.Username(u) == nil && d.FS.Exists(HomeBase+"/"+u+"/.itso") {
		return invalidOp("source_db: DB thuộc account ITSO " + u)
	}
	return nil
}

// limitTee ghi vào w, đếm bảng bằng tableCounter (migrate.go) và chặn khi vượt max byte.
type limitTee struct {
	w   io.Writer
	tc  tableCounter
	n   int64
	max int64
}

func (l *limitTee) Write(p []byte) (int, error) {
	if l.n+int64(len(p)) > l.max {
		l.n += int64(len(p))
		return 0, fmt.Errorf("dump vượt max_bytes")
	}
	_, _ = l.tc.Write(p)
	k, err := l.w.Write(p)
	l.n += int64(k)
	return k, err
}

func (d *Deps) importDBDump(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.ImportDBDumpParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkImportSource(p.Source); err != nil {
		return nil, err
	}
	if err := d.checkImportSourceDB(string(p.SourceDB)); err != nil {
		return nil, err
	}
	if err := validate.RelPath(string(p.Target)); err != nil {
		return nil, opErr(err)
	}
	if p.MaxBytes < 1 || p.MaxBytes > 1<<40 {
		return nil, invalidOp("max_bytes: 1 byte – 1 TiB")
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	st, err := d.streamer()
	if err != nil {
		return nil, err
	}
	// Thư mục chứa file dump (vd .itso-import/) tạo dưới uid account, 0700.
	if dir := path.Dir(string(p.Target)); dir != "." {
		cur := ""
		for _, seg := range strings.Split(dir, "/") {
			cur = path.Join(cur, seg)
			if _, err := d.callFS(ctx, fsReq{acct: p.Account, op: "mkdir", params: map[string]any{"path": cur, "mode": 0o700}}); err != nil {
				return nil, err
			}
		}
	}
	args := []string{"--user=root", "--single-transaction", "--quick", "--routines", "--triggers", "--events", "--no-tablespaces",
		"--skip-definer", string(p.SourceDB)}
	pr, pw := io.Pipe()
	tc := &limitTee{w: pw, max: p.MaxBytes}
	var errb strings.Builder
	type res struct {
		code int
		err  error
	}
	done := make(chan res, 1)
	go func() {
		code, err := st.Stream(ctx, platform.Proc{Bin: "mariadb-dump", Args: args, Stdout: tc, Stderr: &errb})
		_ = pw.Close()
		done <- res{code, err}
	}()
	raw, herr := d.callFS(ctx, fsReq{acct: p.Account, op: "write_stream", stdin: pr,
		params: map[string]any{"target": string(p.Target), "gzip": false, "overwrite": true}})
	_ = pr.Close()
	r := <-done
	cleanup := func() {
		_, _ = d.callFS(ctx, fsReq{acct: p.Account, op: "delete", params: map[string]any{"paths": []string{string(p.Target)}}})
	}
	if tc.n > p.MaxBytes {
		cleanup()
		return nil, &registry.OpError{Code: "quota_exceeded", Message: fmt.Sprintf("dump vượt %d byte (max_bytes)", p.MaxBytes)}
	}
	if herr != nil && (r.err != nil || r.code == 0) {
		return nil, herr
	}
	if r.err != nil || r.code != 0 {
		if herr == nil {
			cleanup()
		}
		if r.err != nil {
			return nil, &registry.OpError{Code: "dependency_unavailable", Message: "mariadb-dump: " + r.err.Error(), Retryable: true}
		}
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("mariadb-dump thoát mã %d: %s", r.code, msg)}
	}
	if herr != nil {
		return nil, herr
	}
	var w struct {
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, opErr(err)
	}
	return toData(contracts.ImportDBDumpResult{Size: contracts.Bytes(w.Size), SHA256: contracts.SHA256(w.SHA256), Tables: int64(func() int { tc.tc.flush(); return tc.tc.n }())})
}
