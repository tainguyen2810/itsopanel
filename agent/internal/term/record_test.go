package term_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"itso.local/agent/internal/term"
)

// Phiên root được ghi asciicast v2; đọc theo offset trả từng trang, next_offset nối tiếp, EOF khi phiên đóng.
func TestRecordingRoundTripAndOffset(t *testing.T) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	m := manager(c)
	m.RecDir = t.TempDir()
	s := session("root")
	s.UID, s.GID, s.Mode, s.Record = 0, 0, "root", true
	tk, _, _ := m.Issue(s)
	if l := m.Lives(); len(l) != 1 || l[0].Mode != "root" || l[0].Attached || !l[0].Recording {
		t.Fatalf("phiên chờ ATTACH phải có trong danh sách: %+v", l)
	}
	conn, br, err := attach(t, m, tk)
	if err != nil {
		t.Fatal(err)
	}
	readUntil(t, br, "root@itso:~# ")
	for _, cmd := range []string{"whoami\r", "echo xin chào\r", "pwd\r"} {
		c.add(500 * time.Millisecond)
		_ = term.WriteFrame(conn, term.FrameData, []byte(cmd))
	}
	readUntil(t, br, "/root\r\nroot@itso:~# ")
	path, _ := term.RecordingPath(m.RecDir, s.UUID)
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatal("bản ghi phải là file 0600", err)
	}
	l := m.Lives()
	if len(l) != 1 || !l[0].Attached || l[0].RecordingBytes == 0 {
		t.Fatalf("%+v", l)
	}
	// Đang mở: đọc được phần đã ghi, chưa EOF.
	pg, err := term.ReadPage(path, 0, 1<<20, m.Recording(s.UUID))
	if err != nil || pg.EOF || pg.Width != 80 || pg.Height != 24 || len(pg.Events) == 0 {
		t.Fatalf("%+v %v", pg, err)
	}
	_ = term.WriteFrame(conn, term.FrameData, []byte("exit\r"))
	readUntil(t, br, "\x00never")
	time.Sleep(20 * time.Millisecond)
	if len(m.Lives()) != 0 || m.Recording(s.UUID) {
		t.Fatal("phiên đóng phải rời danh sách")
	}
	full, err := term.ReadPage(path, 0, 1<<20, false)
	if err != nil || !full.EOF || full.Truncated {
		t.Fatalf("%+v %v", full, err)
	}
	var all strings.Builder
	for _, e := range full.Events {
		all.WriteString(e.Data)
	}
	if !strings.Contains(all.String(), "xin chào") || !strings.Contains(all.String(), "root\r\n") {
		t.Fatalf("thiếu output: %q", all.String())
	}
	// Đọc từng trang 1 KB: ghép lại bằng bản đọc một lần; mỗi trang tiến lên.
	var paged []term.Event
	off := int64(0)
	for i := 0; ; i++ {
		p, err := term.ReadPage(path, off, 1024, false)
		if err != nil || i > 100 {
			t.Fatal(err, i)
		}
		paged = append(paged, p.Events...)
		if p.EOF {
			break
		}
		if p.NextOffset <= off {
			t.Fatal("next_offset phải tiến", off, p.NextOffset)
		}
		off = p.NextOffset
	}
	if len(paged) != len(full.Events) {
		t.Fatal(len(paged), len(full.Events))
	}
	for i := 1; i < len(paged); i++ {
		if paged[i].T < paged[i-1].T {
			t.Fatal("thời gian phải tăng dần")
		}
	}
	// Offset giữa dòng hoặc vượt kích thước bị từ chối.
	if p, err := term.ReadPage(path, 7, 1024, false); err != nil || len(p.Events) == 0 || p.Events[0] != full.Events[0] {
		t.Fatal("offset trong header phải đọc từ sự kiện đầu", err)
	}
	fi, _ := os.Stat(path)
	if _, err := term.ReadPage(path, fi.Size()+10, 1024, false); err == nil {
		t.Fatal("offset vượt kích thước phải lỗi")
	}
	if _, err := term.ReadPage(path, full.NextOffset-2, 1024, false); err == nil {
		t.Fatal("offset giữa dòng phải lỗi")
	}
}

// Vượt giới hạn dung lượng: ghi marker truncated và đóng phiên với lý do "limit".
func TestRecordingLimitClosesSession(t *testing.T) {
	c := &clock{t: time.Now()}
	m := manager(c)
	m.RecDir, m.RecLimit = t.TempDir(), 600
	s := session("anphat")
	s.Record = true
	tk, _, _ := m.Issue(s)
	conn, br, err := attach(t, m, tk)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for i := 0; i < 40; i++ {
			if term.WriteFrame(conn, term.FrameData, []byte("echo "+strings.Repeat("A", 40)+"\r")) != nil {
				return
			}
		}
	}()
	if _, reason := readUntil(t, br, "\x00never"); reason != "limit" {
		t.Fatal("phải đóng do vượt giới hạn bản ghi", reason)
	}
	path, _ := term.RecordingPath(m.RecDir, s.UUID)
	pg, err := term.ReadPage(path, 0, 1<<20, false)
	if err != nil || !pg.Truncated || !pg.EOF {
		t.Fatalf("%+v %v", pg, err)
	}
	if fi, _ := os.Stat(path); fi.Size() > 600+64 {
		t.Fatal("bản ghi vượt giới hạn quá nhiều", fi.Size())
	}
}

// Không ghi được bản ghi (thư mục không tạo được) → phiên phải ghi không được mở.
func TestRecordingRequiredOrRefuse(t *testing.T) {
	c := &clock{t: time.Now()}
	m := manager(c)
	f := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(f, nil, 0o600)
	m.RecDir = filepath.Join(f, "sub")
	s := session("root")
	s.Mode, s.Record = "root", true
	tk, _, _ := m.Issue(s)
	if _, _, err := attach(t, m, tk); err == nil || !strings.Contains(err.Error(), "record_failed") {
		t.Fatal(err)
	}
	m2 := manager(c)
	tk2, _, _ := m2.Issue(s)
	if _, _, err := attach(t, m2, tk2); err == nil || !strings.Contains(err.Error(), "record_failed") {
		t.Fatal("thiếu RecDir cũng phải từ chối", err)
	}
	// uuid trùng phiên còn sống bị từ chối; uuid lạ không thành tên file.
	time.Sleep(20 * time.Millisecond) // Serve giải phóng phiên sau khi trả ERR
	if _, _, err := m2.Issue(s); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m2.Issue(s); err != term.ErrDuplicate {
		t.Fatal(err)
	}
	if _, err := term.RecordingPath("/x", "../../etc/passwd"); err == nil {
		t.Fatal("uuid lạ phải bị từ chối")
	}
}

// Rune UTF-8 bị cắt giữa hai khối output vẫn được ghi nguyên vẹn.
func TestRecorderUTF8Carry(t *testing.T) {
	dir := t.TempDir()
	s := session("anphat")
	r, err := term.NewRecorder(dir, &s, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	b := []byte("chào")
	_ = r.Output(b[:3]) // "ch" + byte đầu của "à"
	_ = r.Output(b[3:])
	_ = r.Close()
	path, _ := term.RecordingPath(dir, s.UUID)
	pg, err := term.ReadPage(path, 0, 4096, false)
	if err != nil {
		t.Fatal(err)
	}
	var got strings.Builder
	for _, e := range pg.Events {
		got.WriteString(e.Data)
	}
	if got.String() != "chào" {
		t.Fatalf("%q", got.String())
	}
}
