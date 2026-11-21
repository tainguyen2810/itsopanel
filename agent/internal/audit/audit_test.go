package audit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log", "agent-audit.jsonl")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := l.Append(Entry{Op: "system.ping", OpID: "x", CallerUID: 1000, ParamsHash: HashParams([]byte("{}")), Result: "ok"}); err != nil {
			t.Fatal(err)
		}
	}
	_ = l.Close()
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("quyền %o", fi.Mode().Perm())
	}
	v, err := Verify(path)
	if err != nil || !v.OK || v.Count != 5 || v.LastSeq != 5 {
		t.Fatalf("verify = %+v %v", v, err)
	}
	// Mở lại: seq nối tiếp.
	l, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	e, _ := l.Append(Entry{Op: "audit.tail", Result: "ok", ParamsHash: HashParams(nil)})
	_ = l.Close()
	if e.Seq != 6 || e.PrevHash != v.LastHash {
		t.Fatalf("nối chuỗi sai: %+v", e)
	}
	got, v2, err := Tail(path, 3, 2)
	if err != nil || len(got) != 2 || got[0].Seq != 4 || !v2.OK {
		t.Fatalf("tail = %+v %+v %v", got, v2, err)
	}
}

func TestTamperDetected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.jsonl")
	l, _ := Open(path)
	for i := 0; i < 3; i++ {
		_, _ = l.Append(Entry{Op: "account.ensure", Result: "ok", ParamsHash: HashParams(nil)})
	}
	_ = l.Close()
	b, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	lines[1] = strings.Replace(lines[1], `"result":"ok"`, `"result":"error"`, 1)
	_ = os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
	v, err := Verify(path)
	if err != nil || v.OK || v.BrokenSeq != 2 {
		t.Fatalf("phải phát hiện sửa ở seq 2: %+v %v", v, err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("không được ghi tiếp lên chuỗi hỏng")
	}
	// Xóa một dòng giữa cũng bị phát hiện.
	_ = os.WriteFile(path, []byte(lines[0]+"\n"+strings.Join(lines[2:], "\n")+"\n"), 0o600)
	if v, _ := Verify(path); v.OK {
		t.Fatal("xóa dòng phải bị phát hiện")
	}
}
