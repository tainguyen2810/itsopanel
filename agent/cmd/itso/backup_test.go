package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackupCLIArgs(t *testing.T) {
	root := t.TempDir()
	kit := filepath.Join(t.TempDir(), "kit.txt")
	_ = os.WriteFile(kit, []byte("destination: Local (local)\ndestination_uuid: 0193bb10-0001-7000-8000-000000000003\nrepositories:\n- Server\n"+
		"  repo: itso/0193aa10-0001-7000-8000-000000000001/server\n  password: Rk7-panel-9fQ2-xV4m-T8sL\n"), 0o600)
	base := []string{"--root", root, "--sandbox", "backup"}
	for _, tc := range []struct {
		args []string
		code int
		want string
	}{
		{[]string{}, 2, "Dùng:"},
		{[]string{"nuke"}, 2, "Dùng:"},
		{[]string{"prune"}, 2, "Dùng:"},
		{[]string{"prune", "--kit", kit, "--dry-run"}, 1, "--keep-"},
		{[]string{"prune", "--kit", kit, "--keep-daily", "-1"}, 1, "0–1000"},
		{[]string{"panel-restore", "--kit", kit, "--snapshot", "latest"}, 1, "snapshot id"},
		{[]string{"panel-restore", "--kit", kit, "--snapshot", strings.Repeat("a", 64)}, 1, "panel_private_key"},
	} {
		var out, errw bytes.Buffer
		if code := run(context.Background(), append(append([]string{}, base...), tc.args...), &out, &errw); code != tc.code ||
			!strings.Contains(out.String()+errw.String(), tc.want) {
			t.Fatalf("%v: code %d, out %q err %q", tc.args, code, out.String(), errw.String())
		}
	}
}
