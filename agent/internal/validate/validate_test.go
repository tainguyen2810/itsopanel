package validate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type vectors struct {
	Categories map[string]struct {
		Vectors []struct {
			Input  string `json:"input"`
			Expect string `json:"expect"`
			Layer  string `json:"layer"`
			Note   string `json:"note"`
		} `json:"vectors"`
	} `json:"categories"`
}

func loadVectors(t *testing.T) vectors {
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../contracts/test-vectors/evil-inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// Vector dùng chung PHP/Go: tầng Go phải từ chối mọi vector "reject" (kể cả layer semantic) của các nhóm agent dùng.
func TestEvilVectors(t *testing.T) {
	v := loadVectors(t)
	check := map[string]func(string) error{
		"username":     Username,
		"hostname":     Hostname,
		"service_name": Service,
		"recipe":       func(s string) error { _, err := Recipe(s); return err },
	}
	for cat, fn := range check {
		c, ok := v.Categories[cat]
		if !ok {
			t.Fatalf("thiếu nhóm vector %s", cat)
		}
		for _, x := range c.Vectors {
			err := fn(x.Input)
			if x.Expect == "reject" && err == nil {
				t.Errorf("%s: %q phải bị từ chối (%s)", cat, x.Input, x.Note)
			}
			if x.Expect == "accept" && err != nil {
				t.Errorf("%s: %q phải được chấp nhận: %v", cat, x.Input, err)
			}
		}
	}
}

func TestUIDAndSlice(t *testing.T) {
	for _, u := range []int64{19999, 60000, 0, -1} {
		if UID(u) == nil {
			t.Errorf("uid %d phải bị từ chối", u)
		}
	}
	s, err := SliceName(20001)
	if err != nil || s != "itso-acct-20001.slice" {
		t.Fatalf("slice = %q, %v", s, err)
	}
}

func TestLimits(t *testing.T) {
	ok := Limits{DiskMB: 1024, InodeLimit: 100000, CPUPercent: 100, RAMMB: 512, TasksMax: 128, IOWeight: 100}
	if err := ok.Check(); err != nil {
		t.Fatal(err)
	}
	bad := ok
	bad.RAMMB = 10
	if bad.Check() == nil {
		t.Fatal("ram 10 MB phải bị từ chối")
	}
	zero := int64(0)
	bad = ok
	bad.IOReadBps = &zero
	if bad.Check() == nil {
		t.Fatal("io_read_bps 0 phải bị từ chối")
	}
}

func FuzzUsername(f *testing.F) {
	for _, s := range []string{"anphat", "root", "a;b", "A", "ab\n", "a\x00b"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if Username(s) == nil && !reUsername.MatchString(s) {
			t.Fatalf("chấp nhận %q sai mẫu", s)
		}
		if Username(s) == nil && reserved[s] {
			t.Fatalf("chấp nhận tên dành riêng %q", s)
		}
	})
}

func FuzzHostname(f *testing.F) {
	for _, s := range []string{"srv01", "a.b.c", "-x", "x;y", "x\ny"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if Hostname(s) == nil {
			for _, r := range s {
				if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.') {
					t.Fatalf("chấp nhận ký tự %q trong %q", r, s)
				}
			}
		}
	})
}
