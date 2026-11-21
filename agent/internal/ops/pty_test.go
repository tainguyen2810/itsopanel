package ops_test

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/policy"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/term"
)

const sess = "01938a25-0001-7000-8000-0000000000aa"

var ptySeq int

func nextSess() string { ptySeq++; return fmt.Sprintf("01938a25-0001-7000-8000-%012x", 0x100+ptySeq) }

func ptyParams(user string, uid int) map[string]any {
	return map[string]any{"account": ct.Acct(user, uid), "session_uuid": nextSess(), "cols": 120, "rows": 32, "idle_timeout_sec": 900}
}

func TestPtyOpen(t *testing.T) {
	e := newEnv(t)
	p := ct.EnsureParams("anphat", 20001)
	p["shell"] = "/bin/bash"
	e.h.OK(contracts.OpAccountEnsure, p)
	e.h.OK(contracts.OpAccountEnsure, ct.EnsureParams("nossh", 20002))

	// Chưa bật socket terminal → dependency_unavailable.
	e.h.Fail(contracts.OpPtyOpen, ptyParams("anphat", 20001), "dependency_unavailable")
	e.d.Term = ops.NewTermManager(e.d, nil)

	d := e.h.OK(contracts.OpPtyOpen, ptyParams("anphat", 20001))
	if !term.ValidTicket(d["ticket"].(string)) || d["unix_user"] != "anphat" {
		t.Fatal(d)
	}
	// Shell nologin (gói không có SSH) → precondition_failed; user không tồn tại → not_found; sai uid → precondition_failed.
	e.h.Fail(contracts.OpPtyOpen, ptyParams("nossh", 20002), "precondition_failed")
	e.h.Fail(contracts.OpPtyOpen, ptyParams("khongco", 20009), "not_found")
	e.h.Fail(contracts.OpPtyOpen, ptyParams("anphat", 20005), "precondition_failed")
	// uid ngoài dải account (root, user hệ thống) bị chặn ở schema/validate trước khi tra passwd.
	for _, bad := range []map[string]any{ptyParams("root", 0), ptyParams("ubuntu", 1000)} {
		if res := e.h.Call(contracts.OpPtyOpen, bad); res.OK {
			t.Fatalf("uid ngoài dải phải bị từ chối: %v", bad)
		}
	}
	// Tối đa 2 phiên (đang chờ + đang mở) mỗi account.
	e.h.OK(contracts.OpPtyOpen, ptyParams("anphat", 20001))
	e.h.Fail(contracts.OpPtyOpen, ptyParams("anphat", 20001), "quota_exceeded")
}

func TestTermArgvGolden(t *testing.T) {
	s := &term.Session{UUID: sess, User: "anphat", UID: 20001, GID: 20001, Cols: 120, Rows: 32}
	argv, err := ops.TermArgv(s)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "pty.systemd-run.argv", strings.Join(argv, "\n")+"\n")
	for _, bad := range []*term.Session{{UUID: sess, User: "root", UID: 0, GID: 0}, {UUID: sess, User: "ubuntu", UID: 1000, GID: 1000},
		{UUID: "../x", User: "anphat", UID: 20001, GID: 20001}, {UUID: sess, User: "a b", UID: 20001, GID: 20001}} {
		if _, err := ops.TermArgv(bad); err == nil {
			t.Fatalf("phải từ chối %+v", bad)
		}
	}
	if ops.TermUnit(s) != "itso-term-"+sess+".service" {
		t.Fatal(ops.TermUnit(s))
	}
}

func rootParams() map[string]any {
	return map[string]any{"session_uuid": nextSess(), "cols": 100, "rows": 30, "idle_timeout_sec": 900}
}

