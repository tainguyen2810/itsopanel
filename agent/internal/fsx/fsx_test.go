package fsx

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// setup tạo cấu trúc: <tmp>/outside/secret.txt (ngoài home) và <tmp>/home/anphat (home) có sites/a/public/index.php.
func setup(t *testing.T) (*Root, string, string) {
	t.Helper()
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	home := filepath.Join(base, "home", "anphat")
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("TOP-SECRET"), 0o644))
	must(t, os.MkdirAll(filepath.Join(home, "sites/a/public"), 0o755))
	must(t, os.WriteFile(filepath.Join(home, "sites/a/public/index.php"), []byte("<?php echo 1;"), 0o644))
	r, err := OpenRoot(home)
	must(t, err)
	t.Cleanup(func() { r.Close() })
	return r, home, outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("mong đợi lỗi %s, nhận nil", code)
	}
	if Code(err) != code {
		t.Fatalf("mong đợi %s, nhận %v", code, err)
	}
}

func TestTraversalAndAbsoluteRejected(t *testing.T) {
	r, _, _ := setup(t)
	for _, p := range []string{"../outside/secret.txt", "/etc/passwd", "sites/../../outside/secret.txt", "sites/./a",
		"sites//a", "", "sites/", "a\x00b", "a\nb", "sites/.."} {
		_, err := r.Read(p, 0, 100)
		wantCode(t, err, "invalid_params")
		_, _, err = r.List(p, true, 10)
		wantCode(t, err, "invalid_params")
	}
	if err := CheckPath("tài liệu/bản vẽ 1.pdf"); err != nil {
		t.Fatalf("tên có khoảng trắng/Unicode phải hợp lệ: %v", err)
	}
}

func TestSymlinkOutsideBlocked(t *testing.T) {
	r, home, outside := setup(t)
	must(t, os.Symlink(outside, filepath.Join(home, "sites/a/public/link-dir")))
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(home, "sites/a/public/link-file")))
	must(t, os.Symlink("/etc", filepath.Join(home, "etc")))
	must(t, os.Symlink("../../../../outside/secret.txt", filepath.Join(home, "sites/a/rel-escape")))

	for _, p := range []string{"sites/a/public/link-file", "sites/a/public/link-dir/secret.txt", "etc/passwd", "sites/a/rel-escape"} {
		_, err := r.Read(p, 0, 100)
		wantCode(t, err, "path_outside_home")
	}
	_, _, err := r.List("sites/a/public/link-dir", true, 10)
	wantCode(t, err, "path_outside_home")
	// Ghi vào thư mục symlink ra ngoài: bị chặn, file ngoài không bị tạo.
	_, _, err = r.Write("sites/a/public/link-dir/pwned.txt", []byte("x"), nil, nil)
	wantCode(t, err, "path_outside_home")
	if _, err := os.Stat(filepath.Join(outside, "pwned.txt")); err == nil {
		t.Fatal("đã ghi được file ngoài home")
	}
	// Ghi đè symlink file: thay link bằng file thường, đích ngoài home giữ nguyên.
	_, _, err = r.Write("sites/a/public/link-file", []byte("mới"), nil, nil)
	must(t, err)
	if b, _ := os.ReadFile(filepath.Join(outside, "secret.txt")); string(b) != "TOP-SECRET" {
		t.Fatal("đích symlink bị ghi đè")
	}
	// Xóa symlink thư mục: chỉ xóa link.
	_, err = r.Delete([]string{"sites/a/public/link-dir"})
	must(t, err)
	if _, err := os.Stat(filepath.Join(outside, "secret.txt")); err != nil {
		t.Fatal("xóa symlink đã xóa đích")
	}
	// chmod symlink không đổi quyền đích.
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(home, "l2")))
	_, err = r.Chmod([]string{"l2"}, 0o777, false)
	must(t, err)
	if st, _ := os.Stat(filepath.Join(outside, "secret.txt")); st.Mode().Perm() != 0o644 {
		t.Fatal("chmod đi theo symlink ra ngoài")
	}
	// Đổi tên/chuyển tới đường dẫn đi qua symlink ra ngoài: bị chặn.
	must(t, os.Symlink(outside, filepath.Join(home, "out")))
	err = r.Rename("sites/a/public/index.php", "out/index.php")
	wantCode(t, err, "path_outside_home")
	_, err = r.Copy([]string{"sites/a/public/index.php"}, "out")
	wantCode(t, err, "path_outside_home")
}

