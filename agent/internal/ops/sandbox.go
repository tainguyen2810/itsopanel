package ops

import "itso.local/agent/internal/platform"

// SandboxRunner trả runner giả cho --sandbox: không chạy lệnh nào, trả kết quả hợp lý để
// luồng op chạy trọn (dev/e2e). Trạng thái giả (user, quota) suy ra từ gốc FS của sandbox.
func SandboxRunner(d *Deps) platform.Runner {
	f := platform.NewFake()
	f.Hook = func(c platform.Cmd) (platform.Result, bool) {
		return sandboxResponse(d, c)
	}
	return f
}

// sandboxResponse mô phỏng tối thiểu: lệnh ghi coi như thành công; lệnh đọc trả rỗng.
func sandboxResponse(_ *Deps, c platform.Cmd) (platform.Result, bool) {
	switch c.Bin {
	case "systemctl":
		if len(c.Args) > 0 && (c.Args[0] == "is-active" || c.Args[0] == "is-enabled") {
			return platform.Result{Stdout: []byte("active\n")}, true
		}
	case "dpkg-query":
		return platform.Result{ExitCode: 1, Stderr: []byte("no packages found")}, true
	case "findmnt":
		return platform.Result{Stdout: []byte("/ ext4 rw,relatime\n")}, true
	}
	return platform.Result{}, true
}
