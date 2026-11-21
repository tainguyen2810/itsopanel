package fsx

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

type tEntry struct {
	name string
	typ  byte
	mode int64
	body string
	link string
}

func tarOf(t *testing.T, es ...tEntry) *bytes.Reader {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, e := range es {
		must(t, tw.WriteHeader(&tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Size: int64(len(e.body)), Linkname: e.link}))
		if e.typ == tar.TypeReg {
			_, err := tw.Write([]byte(e.body))
			must(t, err)
		}
	}
	must(t, tw.Close())
	return bytes.NewReader(b.Bytes())
}

func TestRestoreTar(t *testing.T) {
	r, home, outside := setup(t)
	src := tarOf(t,
		tEntry{name: "public/", typ: tar.TypeDir, mode: 0o755},
		tEntry{name: "public/index.php", typ: tar.TypeReg, mode: 0o644, body: "<?php echo 2;"},
		tEntry{name: "public/suid", typ: tar.TypeReg, mode: 0o4755, body: "x"},
		tEntry{name: "public/link", typ: tar.TypeSymlink, link: outside},
		tEntry{name: "public/fifo", typ: tar.TypeFifo},
	)
	res, err := r.RestoreTar("backups/restore-1", src, 1<<20, 100)
	must(t, err)
	if b, _ := os.ReadFile(filepath.Join(home, "backups/restore-1/public/index.php")); string(b) != "<?php echo 2;" {
		t.Fatal(string(b))
	}
	reasons := map[string]string{}
	for _, s := range res.Skipped {
		reasons[s.Path] = s.Reason
	}
	if reasons["public/link"] != "symlink" || reasons["public/suid"] != "setuid" || reasons["public/fifo"] != "device" {
		t.Fatalf("%+v", res.Skipped)
	}
	if _, err := os.Lstat(filepath.Join(home, "backups/restore-1/public/link")); err == nil {
		t.Fatal("symlink được tạo")
	}
	st, err := os.Stat(filepath.Join(home, "backups/restore-1/public/suid"))
	must(t, err)
	if st.Mode()&os.ModeSetuid != 0 || st.Mode().Perm() != 0o755 {
		t.Fatal(st.Mode())
	}
	if st, _ := os.Stat(filepath.Join(home, "backups/restore-1")); st.Mode().Perm() != 0o755 {
		t.Fatal("thư mục đích phải 0755 sau khi đổi tên", st.Mode())
	}
	// Đích đã tồn tại → already_exists, không trộn.
	_, err = r.RestoreTar("backups/restore-1", tarOf(t, tEntry{name: "a", typ: tar.TypeReg, mode: 0o644, body: "a"}), 1<<20, 100)
	wantCode(t, err, "already_exists")
	// Tên tar đi ra ngoài → lỗi, không để lại rác.
	_, err = r.RestoreTar("backups/restore-2", tarOf(t, tEntry{name: "../../../outside/pwn", typ: tar.TypeReg, mode: 0o644, body: "p"}), 1<<20, 100)
	if err == nil {
		t.Fatal("tên .. phải bị từ chối")
	}
	if _, err := os.Stat(filepath.Join(outside, "pwn")); err == nil {
		t.Fatal("ghi ra ngoài home")
	}
	if _, err := os.Stat(filepath.Join(home, "backups/restore-2")); err == nil {
		t.Fatal("đích dở dang không được xuất hiện")
	}
	if es, _ := filepath.Glob(filepath.Join(home, "backups/.itso-restore-*")); len(es) != 0 {
		t.Fatal("thư mục tạm còn sót", es)
	}
	// Vượt giới hạn kích thước / số mục.
	_, err = r.RestoreTar("backups/restore-3", tarOf(t, tEntry{name: "big", typ: tar.TypeReg, mode: 0o644, body: "0123456789"}), 5, 100)
	if err == nil {
		t.Fatal("vượt kích thước phải lỗi")
	}
	// Đích là symlink ra ngoài có sẵn → không ghi xuyên.
	must(t, os.Symlink(outside, filepath.Join(home, "backups/restore-4")))
	_, err = r.RestoreTar("backups/restore-4", tarOf(t, tEntry{name: "x", typ: tar.TypeReg, mode: 0o644, body: "x"}), 1<<20, 100)
	if err == nil {
		t.Fatal("đích symlink phải bị từ chối")
	}
	if _, err := os.Stat(filepath.Join(outside, "x")); err == nil {
		t.Fatal("ghi xuyên symlink")
	}
}

func TestExchange(t *testing.T) {
	r, home, outside := setup(t)
	must(t, os.MkdirAll(filepath.Join(home, "sites/a.restore"), 0o755))
	must(t, os.WriteFile(filepath.Join(home, "sites/a.restore/new"), []byte("n"), 0o644))
	must(t, r.Exchange("sites/a", "sites/a.restore"))
	if _, err := os.Stat(filepath.Join(home, "sites/a/new")); err != nil {
		t.Fatal("hoán đổi thất bại", err)
	}
	if _, err := os.Stat(filepath.Join(home, "sites/a.restore/public/index.php")); err != nil {
		t.Fatal("bản cũ phải nằm ở chỗ bản mới", err)
	}
	must(t, os.Symlink(outside, filepath.Join(home, "sites/evil")))
	if err := r.Exchange("sites/a", "sites/evil"); err == nil {
		t.Fatal("không hoán đổi với symlink")
	}
}