func TestSymlinkInsideAllowed(t *testing.T) {
	r, home, _ := setup(t)
	must(t, os.Symlink("public/index.php", filepath.Join(home, "sites/a/idx")))
	res, err := r.Read("sites/a/idx", 0, 100)
	must(t, err)
	if string(res.Content) != "<?php echo 1;" {
		t.Fatalf("đọc qua symlink trong home sai: %q", res.Content)
	}
}

// TestSymlinkRace: một goroutine liên tục đổi sites/flip giữa thư mục thật và symlink ra ngoài; đọc song song
// không bao giờ trả nội dung ngoài home (TOCTOU bị kernel chặn).
func TestSymlinkRace(t *testing.T) {
	r, home, outside := setup(t)
	flip := filepath.Join(home, "sites/flip")
	real := filepath.Join(home, "sites/real")
	must(t, os.MkdirAll(real, 0o755))
	must(t, os.WriteFile(filepath.Join(real, "secret.txt"), []byte("inside"), 0o644))
	var stop atomic.Bool
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for !stop.Load() {
			_ = os.Remove(flip)
			_ = os.Symlink(outside, flip)
			_ = os.Remove(flip)
			_ = os.Symlink("real", flip)
		}
	}()
	deadline := time.Now().Add(1500 * time.Millisecond)
	reads := 0
	for time.Now().Before(deadline) {
		res, err := r.Read("sites/flip/secret.txt", 0, 100)
		if err == nil {
			reads++
			if string(res.Content) != "inside" {
				stop.Store(true)
				wg.Wait()
				t.Fatalf("đọc được nội dung ngoài home: %q", res.Content)
			}
		}
	}
	stop.Store(true)
	wg.Wait()
	t.Logf("%d lần đọc thành công, không lần nào ra ngoài home", reads)
}

func TestWriteReadEditor(t *testing.T) {
	r, _, _ := setup(t)
	sum, n, err := r.Write("sites/a/public/robots.txt", []byte("User-agent: *\n"), nil, nil)
	must(t, err)
	if n != 14 {
		t.Fatalf("size %d", n)
	}
	res, err := r.Read("sites/a/public/robots.txt", 0, 1<<20)
	must(t, err)
	if res.FileSHA256 == nil || *res.FileSHA256 != sum {
		t.Fatal("file_sha256 phải bằng sha256 khi đọc trọn")
	}
	stale := strings.Repeat("0", 64)
	_, _, err = r.Write("sites/a/public/robots.txt", []byte("x"), &stale, nil)
	wantCode(t, err, "precondition_failed")
	_, _, err = r.Write("sites/a/public/robots.txt", []byte("Disallow: /\n"), &sum, nil)
	must(t, err)
}

func TestReadChunks(t *testing.T) {
	r, home, _ := setup(t)
	data := bytes.Repeat([]byte("0123456789"), 1000)
	must(t, os.WriteFile(filepath.Join(home, "sites/data.bin"), data, 0o644))
	res, err := r.Read("sites/data.bin", 9000, 4000)
	must(t, err)
	if len(res.Content) != 1000 || res.Truncated || res.FileSHA256 != nil || res.Size != 10000 {
		t.Fatalf("khúc cuối sai: len=%d trunc=%v", len(res.Content), res.Truncated)
	}
	res, _ = r.Read("sites/data.bin", 0, 4000)
	if !res.Truncated {
		t.Fatal("phải truncated")
	}
	_, err = r.Read("sites", 0, 10)
	wantCode(t, err, "invalid_params")
}

