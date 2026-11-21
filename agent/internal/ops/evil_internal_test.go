package ops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

type vectors struct {
	Categories map[string]struct {
		Vectors []struct {
			Input  string `json:"input"`
			Expect string `json:"expect"`
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
		"recipe":       {{d.softwareInstall, func(s string) map[string]any { return map[string]any{"recipe": s} }}, {d.softwareRemove, func(s string) map[string]any { return map[string]any{"recipe": s} }}},
	}
	n := 0
	for cat, hs := range cases {
		for _, x := range v.Categories[cat].Vectors {
			if x.Expect != "reject" {
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
