package platform

import (
	"context"
	"strings"
	"sync"
)

// FakeRunner ghi lại argv và trả kết quả lập trình sẵn (test, chế độ --sandbox). Không chạy gì.
type FakeRunner struct {
	mu    sync.Mutex
	Calls []Cmd
	// Responses: khóa là "bin arg1 arg2…" hoặc tiền tố "bin " (khớp dài nhất thắng).
	Responses map[string]Result
	// Hook (tùy chọn) mô phỏng tác dụng phụ, ví dụ ghi file /etc/passwd trong gốc giả.
	Hook func(c Cmd) (Result, bool)
}

// NewFake tạo FakeRunner rỗng.
func NewFake() *FakeRunner { return &FakeRunner{Responses: map[string]Result{}} }

// Run kiểm Cmd như runner thật rồi ghi lại.
func (f *FakeRunner) Run(_ context.Context, c Cmd) (Result, error) {
	if _, err := Check(c); err != nil {
		return Result{ExitCode: -1}, err
	}
	f.mu.Lock()
	f.Calls = append(f.Calls, Cmd{Bin: c.Bin, Args: append([]string(nil), c.Args...), Stdin: c.Stdin, As: c.As, Env: append([]string(nil), c.Env...)})
	hook := f.Hook
	f.mu.Unlock()
	if hook != nil {
		if r, ok := hook(c); ok {
			return r, nil
		}
	}
	full := c.String()
	best, bestLen := Result{}, -1
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, r := range f.Responses {
		if (full == k || strings.HasPrefix(full, k+" ") || (strings.HasSuffix(k, " ") && strings.HasPrefix(full, k))) && len(k) > bestLen {
			best, bestLen = r, len(k)
		}
	}
	return best, nil
}

// Lines trả các lệnh đã chạy dạng chuỗi (cho golden test).
func (f *FakeRunner) Lines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.Calls))
	for i, c := range f.Calls {
		out[i] = c.String()
	}
	return out
}

// Reset xóa lịch sử lệnh.
func (f *FakeRunner) Reset() {
	f.mu.Lock()
	f.Calls = nil
	f.mu.Unlock()
}
