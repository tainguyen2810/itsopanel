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

	// Kết quả dùng struct sinh từ contracts (types_gen.go) để không lệch schema.
	if err := r.Register(contracts.OpSystemPing, func(context.Context, *envelope.Envelope) (map[string]any, error) {
		return toData(contracts.SystemPingResult{Pong: true, AgentVersion: Version, Mode: "mock"})
	}); err != nil {
		return err
	}
	return r.Register(contracts.OpSystemInfo, func(context.Context, *envelope.Envelope) (map[string]any, error) {
		return toData(contracts.SystemInfoResult{
			OS:        srv.OS,
			Kernel:    srv.Kernel,
			Hostname:  srv.Hostname,
			UptimeSec: srv.Resources.UptimeSec + int64(time.Since(started).Seconds()),
			CPUCores:  int64(srv.Resources.CPUCores),
			RAMMB:     int64(srv.Resources.RAMMB),
		})
	})
}

// toData chuyển struct kết quả có type thành map cho registry.Result.Data.
func toData(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	return m, json.Unmarshal(b, &m)
}
