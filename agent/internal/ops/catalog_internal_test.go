package ops

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"itso.local/agent/internal/validate"
)

// Bản seed của panel (SoftwareCatalogSeeder) phải khớp catalog trong agent: cùng recipe, nhóm, kho, dịch vụ, lõi,
// xung đột, phụ thuộc, gói (D-100). Catalog agent là nguồn sự thật; seed chỉ để panel chạy được khi agent chưa trả lời.
func TestCatalogMatchesPanelSeed(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "api", "database", "seeders", "SoftwareCatalogSeeder.php"))
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`'([a-z0-9.+-]+)' => \['[^']*', '([a-z]+)', '[^']*', '([a-z-]+)', (null|'[a-z0-9-]+'), (true|false), \[([^\]]*)\], \[([^\]]*)\], \[([^\]]*)\]\]`)
	list := func(s string) string { return strings.NewReplacer("'", "", " ", "").Replace(s) }
	seen := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(string(b), -1) {
		k := m[1]
		seen[k] = true
		c, ok := catalog[k]
		if !ok {
			t.Errorf("seed có %s nhưng agent không có", k)
			continue
		}
		svc := strings.Trim(m[4], "'")
		if svc == "null" {
			svc = ""
		}
		if c.Category != m[2] || c.Source != m[3] || c.Service != svc || (m[5] == "true") != c.Core ||
			strings.Join(c.Conflicts, ",") != list(m[6]) || strings.Join(c.Requires, ",") != list(m[7]) ||
			strings.Join(validate.Recipes[k], ",") != list(m[8]) {
			t.Errorf("%s lệch: agent %+v gói %v; seed %v", k, c, validate.Recipes[k], m[2:])
		}
	}
	for k := range validate.Recipes {
		if _, ok := catalog[k]; !ok {
			t.Errorf("recipe %s thiếu siêu dữ liệu catalog", k)
		}
		if !seen[k] {
			t.Errorf("recipe %s thiếu trong seed panel", k)
		}
	}
}
