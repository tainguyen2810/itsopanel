// Package mock hiện thực op giả cho môi trường dev (Prompt 1.5).
// Dữ liệu lấy từ contracts/examples/demo-dataset.json (bản nhúng). Không đọc
// hay thay đổi gì trên máy thật, không chạy lệnh hệ thống.
package mock

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// Version của mock agent.
const Version = "0.1.0-mock"

type demoServer struct {
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`
	Kernel    string `json:"kernel"`
	Resources struct {
		CPUCores  int   `json:"cpu_cores"`
		RAMMB     int   `json:"ram_mb"`
		UptimeSec int64 `json:"uptime_sec"`
	} `json:"resources"`
}

// Register đăng ký các op giả vào registry.
func Register(r *registry.Registry, started time.Time) error {
	b, err := fs.ReadFile(contracts.FS(), "examples/demo-dataset.json")
	if err != nil {
		return err
	}
	var ds struct {
		Servers []demoServer `json:"servers"`
	}
	if err := json.Unmarshal(b, &ds); err != nil {
		return err
	}
	if len(ds.Servers) == 0 {
		return fmt.Errorf("demo-dataset: không có servers")
	}
	srv := ds.Servers[0]

	if err := r.Register("system.ping", func(context.Context, *envelope.Envelope) (map[string]any, error) {
		return map[string]any{"pong": true, "agent_version": Version, "mode": "mock"}, nil
	}); err != nil {
		return err
	}
	return r.Register("system.info", func(context.Context, *envelope.Envelope) (map[string]any, error) {
		return map[string]any{
			"os":         srv.OS,
			"kernel":     srv.Kernel,
			"hostname":   srv.Hostname,
			"uptime_sec": srv.Resources.UptimeSec + int64(time.Since(started).Seconds()),
			"cpu_cores":  srv.Resources.CPUCores,
			"ram_mb":     srv.Resources.RAMMB,
		}, nil
	})
}
