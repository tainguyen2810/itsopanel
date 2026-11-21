// Package policy đọc chính sách cục bộ của agent (/etc/itso/agent-policy.yaml, root:root 0600).
// Chính sách cục bộ thắng panel: op bị tắt ở đây thì panel không bật được (06-AGENT-SECURITY §1.5).
package policy

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"gopkg.in/yaml.v3"

	"itso.local/agent/internal/contracts"
)

// DefaultPath là vị trí trên máy thật.
const DefaultPath = "/etc/itso/agent-policy.yaml"

// File là nội dung YAML.
type File struct {
	Version      int  `yaml:"version"`
	RootTerminal bool `yaml:"root_terminal"`
	Docker       bool `yaml:"docker"`
	BackupForget bool `yaml:"backup_forget"`
	// AcmePebble cho phép cert.issue dùng directory "pebble" (chỉ VM/CI, D-69).
	AcmePebble bool            `yaml:"acme_pebble"`
	Ops        map[string]bool `yaml:"ops,omitempty"`
}

// Policy là chính sách đã nạp.
type Policy struct {
	File File
	cat  *contracts.Schemas
}

// Default trả chính sách mặc định (theo catalog; root terminal, docker, backup.forget tắt).
func Default() (*Policy, error) {
	cat, err := contracts.Load()
	if err != nil {
		return nil, err
	}
	return &Policy{File: File{Version: 1}, cat: cat}, nil
}

// Load đọc file. strict: file phải là file thường, chủ uid 0, quyền 0600 (máy thật).
// File không tồn tại → mặc định.
func Load(path string, strict bool) (*Policy, error) {
	p, err := Default()
	if err != nil {
		return nil, err
	}
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("policy %s phải là file thường", path)
	}
	if strict {
		st := fi.Sys().(*syscall.Stat_t)
		if st.Uid != 0 || fi.Mode().Perm() != 0o600 {
			return nil, fmt.Errorf("policy %s phải thuộc root và quyền 0600 (hiện uid %d, %o)", path, st.Uid, fi.Mode().Perm())
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	var f File
	if err := dec.Decode(&f); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("policy %s: %w", path, err)
	}
	if f.Version != 1 {
		return nil, fmt.Errorf("policy %s: version phải là 1", path)
	}
	for op := range f.Ops {
		if !p.cat.InCatalog(op) {
			return nil, fmt.Errorf("policy %s: op lạ %q", path, op)
		}
	}
	p.File = f
	return p, nil
}

// Enabled cho biết op có được phép không. Thứ tự: cờ đặc biệt (chỉ có thể tắt thêm) → ops → mặc định catalog.
func (p *Policy) Enabled(op string) bool {
	e, ok := p.cat.Catalog(op)
	if !ok {
		return false
	}
	if gate, special := p.gate(op); special && !gate {
		return false
	}
	if v, set := p.File.Ops[op]; set {
		return v
	}
	if _, special := p.gate(op); special {
		return true // cờ đặc biệt đã bật
	}
	return e.Default
}

// gate trả giá trị cờ đặc biệt áp cho op (nếu có).
func (p *Policy) gate(op string) (bool, bool) {
	switch {
	case op == "backup.forget":
		return p.File.BackupForget, true
	case strings.HasPrefix(op, "docker.") || strings.HasPrefix(op, "compose."):
		return p.File.Docker, true
	case op == "pty.open.root":
		return p.File.RootTerminal, true
	}
	return false, false
}

// Set đổi một khóa: root_terminal | docker | backup_forget | ops.<op>.
func (p *Policy) Set(key string, value bool) error {
	switch key {
	case "root_terminal":
		p.File.RootTerminal = value
	case "docker":
		p.File.Docker = value
	case "backup_forget":
		p.File.BackupForget = value
	default:
		op, ok := strings.CutPrefix(key, "ops.")
		if !ok || !p.cat.InCatalog(op) {
			return fmt.Errorf("khóa policy lạ %q", key)
		}
		if p.File.Ops == nil {
			p.File.Ops = map[string]bool{}
		}
		p.File.Ops[op] = value
	}
	return nil
}

// Keys liệt kê các khóa và giá trị hiệu lực (cho `itso policy get`).
func (p *Policy) Keys() []string {
	out := []string{
		fmt.Sprintf("root_terminal=%t", p.File.RootTerminal),
		fmt.Sprintf("docker=%t", p.File.Docker),
		fmt.Sprintf("backup_forget=%t", p.File.BackupForget),
	}
	ops := make([]string, 0, len(p.File.Ops))
	for op, v := range p.File.Ops {
		ops = append(ops, fmt.Sprintf("ops.%s=%t", op, v))
	}
	sort.Strings(ops)
	return append(out, ops...)
}

// Save ghi file atomic với quyền 0600.
func (p *Policy) Save(path string) error {
	p.File.Version = 1
	b, err := yaml.Marshal(p.File)
	if err != nil {
		return err
	}
	b = append([]byte("# Chính sách cục bộ ITSO agent. Chỉ sửa bằng `itso policy set` (root).\n"), b...)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".policy-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