func TestMkdirMoveCopyDeleteChmod(t *testing.T) {
	r, home, _ := setup(t)
	c, err := r.Mkdir("sites/b", 0o750)
	must(t, err)
	if !c {
		t.Fatal("phải tạo")
	}
	if c, _ := r.Mkdir("sites/b", 0o750); c {
		t.Fatal("lần 2 phải created=false")
	}
	_, err = r.Copy([]string{"sites/a"}, "sites/b")
	must(t, err)
	if _, err := os.Stat(filepath.Join(home, "sites/b/a/public/index.php")); err != nil {
		t.Fatal("copy đệ quy thiếu file")
	}
	_, err = r.Copy([]string{"sites/a"}, "sites/b")
	wantCode(t, err, "already_exists")
	must(t, r.Rename("sites/b/a", "sites/b/a2"))
	wantCode(t, r.Rename("sites/a", "sites/b/a2"), "already_exists")
	_, err = r.Move([]string{"sites/b/a2"}, "sites")
	must(t, err)
	n, err := r.Chmod([]string{"sites/a2"}, 0o4755, true)
	must(t, err)
	if n < 3 {
		t.Fatalf("chmod đệ quy %d mục", n)
	}
	st, _ := os.Stat(filepath.Join(home, "sites/a2/public/index.php"))
	if st.Mode()&os.ModeSetuid != 0 || st.Mode().Perm() != 0o755 {
		t.Fatalf("chmod không được đặt setuid: %v", st.Mode())
	}
	_, err = r.Delete([]string{"sites/a2", "sites/b"})
	must(t, err)
	if _, err := os.Stat(filepath.Join(home, "sites/a2")); err == nil {
		t.Fatal("chưa xóa")
	}
	_, err = r.Delete([]string{"."})
	wantCode(t, err, "invalid_params")
}

func zipOf(t *testing.T, entries map[string][]byte, extra func(*zip.Writer)) []byte {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for n, c := range entries {
		w, err := zw.Create(n)
		must(t, err)
		_, _ = w.Write(c)
	}
	if extra != nil {
		extra(zw)
	}
	must(t, zw.Close())
	return b.Bytes()
}

func TestZipSlipBlocked(t *testing.T) {
	r, home, outside := setup(t)
	for i, name := range []string{"../../outside/evil.txt", "/tmp/evil.txt", "ok/../../evil.txt", "..\\..\\evil.txt"} {
		z := zipOf(t, map[string][]byte{name: []byte("pwned")}, nil)
		arc := "sites/slip" + string(rune('0'+i)) + ".zip"
		must(t, os.WriteFile(filepath.Join(home, arc), z, 0o644))
		_, err := r.Extract(arc, "sites/x", 1<<20, 100)
		wantCode(t, err, "path_outside_home")
	}
	if _, err := os.Stat(filepath.Join(outside, "evil.txt")); err == nil {
		t.Fatal("zip slip ghi ra ngoài home")
	}
	if es, _ := os.ReadDir(filepath.Join(home, "sites/x")); len(es) != 0 {
		t.Fatalf("thư mục đích còn rác: %v", es)
	}
}

func TestZipSymlinkSkippedAndModeStripped(t *testing.T) {
	r, home, outside := setup(t)
	z := zipOf(t, map[string][]byte{"app/index.php": []byte("<?php")}, func(zw *zip.Writer) {
		h := &zip.FileHeader{Name: "app/link"}
		h.SetMode(os.ModeSymlink | 0o777)
		w, _ := zw.CreateHeader(h)
		_, _ = w.Write([]byte(outside))
		h2 := &zip.FileHeader{Name: "app/suid"}
		h2.SetMode(os.ModeSetuid | 0o755)
		w2, _ := zw.CreateHeader(h2)
		_, _ = w2.Write([]byte("#!/bin/false"))
	})
	must(t, os.WriteFile(filepath.Join(home, "sites/app.zip"), z, 0o644))
	res, err := r.Extract("sites/app.zip", "sites", 1<<20, 100)
	must(t, err)
	if res.Skipped != 1 {
		t.Fatalf("symlink phải bị bỏ qua: %+v", res)
	}
	if _, err := os.Lstat(filepath.Join(home, "sites/app/link")); err == nil {
		t.Fatal("symlink được giải nén")
	}
	st, err := os.Stat(filepath.Join(home, "sites/app/suid"))
	must(t, err)
	if st.Mode()&os.ModeSetuid != 0 {
		t.Fatal("bit setuid không bị xóa")
	}
	// trùng tên → already_exists, không ghi đè
	must(t, os.WriteFile(filepath.Join(home, "sites/app/index.php"), []byte("bản của khách"), 0o644))
	_, err = r.Extract("sites/app.zip", "sites", 1<<20, 100)
	wantCode(t, err, "already_exists")
	if b, _ := os.ReadFile(filepath.Join(home, "sites/app/index.php")); string(b) != "bản của khách" {
		t.Fatal("giải nén trùng tên đã ghi đè")
	}
}

