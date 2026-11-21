package mock

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/ops"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Op dữ liệu hosting (Phase 6: File Manager, DB, SFTP/FTPS, SSH key, cron). Mock dùng lại đúng handler của agent thật
// chạy trên sandbox (runner giả + gốc thư mục tạm riêng), nên hành vi và mã lỗi trùng agent thật. Account trong bộ
// nhớ của mock được đồng bộ vào /etc/passwd + /home giả trước mỗi lời gọi.

func registerData(r *registry.Registry, acc *accountStore) error {
	root, err := os.MkdirTemp("", "itso-mock-data-")
	if err != nil {
		return err
	}
	fs := platform.NewFS(root, true)
	for p, body := range map[string]string{
		"/etc/passwd": "root:x:0:0:root:/root:/bin/bash\npostgres:x:114:121::/var/lib/postgresql:/bin/bash\n",
		"/etc/group":  "root:x:0:\nitso-sftp:x:990:\nitso-ssh:x:991:\nitso-suspended:x:992:\n",
		"/etc/shadow": "root:*:20000:0:99999:7:::\n",
	} {
		if err := os.MkdirAll(filepath.Join(root, filepath.Dir(p)), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(root, p), []byte(body), 0o644); err != nil {
			return err
		}
	}
	d := &ops.Deps{FS: fs, Sandbox: true}
	d.Run = ops.SandboxRunner(d)
	sync := func(env *envelope.Envelope) {
		var p struct {
			Account *contracts.Account `json:"account"`
		}
		if json.Unmarshal(env.Params, &p) != nil || p.Account == nil {
			return
		}
		acc.mu.Lock()
		a, ok := acc.accounts[p.Account.Username]
		acc.mu.Unlock()
		if !ok || a.UID != p.Account.UID {
			return // handler thật trả not_found / precondition_failed
		}
		u := string(p.Account.Username)
		home := filepath.Join(root, "home", u)
		if _, err := os.Stat(home); err == nil {
			return
		}
		_ = os.MkdirAll(filepath.Join(home, "sites"), 0o755)
		for _, l := range []struct{ f, line string }{
			{"/etc/passwd", fmt.Sprintf("%s:x:%d:%d::/home/%s:/usr/sbin/nologin\n", u, a.UID, a.UID, u)},
			{"/etc/group", fmt.Sprintf("%s:x:%d:\n", u, a.UID)},
			{"/etc/shadow", u + ":!:20000:0:99999:7:::\n"},
		} {
			b, _ := os.ReadFile(filepath.Join(root, l.f))
			if !strings.Contains(string(b), "\n"+u+":") {
				_ = os.WriteFile(filepath.Join(root, l.f), append(b, l.line...), 0o644)
			}
		}
	}
	for op, h := range ops.Phase6Ops(d) {
		h := h
		if err := r.Register(op, func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
			sync(env)
			return h(ctx, env)
		}); err != nil {
			return err
		}
	}
	return nil
}
