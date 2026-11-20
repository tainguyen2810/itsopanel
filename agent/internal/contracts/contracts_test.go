package contracts

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// Bản nhúng phải trùng byte với contracts/ (nguồn sự thật). Nếu lệch: go generate ./internal/contracts.
func TestEmbeddedCopyMatchesContracts(t *testing.T) {
	src := filepath.Join("..", "..", "..", "contracts")
	if _, err := os.Stat(src); err != nil {
		t.Skip("không có contracts/ cạnh agent/ (build ngoài monorepo)")
	}
	seen := map[string]bool{}
	err := fs.WalkDir(FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		seen[p] = true
		want, err := os.ReadFile(filepath.Join(src, filepath.FromSlash(p)))
		if err != nil {
			t.Errorf("%s: có trong bản nhúng nhưng không có ở contracts/: %v", p, err)
			return nil
		}
		got, _ := fs.ReadFile(FS(), p)
		if !bytes.Equal(got, want) {
			t.Errorf("%s lệch với contracts/ — chạy: go generate ./internal/contracts", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = filepath.WalkDir(filepath.Join(src, "agent-ops"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && filepath.Ext(p) == ".json" && filepath.Base(filepath.Dir(p)) != "examples" {
			rel, _ := filepath.Rel(src, p)
			if base := filepath.Base(p); base != "errors.json" && base != "README.md" && !seen[filepath.ToSlash(rel)] {
				t.Errorf("%s chưa được nhúng — chạy: go generate ./internal/contracts", rel)
			}
		}
		return nil
	})
}

func TestLoadCompilesEveryOpSchema(t *testing.T) {
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for op, e := range s.catalog {
		if e.Status != "specified" {
			continue
		}
		if _, err := s.OpResult(op); err != nil {
			t.Errorf("%s: %v", op, err)
		}
	}
}
