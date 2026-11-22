package ops

import (
	"context"
	"strings"

	"itso.local/agent/internal/compose"
	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/platform"
)

// dockerCLI mô phỏng `docker [--config d] compose -p P --project-directory D -f F --env-file E <lệnh>` trên docker.Fake
// (sandbox/test). Đọc compose.yaml qua FS giả.
func (s *Sim) dockerCLI(c platform.Cmd) platform.Result {
	a := c.Args
	if len(a) >= 2 && a[0] == "--config" {
		a = a[2:]
	}
	if len(a) == 0 || a[0] != "compose" {
		return fail(1, "docker: chỉ mô phỏng compose")
	}
	a = a[1:]
	if len(a) >= 2 && a[0] == "version" {
		return ok("2.27.1\n")
	}
	if s.Docker == nil {
		return fail(1, "Cannot connect to the Docker daemon")
	}
	var project, file string
	for len(a) >= 2 && strings.HasPrefix(a[0], "-") {
		switch a[0] {
		case "-p":
			project = a[1]
		case "-f":
			file = a[1]
		}
		a = a[2:]
	}
	if project == "" || file == "" || len(a) == 0 {
		return fail(1, "docker compose: thiếu -p/-f/lệnh")
	}
	uuid := strings.TrimPrefix(project, "itso_")
	cmd, rest := a[0], a[1:]
	var flags, names []string
	for _, x := range rest {
		if strings.HasPrefix(x, "-") {
			flags = append(flags, x)
		} else {
			names = append(names, x)
		}
	}
	has := func(f string) bool {
		for _, x := range flags {
			if x == f {
				return true
			}
		}
		return false
	}
	switch cmd {
	case "down":
		s.Docker.ComposeDown(project, nil, has("-v"))
		return ok("")
	}
	y, err := s.FS.ReadFile(file)
	if err != nil {
		return fail(14, "open "+file+": no such file")
	}
	svcs, err := compose.Services(y)
	if err != nil {
		return fail(15, err.Error())
	}
	switch cmd {
	case "pull":
		for _, sv := range svcs {
			if err := s.Docker.Pull(context.Background(), sv.Image, nil); err != nil {
				return fail(18, err.Error())
			}
		}
		return ok("")
	case "up":
		var specs []docker.ServiceSpec
		keep := map[string]bool{}
		for _, sv := range svcs {
			keep[sv.Name] = true
			if len(names) > 0 && !contains(names, sv.Name) {
				continue
			}
			sp := docker.ServiceSpec{Name: sv.Name, Image: sv.Image, Volumes: sv.Volumes,
				Labels: map[string]string{docker.LabelProject: uuid, docker.LabelService: sv.Name}}
			for _, p := range sv.Ports {
				sp.Ports = append(sp.Ports, docker.Port{IP: "127.0.0.1", PrivatePort: p.ContainerPort, PublicPort: p.HostPort, Type: p.Protocol})
			}
			specs = append(specs, sp)
		}
		if has("--remove-orphans") {
			s.Docker.ComposeDown(project, keep, false)
		}
		if err := s.Docker.ComposeUp(project, specs); err != nil {
			return fail(1, err.Error())
		}
		return ok("")
	}
	return fail(1, "docker compose: lệnh "+cmd+" không mô phỏng")
}