func TestZipBomb(t *testing.T) {
	r, home, _ := setup(t)
	zeros := make([]byte, 64<<20) // 64 MiB số 0 → nén còn ~64 KiB (tỉ lệ ~1000:1)
	z := zipOf(t, map[string][]byte{"bomb.bin": zeros}, nil)
	must(t, os.WriteFile(filepath.Join(home, "sites/bomb.zip"), z, 0o644))
	_, err := r.Extract("sites/bomb.zip", "sites/b", 1<<30, 100)
	wantCode(t, err, "invalid_params")
	if !strings.Contains(err.Error(), "zip bomb") {
		t.Fatalf("thông báo phải nói zip bomb: %v", err)
	}
	// Quá nhiều mục
	many := map[string][]byte{}
	for i := 0; i < 50; i++ {
		many["f"+string(rune('a'+i%26))+string(rune('a'+i/26))] = []byte("x")
	}
	must(t, os.WriteFile(filepath.Join(home, "sites/many.zip"), zipOf(t, many, nil), 0o644))
	_, err = r.Extract("sites/many.zip", "sites/m", 1<<20, 10)
	wantCode(t, err, "invalid_params")
	// Vượt tổng dung lượng (dữ liệu ngẫu nhiên, tỉ lệ thấp)
	rnd := make([]byte, 300<<10)
	for i := range rnd {
		rnd[i] = byte(i*7919 + i>>3)
	}
	must(t, os.WriteFile(filepath.Join(home, "sites/big.zip"), zipOf(t, map[string][]byte{"big.bin": rnd}, nil), 0o644))
	_, err = r.Extract("sites/big.zip", "sites/g", 100<<10, 10)
	wantCode(t, err, "invalid_params")
}

func TestTarGzHardlinkDeviceSkipped(t *testing.T) {
	r, home, _ := setup(t)
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	add := func(h *tar.Header, body string) {
		h.Size = int64(len(body))
		must(t, tw.WriteHeader(h))
		_, _ = tw.Write([]byte(body))
	}
	add(&tar.Header{Name: "pkg/", Typeflag: tar.TypeDir, Mode: 0o755}, "")
	add(&tar.Header{Name: "pkg/a.txt", Typeflag: tar.TypeReg, Mode: 0o6755}, "hello")
	add(&tar.Header{Name: "pkg/hard", Typeflag: tar.TypeLink, Linkname: "/etc/shadow"}, "")
	add(&tar.Header{Name: "pkg/sym", Typeflag: tar.TypeSymlink, Linkname: "/etc"}, "")
	add(&tar.Header{Name: "pkg/dev", Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3}, "")
	must(t, tw.Close())
	must(t, gz.Close())
	must(t, os.WriteFile(filepath.Join(home, "sites/pkg.tar.gz"), b.Bytes(), 0o644))
	res, err := r.Extract("sites/pkg.tar.gz", "sites", 1<<20, 100)
	must(t, err)
	if res.Skipped != 3 || res.Entries != 2 {
		t.Fatalf("kết quả sai: %+v", res)
	}
	st, err := os.Stat(filepath.Join(home, "sites/pkg/a.txt"))
	must(t, err)
	if st.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
		t.Fatal("setuid/setgid phải bị xóa")
	}
	for _, n := range []string{"hard", "sym", "dev"} {
		if _, err := os.Lstat(filepath.Join(home, "sites/pkg", n)); err == nil {
			t.Fatalf("%s không được giải nén", n)
		}
	}
	// tar với ../
	var b2 bytes.Buffer
	gz2 := gzip.NewWriter(&b2)
	tw2 := tar.NewWriter(gz2)
	must(t, tw2.WriteHeader(&tar.Header{Name: "../evil", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}))
	_, _ = tw2.Write([]byte("x"))
	must(t, tw2.Close())
	must(t, gz2.Close())
	must(t, os.WriteFile(filepath.Join(home, "sites/evil.tar.gz"), b2.Bytes(), 0o644))
	_, err = r.Extract("sites/evil.tar.gz", "sites", 1<<20, 100)
	wantCode(t, err, "path_outside_home")
}