// Root bị từ chối khi policy tắt dù panel yêu cầu: handler tự kiểm (op_disabled) và registry chặn theo policy.
func TestPtyOpenRootPolicy(t *testing.T) {
	e := newEnv(t)
	e.d.Term = ops.NewTermManager(e.d, nil)
	e.h.Fail(contracts.OpPtyOpenRoot, rootParams(), "op_disabled")
	pol := e.h.OK(contracts.OpPtyPolicy, map[string]any{})
	if pol["root_enabled"] != false || pol["record_root"] != true || pol["record_user"] != false {
		t.Fatal(pol)
	}

	// Registry thật dùng policy cục bộ: mặc định root_terminal=false → op_disabled trước khi tới handler,
	// kể cả khi Deps bị cấu hình sai RootTerminal=true.
	p, err := policy.Default()
	if err != nil {
		t.Fatal(err)
	}
	e.d.RootTerminal = true
	r := registry.New(ops.Version)
	r.SetAllow(p.Enabled)
	if err := ops.Register(r, e.d); err != nil {
		t.Fatal(err)
	}
	ct.New(t, r).Fail(contracts.OpPtyOpenRoot, rootParams(), "op_disabled")
	if err := p.Set("terminal.root", true); err != nil || !p.RootTerminal() {
		t.Fatal("bật bằng CLI phải mở được", err)
	}
	// ops.pty.open.root=false vẫn thắng cờ root_terminal.
	_ = p.Set("ops.pty.open.root", false)
	if p.RootTerminal() {
		t.Fatal("ops.pty.open.root=false phải tắt root")
	}

	e.d.RecordUser = true
	d := e.h.OK(contracts.OpPtyOpenRoot, rootParams())
	if !term.ValidTicket(d["ticket"].(string)) || d["unix_user"] != "root" || d["recording"] != true {
		t.Fatal(d)
	}
	if pol := e.h.OK(contracts.OpPtyPolicy, map[string]any{}); pol["root_enabled"] != true || pol["record_user"] != true {
		t.Fatal(pol)
	}
	// Tham số sai bị chặn ở schema; không có socket terminal → dependency_unavailable.
	bad := rootParams()
	bad["unix_user"] = "ubuntu"
	if res := e.h.Call(contracts.OpPtyOpenRoot, bad); res.OK {
		t.Fatal("tham số lạ phải bị từ chối")
	}
	e.d.Term = nil
	e.h.Fail(contracts.OpPtyOpenRoot, rootParams(), "dependency_unavailable")
}

