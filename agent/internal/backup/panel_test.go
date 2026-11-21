package backup

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func TestPanelArchiveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	dump := filepath.Join(dir, "itso.dump")
	etc := filepath.Join(dir, "etc")
	_ = os.WriteFile(dump, []byte("PGDMP"), 0o600)
	_ = os.MkdirAll(filepath.Join(etc, "agent"), 0o700)
	_ = os.WriteFile(filepath.Join(etc, "env"), []byte("APP_KEY=x"), 0o640)
	_ = os.WriteFile(filepath.Join(etc, "agent/hmac.key"), []byte("k"), 0o600)
	_ = os.Symlink("/etc/shadow", filepath.Join(etc, "evil"))
	files, err := PanelFiles(dump, etc)
	if err != nil || len(files) != 3 {
		t.Fatal(files, err)
	}
	id, _ := age.GenerateX25519Identity()
	var buf bytes.Buffer
	if err := WritePanelArchive(&buf, id.Recipient().String(), files, time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(buf.Bytes(), []byte("APP_KEY")) || !bytes.HasPrefix(buf.Bytes(), []byte("age-encryption.org/v1")) {
		t.Fatal("archive phải mã hóa age")
	}
	if err := WritePanelArchive(&bytes.Buffer{}, "age1invalid", files, time.Now()); err == nil {
		t.Fatal("recipient sai phải lỗi")
	}
	out := filepath.Join(t.TempDir(), "x")
	_ = os.Mkdir(out, 0o700)
	names, err := ExtractPanelArchive(bytes.NewReader(buf.Bytes()), id.String(), out, 1<<20)
	if err != nil || strings.Join(names, ",") != "itso.dump,etc/itso/agent/hmac.key,etc/itso/env" {
		t.Fatal(names, err)
	}
	if st, _ := os.Stat(filepath.Join(out, "etc/itso/env")); st.Mode().Perm()&0o077 != 0 {
		t.Fatal("file giải ra chỉ chủ đọc được", st.Mode())
	}
	other, _ := age.GenerateX25519Identity()
	if _, err := ExtractPanelArchive(bytes.NewReader(buf.Bytes()), other.String(), t.TempDir(), 1<<20); err == nil {
		t.Fatal("khóa sai phải lỗi")
	}
	if _, err := ExtractPanelArchive(bytes.NewReader(buf.Bytes()), id.String(), t.TempDir(), 3); err == nil {
		t.Fatal("vượt giới hạn phải lỗi")
	}
	// tar độc: tên .. hoặc symlink
	for _, h := range []*tar.Header{{Name: "../evil", Typeflag: tar.TypeReg, Size: 1}, {Name: "x", Typeflag: tar.TypeSymlink, Linkname: "/etc"}} {
		var enc bytes.Buffer
		w, _ := age.Encrypt(&enc, id.Recipient())
		tw := tar.NewWriter(w)
		_ = tw.WriteHeader(h)
		if h.Size > 0 {
			_, _ = tw.Write([]byte("x"))
		}
		_ = tw.Close()
		_ = w.Close()
		if _, err := ExtractPanelArchive(&enc, id.String(), t.TempDir(), 1<<20); err == nil {
			t.Fatal("mục lạ phải bị từ chối: " + h.Name)
		}
	}
}

func TestParseKit(t *testing.T) {
	text := "# ITSO Panel recovery kit\n# generated_at: 2026-11-21\ndestination: Off-site B2 (s3)\ndestination_uuid: 0193bb10-0001-7000-8000-000000000003\n" +
		"  endpoint: https://s3.example.com\n  bucket: itso-backup\nrepositories:\n- Server\n  repo: itso/0193aa10-0001-7000-8000-000000000001/server\n  password: Rk7-panel-9fQ2-xV4m-T8sL\n" +
		"- anphat\n  repo: itso/0193aa10-0001-7000-8000-000000000001/acct-01938a01-0003-7000-8000-000000000020\n  password: Zz7-panel-9fQ2-xV4m-T8sL\n" +
		"panel_public_key: age1abc\npanel_private_key: AGE-SECRET-KEY-1XYZ\n"
	k, err := ParseKit(strings.ReplaceAll(text, "\n", "\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if k.DestName != "Off-site B2" || k.DestType != "s3" || k.Config["bucket"] != "itso-backup" || len(k.Repos) != 2 ||
		k.Repos[1].Label != "anphat" || k.PrivateKey != "AGE-SECRET-KEY-1XYZ" || k.DestinationUUID == "" {
		t.Fatalf("%+v", k)
	}
	if _, err := ParseKit(strings.Replace(text, "itso/0193aa10", "../etc", 1)); err == nil {
		t.Fatal("đường dẫn repo lạ phải bị từ chối")
	}
	if _, err := ParseKit("destination: x (local)\n"); err == nil {
		t.Fatal("thiếu repo phải lỗi")
	}
}