func TestArchiveRoundTrip(t *testing.T) {
	r, home, outside := setup(t)
	must(t, os.Symlink(outside, filepath.Join(home, "sites/a/public/out")))
	for _, f := range []string{"zip", "tar.gz"} {
		target := "sites/a." + f
		n, err := r.Archive([]string{"sites/a"}, target, f)
		must(t, err)
		if n == 0 {
			t.Fatal("file nén rỗng")
		}
		res, err := r.Extract(target, "sites/restore-"+strings.ReplaceAll(f, ".", ""), 1<<20, 100)
		must(t, err)
		b, err := os.ReadFile(filepath.Join(home, "sites/restore-"+strings.ReplaceAll(f, ".", ""), "a/public/index.php"))
		must(t, err)
		if string(b) != "<?php echo 1;" || res.Entries < 3 {
			t.Fatalf("%s: giải nén lại sai (%+v)", f, res)
		}
		if _, err := os.Lstat(filepath.Join(home, "sites/restore-"+strings.ReplaceAll(f, ".", ""), "a/public/out")); err == nil {
			t.Fatalf("%s: symlink không được đưa vào file nén", f)
		}
	}
	_, err := r.Archive([]string{"sites/a"}, "sites/a.zip", "zip")
	wantCode(t, err, "already_exists")
}

func TestUploadCommitAndStreams(t *testing.T) {
	_, home, _ := setup(t)
	staging := filepath.Join(t.TempDir(), "up.part")
	data := bytes.Repeat([]byte("x"), 12345)
	must(t, os.WriteFile(staging, data, 0o600))
	f, _ := os.Open(staging)
	out, err := Serve(Request{Op: "upload_commit", Home: home, Params: []byte(`{"target":"sites/up.bin","size":12345}`)}, nil, nil, f)
	f.Close()
	must(t, err)
	sum := sha256.Sum256(data)
	if out.(map[string]any)["sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("sha256 sai: %v", out)
	}
	f, _ = os.Open(staging)
	_, err = Serve(Request{Op: "upload_commit", Home: home, Params: []byte(`{"target":"sites/up.bin","size":12345}`)}, nil, nil, f)
	f.Close()
	wantCode(t, err, "already_exists")
	f, _ = os.Open(staging)
	_, err = Serve(Request{Op: "upload_commit", Home: home, Params: []byte(`{"target":"sites/up2.bin","size":100}`)}, nil, nil, f)
	f.Close()
	wantCode(t, err, "invalid_params")
	if _, err := os.Stat(filepath.Join(home, "sites/up2.bin")); err == nil {
		t.Fatal("upload sai kích thước không được để lại file")
	}
	// write_stream gzip + cat tự giải nén
	_, err = Serve(Request{Op: "write_stream", Home: home, Params: []byte(`{"target":"sites/dump.sql.gz","gzip":true}`)},
		strings.NewReader("CREATE TABLE t (id int);\n"), nil, nil)
	must(t, err)
	var buf bytes.Buffer
	_, err = Serve(Request{Op: "cat", Home: home, Params: []byte(`{"path":"sites/dump.sql.gz"}`)}, nil, &buf, nil)
	must(t, err)
	if buf.String() != "CREATE TABLE t (id int);\n" {
		t.Fatalf("cat gzip sai: %q", buf.String())
	}
}

func TestHelperRefusesRoot(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("chỉ kiểm khi chạy bằng root")
	}
	var out, errb bytes.Buffer
	if code := HelperMain(strings.NewReader(`{"op":"list","home":"/home/anphat","params":{"path":"."}}`+"\n"), &out, &errb); code != 2 {
		t.Fatalf("helper chạy bằng root phải thoát 2, nhận %d (%s)", code, errb.String())
	}
}

func FuzzCheckPath(f *testing.F) {
	for _, s := range []string{".", "a/b", "../x", "/etc", "a/./b", "a//b", "tên có dấu.txt"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, p string) {
		if CheckPath(p) != nil {
			return
		}
		if strings.HasPrefix(p, "/") || strings.Contains("/"+p+"/", "/../") || strings.ContainsRune(p, 0) {
			t.Fatalf("CheckPath nhận đường dẫn nguy hiểm: %q", p)
		}
	})
}
