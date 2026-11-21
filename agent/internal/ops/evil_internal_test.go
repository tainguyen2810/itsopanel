package ops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

type vectors struct {
	Categories map[string]struct {
		Vectors []struct {
			Raw    json.RawMessage `json:"input"`
			Input  string          `json:"-"`
			Expect string          `json:"expect"`
		} `json:"vectors"`
	} `json:"categories"`
}

// Vector độc gọi THẲNG handler (bỏ qua schema, như khi schema bị nới): phải bị từ chối trước khi chạy bất kỳ lệnh nào.
func TestEvilInputsRejectedBeforeAnyCommand(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "test-vectors", "evil-inputs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	fake := platform.NewFake()
	d := &Deps{Run: fake, FS: platform.NewFS(t.TempDir(), true)}
	acct := map[string]any{"username": "lehoa", "uid": 20001}
	vhost := func(k string, v any) map[string]any {
		m := map[string]any{"account": acct, "website_uuid": "01938a06-0002-7000-8000-000006000002", "site_dir": "lehoa.vn", "type": "static",
			"server_names": []any{"lehoa.vn"}, "document_root": "public"}
		m[k] = v
		return m
	}
	pool := func(k string, v any) map[string]any {
		m := map[string]any{"account": acct, "website_uuid": "01938a06-0002-7000-8000-000006000002", "site_dir": "lehoa.vn", "version": "8.3",
			"pm_max_children": 4, "memory_limit": "128m", "max_execution_time": 30, "upload_max_filesize": "16m", "disable_functions": []any{}}
		m[k] = v
		return m
	}
	issue := func(k string, v any) map[string]any {
		m := map[string]any{"account": acct, "website_uuid": "01938a06-0002-7000-8000-000006000002", "cert_uuid": "01938a0c-0001-7000-8000-00000c000001",
			"site_dir": "lehoa.vn", "domains": []any{"lehoa.vn"}, "challenge": "http-01", "email": "it@lehoa.vn", "directory": "letsencrypt", "renew": false}
		m[k] = v
		return m
	}
	limits := map[string]any{"disk_mb": 1024, "inode_limit": 1000, "cpu_percent": 100, "ram_mb": 512, "tasks_max": 64, "io_weight": 100}
	cases := map[string][]struct {
		h      registry.Handler
		params func(s string) map[string]any
	}{
		"username": {
			{d.accountEnsure, func(s string) map[string]any {
				return map[string]any{"account": map[string]any{"username": s, "uid": 20001}, "home_path": "/home/" + s, "shell": "/usr/sbin/nologin", "limits": limits}
			}},
			{d.accountLimitsApply, func(s string) map[string]any {
				return map[string]any{"account": map[string]any{"username": s, "uid": 20001}, "limits": limits}
			}},
			{d.accountSuspend, func(s string) map[string]any {
				return map[string]any{"account": map[string]any{"username": s, "uid": 20001}, "reason": "x"}
			}},
			{d.quotaApply, func(s string) map[string]any {
				return map[string]any{"account": map[string]any{"username": s, "uid": 20001}, "limits": limits}
			}},
			{d.quotaReport, func(s string) map[string]any {
				return map[string]any{"accounts": []any{map[string]any{"username": s, "uid": 20001}}}
			}},
		},
		"hostname":     {{d.hostnameSet, func(s string) map[string]any { return map[string]any{"hostname": s} }}},
		"service_name": {{d.serviceControl, func(s string) map[string]any { return map[string]any{"name": s, "action": "restart"} }}, {d.serviceStatus, func(s string) map[string]any { return map[string]any{"names": []any{s}} }}},
		"domain": {
			{d.siteLayoutEnsure, func(s string) map[string]any { return map[string]any{"account": acct, "site_dir": s} }},
			{d.vhostApply, func(s string) map[string]any { return vhost("server_names", []any{s}) }},
			{d.vhostApply, func(s string) map[string]any { return vhost("redirect_names", []any{s}) }},
			{d.certIssue, func(s string) map[string]any { return issue("domains", []any{s}) }},
			{d.logTail, func(s string) map[string]any {
				return map[string]any{"account": acct, "site_dir": s, "kind": "access", "lines": 10}
			}},
		},
		"path":         {{d.vhostApply, func(s string) map[string]any { return vhost("document_root", s) }}},
		"header_value": {{d.vhostApply, func(s string) map[string]any { return vhost("extra_headers", map[string]any{"X-Test": s}) }}},
		"url_path": {{d.vhostApply, func(s string) map[string]any {
			return vhost("redirects", []any{map[string]any{"from": s, "to": "https://a.vn/", "code": "301"}})
		}}},
		"redirect_target": {{d.vhostApply, func(s string) map[string]any {
			return vhost("redirects", []any{map[string]any{"from": "/a", "to": s, "code": "301"}})
		}}},
		"nginx_size": {
			{d.vhostApply, func(s string) map[string]any { return vhost("client_max_body_size", s) }},
			{d.phpPoolApply, func(s string) map[string]any { return pool("memory_limit", s) }},
			{d.nginxGlobalApply, func(s string) map[string]any {
				return map[string]any{"worker_processes": "auto", "worker_connections": 1024, "client_max_body_size": s, "gzip": true, "http2": true, "server_tokens": false}
			}},
		},
		"php_version": {
			{d.phpPoolApply, func(s string) map[string]any { return pool("version", s) }},
			{d.phpVersionInstall, func(s string) map[string]any { return map[string]any{"version": s, "extensions": []any{}} }},
			{d.phpVersionRemove, func(s string) map[string]any { return map[string]any{"version": s} }},
		},
		"php_extension": {
			{d.phpExtInstall, func(s string) map[string]any { return map[string]any{"version": "8.3", "extensions": []any{s}} }},
			{d.phpVersionInstall, func(s string) map[string]any { return map[string]any{"version": "8.3", "extensions": []any{s}} }},
		},
		"email":  {{d.certIssue, func(s string) map[string]any { return issue("email", s) }}},
		"recipe": {{d.softwareInstall, func(s string) map[string]any { return map[string]any{"recipe": s} }}, {d.softwareRemove, func(s string) map[string]any { return map[string]any{"recipe": s} }}},
	}
	n := 0
	for cat, hs := range cases {
		for _, x := range v.Categories[cat].Vectors {
			if x.Expect != "reject" || json.Unmarshal(x.Raw, &x.Input) != nil {
				continue
			}
			for _, c := range hs {
				fake.Reset()
				raw, _ := json.Marshal(c.params(x.Input))
				_, err := c.h(context.Background(), &envelope.Envelope{OpID: "t", Params: raw})
				if err == nil {
					t.Errorf("%s %q: phải bị từ chối", cat, x.Input)
				}
				if l := fake.Lines(); len(l) != 0 {
					t.Errorf("%s %q: đã chạy lệnh trước khi từ chối: %v", cat, x.Input, l)
				}
				n++
			}
		}
	}
	if n < 40 {
		t.Fatalf("quá ít ca vector độc: %d", n)
	}
	// UID ngoài dải và home_path lệch cũng bị chặn trước lệnh.
	for _, p := range []map[string]any{
		{"account": map[string]any{"username": "lehoa", "uid": 0}, "home_path": "/home/lehoa", "shell": "/bin/bash", "limits": limits},
		{"account": map[string]any{"username": "lehoa", "uid": 20001}, "home_path": "/home/lehoa/../../etc", "shell": "/bin/bash", "limits": limits},
		{"account": map[string]any{"username": "lehoa", "uid": 20001}, "home_path": "/home/lehoa", "shell": "/usr/bin/fish", "limits": limits},
	} {
		fake.Reset()
		raw, _ := json.Marshal(p)
		if _, err := d.accountEnsure(context.Background(), &envelope.Envelope{Params: raw}); err == nil || len(fake.Lines()) != 0 {
			t.Errorf("%v: phải bị từ chối trước lệnh (err=%v, lệnh=%v)", p, err, fake.Lines())
		}
	}
}

// Gốc sandbox trống vẫn có user/group root như Ubuntu (sshd.config.apply cần user quản trị); không ghi đè, không lặp.
func TestSimSeedBase(t *testing.T) {
	fs := platform.NewFS(t.TempDir(), true)
	s := NewSim(fs)
	if r := s.write("/etc/passwd", []string{"anphat:x:20000:20000::/home/anphat:/bin/bash"}); r.ExitCode != 0 {
		t.Fatal(string(r.Stderr))
	}
	s.SeedBase()
	s.SeedBase()
	if got := s.lines("/etc/passwd"); len(got) != 2 || got[0] != "root:x:0:0:root:/root:/bin/bash" || !strings.HasPrefix(got[1], "anphat:") {
		t.Fatalf("passwd = %q", got)
	}
	if got := s.lines("/etc/group"); len(got) != 1 || got[0] != "root:x:0:" {
		t.Fatalf("group = %q", got)
	}
}
