package ops_test

import (
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	ct "itso.local/agent/internal/contracttest"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/term"
)

const sess = "01938a25-0001-7000-8000-0000000000aa"

func ptyParams(user string, uid int) map[string]any {
	return map[string]any{"account": ct.Acct(user, uid), "session_uuid": sess, "cols": 120, "rows": 32, "idle_timeout_sec": 900}
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
