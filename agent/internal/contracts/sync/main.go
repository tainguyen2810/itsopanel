// Command sync sao chép schema agent-ops và demo-dataset từ contracts/ vào
// internal/contracts/data để nhúng (go:embed không đọc được ngoài module).
// Chạy: go generate ./internal/contracts (từ thư mục agent/).
package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	src := filepath.Join("..", "..", "contracts")
	dst := "data"
	if len(os.Args) == 3 {
		src, dst = os.Args[1], os.Args[2]
	}
	if err := run(src, dst); err != nil {
		fmt.Fprintln(os.Stderr, "sync:", err)
		os.Exit(1)
	}
}

func run(src, dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	for _, f := range Files(src) {
		b, err := os.ReadFile(filepath.Join(src, f))
		if err != nil {
			return err
		}
		out := filepath.Join(dst, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(out, b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// Files liệt kê (đường dẫn tương đối, dạng slash) các file cần nhúng.
func Files(src string) []string {
	files := []string{"examples/demo-dataset.json", "agent-ops/catalog.json"}
	_ = filepath.WalkDir(filepath.Join(src, "agent-ops"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".schema.json") {
			rel, _ := filepath.Rel(src, p)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	return files
}
