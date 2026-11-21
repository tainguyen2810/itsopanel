package ops_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/ops"
)

// checkNginxShape: mọi dòng là chú thích, rỗng, hoặc kết thúc bằng ; { } và ngoặc cân bằng —
// giá trị người dùng không thể mở/đóng khối hay thêm directive.
func checkNginxShape(t *testing.T, conf string) {
	t.Helper()
	depth := 0
	for _, l := range strings.Split(conf, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		if !strings.HasSuffix(l, ";") && !strings.HasSuffix(l, "{") && l != "}" {
			t.Fatalf("dòng sai dạng: %q", l)
		}
		depth += strings.Count(l, "{") - strings.Count(l, "}")
		if depth < 0 || depth > 2 {
			t.Fatalf("độ sâu khối %d tại %q", depth, l)
		}
		if strings.Count(l, ";") > 1 {
			t.Fatalf("nhiều directive trên một dòng: %q", l)
		}
	}
	if depth != 0 {
		t.Fatalf("ngoặc lệch: %d", depth)
	}
}

func FuzzRenderVhost(f *testing.F) {
	f.Add("lehoa.vn", "public", "SAMEORIGIN", "/old", "https://lehoa.vn/x", "64m", "X-Frame-Options")
	f.Add("a.vn;}", "public/../..", "x\r\nSet-Cookie: a", "/a b", "javascript:alert(1)", "1g;", "Bad Header")
	f.Add("xn--bcher-kva.example", "public/web", "max-age=1; includeSubDomains", "/a{", "http://a.vn$host", "10", "X-A")
	f.Fuzz(func(t *testing.T, name, doc, hval, from, to, size, hname string) {
		sz := contracts.NginxSize(size)
		p := contracts.NginxVhostApplyParams{Account: contracts.Account{Username: "lehoa", UID: 20001},
			WebsiteUUID: "01938a06-0002-7000-8000-000006000002", SiteDir: "lehoa.vn", Type: "static",
			ServerNames: []contracts.Domain{contracts.Domain(name)}, DocumentRoot: contracts.RelPath(doc),
			ClientMaxBodySize: &sz, ExtraHeaders: map[string]contracts.HeaderValue{hname: contracts.HeaderValue(hval)},
			Redirects: []contracts.NginxVhostApplyParamsRedirectsItem{{From: contracts.URLPath(from), To: contracts.RedirectTarget(to), Code: "301"}}}
		conf, err := ops.RenderVhost(p)
		if err != nil {
			return
		}
		checkNginxShape(t, string(conf))
	})
}

func FuzzRenderPool(f *testing.F) {
	f.Add("lehoa.vn", "256m", "exec")
	f.Add("a.vn\n[x]", "1g\nphp_admin_value[open_basedir]=/", "exec\nx")
	f.Fuzz(func(t *testing.T, site, mem, fn string) {
		p := contracts.PHPPoolApplyParams{Account: contracts.Account{Username: "lehoa", UID: 20001},
			WebsiteUUID: "01938a06-0002-7000-8000-000006000002", SiteDir: contracts.Domain(site), Version: "8.3",
			PmMaxChildren: 4, MemoryLimit: contracts.NginxSize(mem), MaxExecutionTime: 30, UploadMaxFilesize: "16m", DisableFunctions: []string{fn}}
		conf, err := ops.RenderPool(p)
		if err != nil {
			return
		}
		for _, l := range strings.Split(string(conf), "\n") {
			if l == "" || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "[lehoa-") {
				continue
			}
			k, _, ok := strings.Cut(l, " = ")
			if !ok || strings.ContainsAny(k, " \t") && !strings.HasPrefix(k, "php_admin") {
				t.Fatalf("dòng pool sai dạng: %q", l)
			}
		}
		if strings.Count(string(conf), "open_basedir") != 1 {
			t.Fatal("open_basedir bị chèn thêm")
		}
	})
}

func TestGoldenVhostsShape(t *testing.T) {
	for _, n := range []string{"php", "static", "proxy", "suspended", "tls"} {
		checkNginxShape(t, readGolden(t, "vhost-"+n+".conf"))
	}
}

func readGolden(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "golden", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
