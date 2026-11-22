package ops_test

import (
	"context"
	"testing"

	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
)

// File điều khiển Engine giả (e2e stack thật): thế hệ mới → Publish trước pull; unhealthy → container bản mới báo lỗi.
func TestSandboxDockerControlFile(t *testing.T) {
	root := t.TempDir()
	d := &ops.Deps{FS: platform.NewFS(root, true), Sandbox: true}
	ops.SandboxRunner(d)
	fk := d.Docker.(*docker.Fake)
	ctx := context.Background()
	if err := fk.Pull(ctx, "nginx:1.27", nil); err != nil {
		t.Fatal(err)
	}
	first, _ := fk.ImageInspect(ctx, "nginx:1.27")
	write(t, root, "var/lib/itso-sandbox/docker-control.json", `{"publish":{"nginx:1.27":"2"},"unhealthy":true}`)
	_ = fk.Pull(ctx, "nginx:1.27", nil)
	second, _ := fk.ImageInspect(ctx, "nginx:1.27")
	_ = fk.Pull(ctx, "nginx:1.27", nil) // cùng thế hệ: không đổi nữa
	third, _ := fk.ImageInspect(ctx, "nginx:1.27")
	if first.ID == second.ID || second.ID != third.ID {
		t.Fatal("thế hệ mới phải đổi image đúng một lần", first.ID, second.ID, third.ID)
	}
	if fk.Health("app", second.ID) != "unhealthy" || fk.Health("app", first.ID) != "healthy" {
		t.Fatal("health theo file điều khiển sai")
	}
}
