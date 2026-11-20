// Package contracts nhúng JSON Schema agent-ops (bản sao từ contracts/, nguồn sự thật)
// và cung cấp validator đã biên dịch.
package contracts

//go:generate go run ./sync ../../../contracts data

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// BaseID là tiền tố $id của mọi schema agent-ops.
const BaseID = "https://schemas.itso.local/agent-ops/"

//go:embed data
var data embed.FS

// FS trả về file nhúng (gốc = thư mục data).
func FS() fs.FS {
	sub, err := fs.Sub(data, "data")
	if err != nil {
		panic(err)
	}
	return sub
}

// CatalogEntry là một op trong catalog.json.
type CatalogEntry struct {
	Op         string `json:"op"`
	Domain     string `json:"domain"`
	Risk       string `json:"risk"`
	Phase      int    `json:"phase"`
	TimeoutSec int    `json:"timeout_sec"`
	Schema     string `json:"schema"`
	Status     string `json:"status"`
}

// Schemas gom các schema đã biên dịch.
type Schemas struct {
	Envelope *jsonschema.Schema
	Result   *jsonschema.Schema
	catalog  map[string]CatalogEntry
	compiler *jsonschema.Compiler
	mu       sync.Mutex
	opResult map[string]*jsonschema.Schema
}

var (
	loadOnce sync.Once
	loaded   *Schemas
	loadErr  error
)

// Load biên dịch schema một lần (an toàn đồng thời).
func Load() (*Schemas, error) {
	loadOnce.Do(func() { loaded, loadErr = load(FS()) })
	return loaded, loadErr
}

func load(fsys fs.FS) (*Schemas, error) {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	err := fs.WalkDir(fsys, "agent-ops", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".schema.json") {
			return err
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
		if err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		return c.AddResource(BaseID+strings.TrimPrefix(p, "agent-ops/"), doc)
	})
	if err != nil {
		return nil, err
	}
	s := &Schemas{compiler: c, opResult: map[string]*jsonschema.Schema{}, catalog: map[string]CatalogEntry{}}
	if s.Envelope, err = c.Compile(BaseID + "envelope.schema.json"); err != nil {
		return nil, err
	}
	if s.Result, err = c.Compile(BaseID + "result.schema.json"); err != nil {
		return nil, err
	}
	b, err := fs.ReadFile(fsys, "agent-ops/catalog.json")
	if err != nil {
		return nil, err
	}
	var cat struct {
		Ops []CatalogEntry `json:"ops"`
	}
	if err := json.Unmarshal(b, &cat); err != nil {
		return nil, err
	}
	for _, e := range cat.Ops {
		s.catalog[e.Op] = e
	}
	return s, nil
}

// InCatalog cho biết op có trong catalog không.
func (s *Schemas) InCatalog(op string) bool {
	_, ok := s.catalog[op]
	return ok
}

// Catalog trả về mục catalog của op.
func (s *Schemas) Catalog(op string) (CatalogEntry, bool) {
	e, ok := s.catalog[op]
	return e, ok
}

// OpResult trả về schema kết quả của một op (dùng để tự kiểm handler).
func (s *Schemas) OpResult(op string) (*jsonschema.Schema, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sch, ok := s.opResult[op]; ok {
		return sch, nil
	}
	sch, err := s.compiler.Compile(BaseID + "ops/" + op + ".schema.json#/$defs/result")
	if err != nil {
		return nil, err
	}
	s.opResult[op] = sch
	return sch, nil
}
