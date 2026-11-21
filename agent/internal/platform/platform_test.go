package platform

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBinsTable(t *testing.T) {
	for _, f := range forbidden {
		if _, ok := Bins[f]; ok {
			t.Errorf("bảng lệnh không được có %q", f)
		}
	}
	for name, p := range Bins {
		if !filepath.IsAbs(p) || filepath.Clean(p) != p {
			t.Errorf("%s: đường dẫn phải tuyệt đối: %s", name, p)
		}
	}
}

func TestCheck(t *testing.T) {
	if _, err := Check(Cmd{Bin: "sh", Args: []string{"-c", "id"}}); err == nil {
		t.Fatal("sh phải bị từ chối")
	}
	if _, err := Check(Cmd{Bin: "useradd", Args: []string{"a\nb"}}); err == nil {
		t.Fatal("argv có xuống dòng phải bị từ chối")
	}
	if _, err := Check(Cmd{Bin: "useradd", Args: []string{"a\x00b"}}); err == nil {
		t.Fatal("argv có NUL phải bị từ chối")
	}
	if p, err := Check(Cmd{Bin: "useradd", Args: []string{"-m", "x"}}); err != nil || p != "/usr/sbin/useradd" {
		t.Fatalf("useradd: %s %v", p, err)
	}
}

func TestFake(t *testing.T) {
	f := NewFake()
	f.Responses["systemctl is-active"] = Result{Stdout: []byte("active\n")}
	f.Responses["systemctl"] = Result{ExitCode: 3}
	r, _ := f.Run(context.Background(), Cmd{Bin: "systemctl", Args: []string{"is-active", "nginx"}})
	if string(r.Stdout) != "active\n" {
		t.Fatalf("khớp tiền tố dài nhất sai: %+v", r)
	}
	r, _ = f.Run(context.Background(), Cmd{Bin: "systemctl", Args: []string{"start", "nginx"}})
	if r.ExitCode != 3 {
		t.Fatalf("khớp tiền tố ngắn sai: %+v", r)
	}
	if _, err := f.Run(context.Background(), Cmd{Bin: "bash"}); err == nil {
		t.Fatal("fake cũng phải từ chối lệnh ngoài bảng")
	}
	if got := f.Lines(); len(got) != 2 || got[1] != "systemctl start nginx" {
		t.Fatalf("lines = %v", got)
	}
}

func TestExecRunnerReadOnly(t *testing.T) {
	if _, err := os.Stat(Bins["findmnt"]); err != nil {
		t.Skip("không có findmnt") // chỉ chạy lệnh chỉ-đọc có sẵn
	}
	r, err := ExecRunner{}.Run(context.Background(), Cmd{Bin: "findmnt", Args: []string{"-n", "-o", "TARGET", "/"}})
	if err != nil || r.ExitCode != 0 {
		t.Fatalf("findmnt: %+v %v", r, err)
	}
	if _, err := (ExecRunner{}).Run(context.Background(), Cmd{Bin: "sh"}); err == nil {
		t.Fatal("ExecRunner phải từ chối sh")
	}
}

func TestFS(t *testing.T) {
	root := t.TempDir()
	f := NewFS(root, true)
	if _, err := f.Path("etc/passwd"); err == nil {
		t.Fatal("đường dẫn tương đối phải bị từ chối")
	}
	if _, err := f.Path("/etc/../shadow"); err == nil {
		t.Fatal("đường dẫn chưa chuẩn hóa phải bị từ chối")
	}
	o := Owner{0, 0}
	ch, err := f.WriteAtomic("/etc/systemd/system/x.slice.d/50-itso.conf", []byte("a\n"), 0o644, o)
	if err != nil || !ch {
		t.Fatalf("ghi lần đầu: %t %v", ch, err)
	}
	ch, err = f.WriteAtomic("/etc/systemd/system/x.slice.d/50-itso.conf", []byte("a\n"), 0o644, o)
	if err != nil || ch {
		t.Fatalf("ghi lại nội dung giống phải không đổi: %t %v", ch, err)
	}
	ch, _ = f.WriteAtomic("/etc/systemd/system/x.slice.d/50-itso.conf", []byte("a\n"), 0o600, o)
	if !ch {
		t.Fatal("đổi quyền phải tính là thay đổi")
	}
	_ = os.MkdirAll(filepath.Join(root, "home"), 0o755)
	_ = os.Symlink("/etc/shadow", filepath.Join(root, "home", "evil"))
	if _, err := f.WriteAtomic("/home/evil", []byte("x"), 0o644, o); err == nil {
		t.Fatal("ghi vào symlink phải bị từ chối")
	}
	if _, err := f.ReadFile("/home/evil"); err == nil {
		t.Fatal("đọc qua symlink phải bị từ chối")
	}
	if _, err := f.EnsureDir("/home/evil", 0o750, o); err == nil {
		t.Fatal("EnsureDir trên symlink phải bị từ chối")
	}
	ch, err = f.EnsureDir("/home/anphat", 0o750, Owner{0, 20001})
	if err != nil || !ch {
		t.Fatalf("tạo home: %t %v", ch, err)
	}
	if ch, _ := f.EnsureDir("/home/anphat", 0o750, Owner{0, 20001}); ch {
		t.Fatal("EnsureDir lần 2 phải không đổi")
	}
	if got, _ := f.OwnerOf("/home/anphat"); got != (Owner{0, 20001}) {
		t.Fatalf("owner = %+v", got)
	}
	if ch, _ := f.Remove("/etc/systemd/system/x.slice.d/50-itso.conf"); !ch {
		t.Fatal("xóa file phải trả changed")
	}
	if ch, _ := f.Remove("/etc/none"); ch {
		t.Fatal("xóa file không có phải không đổi")
	}
}