// pty.list trả phiên sống; pty.recording.read đọc bản ghi theo offset (ghép trang = đọc một lần).
func TestPtyListAndRecordingRead(t *testing.T) {
	e := newEnv(t)
	e.d.RootTerminal = true
	e.d.Term = ops.NewTermManager(e.d, nil)
	e.d.Term.Spawn = func(_ context.Context, s *term.Session) (term.Proc, error) { return term.NewFakeShell(s), nil }
	if l := e.h.OK(contracts.OpPtyList, map[string]any{}); len(l["sessions"].([]any)) != 0 {
		t.Fatal(l)
	}
	p := rootParams()
	id := p["session_uuid"].(string)
	d := e.h.OK(contracts.OpPtyOpenRoot, p)
	e.h.Fail(contracts.OpPtyOpenRoot, p, "already_exists") // cùng session_uuid
	l := e.h.OK(contracts.OpPtyList, map[string]any{})["sessions"].([]any)
	if len(l) != 1 || l[0].(map[string]any)["session_uuid"] != id || l[0].(map[string]any)["mode"] != "root" {
		t.Fatal(l)
	}
	a, b := net.Pipe()
	done := make(chan struct{})
	go func() { e.d.Term.Serve(context.Background(), b); close(done) }()
	br := bufio.NewReader(a)
	if err := term.WriteAttach(a, d["ticket"].(string)); err != nil || term.ReadAttachReply(br) != nil {
		t.Fatal("ATTACH lỗi", err)
	}
	seen := make(chan struct{})
	go func() { // đọc output tới khi thấy dòng cuối, rồi xả phần còn lại
		var got strings.Builder
		closed := false
		for {
			typ, b, err := term.ReadFrame(br)
			if err != nil {
				return
			}
			got.Write(b)
			if typ == term.FrameData && strings.Contains(got.String(), "dong-29 x") && !closed {
				close(seen)
				closed = true
			}
		}
	}()
	for i := 0; i < 30; i++ {
		_ = term.WriteFrame(a, term.FrameData, []byte(fmt.Sprintf("echo dong-%02d %s\r", i, strings.Repeat("x", 60))))
	}
	<-seen
	_ = term.WriteFrame(a, term.FrameData, []byte("exit\r"))
	<-done
	_ = a.Close()

	rp := map[string]any{"session_uuid": id, "offset": 0, "max_bytes": 1 << 20}
	full := e.h.OK(contracts.OpPtyRecordingRead, rp)
	if full["eof"] != true || full["truncated"] != false || full["width"] != float64(100) || full["height"] != float64(30) {
		t.Fatal(full)
	}
	var whole strings.Builder
	for _, ev := range full["events"].([]any) {
		whole.WriteString(ev.(map[string]any)["data"].(string))
	}
	if !strings.Contains(whole.String(), "dong-29") {
		t.Fatal(whole.String())
	}
	var paged strings.Builder
	off, pages := float64(0), 0
	for {
		pg := e.h.OK(contracts.OpPtyRecordingRead, map[string]any{"session_uuid": id, "offset": off, "max_bytes": 1024})
		for _, ev := range pg["events"].([]any) {
			paged.WriteString(ev.(map[string]any)["data"].(string))
		}
		pages++
		if pg["eof"] == true {
			break
		}
		if pg["next_offset"].(float64) <= off || pages > 200 {
			t.Fatal("next_offset phải tiến", pg["next_offset"], off)
		}
		off = pg["next_offset"].(float64)
	}
	if pages < 3 || paged.String() != whole.String() {
		t.Fatalf("đọc theo trang (%d trang) phải ghép lại bằng bản đầy đủ", pages)
	}
	// Bản ghi nằm dưới /var/lib/itso/recordings, quyền 0600; phiên đã đóng rời pty.list.
	if fi, err := e.fs.Lstat(ops.RecordingDir + "/" + id + ".cast"); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatal(err)
	}
	if l := e.h.OK(contracts.OpPtyList, map[string]any{}); len(l["sessions"].([]any)) != 0 {
		t.Fatal(l)
	}
	e.h.Fail(contracts.OpPtyRecordingRead, map[string]any{"session_uuid": nextSess(), "offset": 0, "max_bytes": 4096}, "not_found")
	e.h.Fail(contracts.OpPtyRecordingRead, map[string]any{"session_uuid": id, "offset": 1 << 30, "max_bytes": 4096}, "invalid_params")
	for _, bad := range []map[string]any{{"session_uuid": "../../etc/shadow", "offset": 0, "max_bytes": 4096},
		{"session_uuid": id, "offset": -1, "max_bytes": 4096}, {"session_uuid": id, "offset": 0, "max_bytes": 10}} {
		if res := e.h.Call(contracts.OpPtyRecordingRead, bad); res.OK {
			t.Fatalf("phải từ chối %v", bad)
		}
	}
}

func TestTermArgvRootGolden(t *testing.T) {
	s := &term.Session{UUID: sess, User: "root", UID: 0, GID: 0, Mode: "root", Cols: 100, Rows: 30}
	argv, err := ops.TermArgv(s)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "pty.root.systemd-run.argv", strings.Join(argv, "\n")+"\n")
	if strings.Contains(strings.Join(argv, " "), "sh -c") {
		t.Fatal("không dùng sh -c")
	}
	if _, err := ops.TermArgv(&term.Session{UUID: sess, User: "anphat", UID: 20001, Mode: "root"}); err == nil {
		t.Fatal("mode root với user khác root phải bị từ chối")
	}
}
