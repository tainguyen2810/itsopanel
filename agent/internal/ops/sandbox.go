package ops

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"

	"itso.local/agent/internal/docker"
	"itso.local/agent/internal/platform"
)

// Sim mô phỏng tác dụng phụ của các lệnh trong bảng Bins lên gốc FS giả (sandbox và test):
// /etc/passwd, /etc/group, /etc/shadow, /etc/hostname, ACL, trạng thái unit, gói apt, quota.
// Không chạy lệnh nào. Lệnh lạ coi như thành công.
type Sim struct {
	FS *platform.FS
	// MountOptions: dòng findmnt trả về cho /home (mặc định có usrjquota → quota_mode "kernel").
	Mount string

	mu        sync.Mutex
	acl       map[string][]string
	active    map[string]bool
	installed map[string]string
	quota     map[string][4]string // uid → block soft/hard, inode soft/hard
	data      *dbSim               // DB, Pure-FTPd, sshd, systemd-run (Phase 6)
	sec       *secSim              // nft, fail2ban-client (Phase 7)
	// Docker: engine giả cho `docker compose` (Phase 10). Nil = docker chưa cài.
	Docker *docker.Fake
}

// NewSim tạo trình mô phỏng trên fs. Dịch vụ (.service, .timer) mặc định đang chạy; slice chưa chạy.
func NewSim(fs *platform.FS) *Sim {
	return &Sim{FS: fs, Mount: "/ ext4 rw,relatime,usrjquota=aquota.user,jqfmt=vfsv1",
		acl: map[string][]string{}, active: map[string]bool{}, installed: map[string]string{}, quota: map[string][4]string{}, data: newDBSim(), sec: &secSim{fs: fs}}
}

// SandboxRunner trả runner giả cho --sandbox: lệnh được kiểm như runner thật, ghi lại, và mô phỏng bằng Sim.
func SandboxRunner(d *Deps) *platform.FakeRunner {
	sim := NewSim(d.FS)
	sim.SeedBase()
	if d.Docker == nil {
		fk := docker.NewFake()
		fk.MkdirMount = func(p string) { _ = d.FS.MkdirAll(p) }
		d.Docker = fk
	}
	if fk, ok := d.Docker.(*docker.Fake); ok {
		sim.Docker = fk
	}
	f := platform.NewFake()
	f.Hook = sim.Handle
	f.StreamHook = sim.Stream
	return f
}

// SeedBase thêm các mục luôn có trên Ubuntu mà gốc sandbox trống thì thiếu: user/group root (user quản trị SSH
// mặc định của sshd.config.apply, ADR 0024). Không ghi đè mục đã có.
func (s *Sim) SeedBase() {
	for p, line := range map[string]string{"/etc/passwd": "root:x:0:0:root:/root:/bin/bash", "/etc/group": "root:x:0:"} {
		ls := s.lines(p)
		if !slices.ContainsFunc(ls, func(l string) bool { return strings.HasPrefix(l, "root:") }) {
			_ = s.write(p, append([]string{line}, ls...))
		}
	}
}

func ok(out string) platform.Result { return platform.Result{Stdout: []byte(out)} }

func fail(code int, msg string) platform.Result {
	return platform.Result{ExitCode: code, Stderr: []byte(msg)}
}

// Handle mô phỏng một lệnh. Luôn trả handled=true.
func (s *Sim) Handle(c platform.Cmd) (platform.Result, bool) {
	if c.Bin == "docker" {
		return s.dockerCLI(c), true
	}
	if r, handled := s.sec.handle(c); handled {
		return r, true
	}
	if r, handled := s.data.handle(c); handled {
		return r, true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a := c.Args
	last := ""
	if len(a) > 0 {
		last = a[len(a)-1]
	}
	switch c.Bin {
	case "groupadd":
		gid := flag(a, "-g")
		if gid == "" {
			gid = s.freeSystemID("/etc/group")
		}
		return s.appendLine("/etc/group", fmt.Sprintf("%s:x:%s:", last, gid)), true
	case "useradd":
		uid, gid := flag(a, "-u"), flag(a, "-g")
		if uid == "" { // -r: user hệ thống, uid tự cấp
			uid = s.freeSystemID("/etc/passwd")
		}
		if contains(a, "-U") {
			gid = uid
			if r := s.appendLine("/etc/group", fmt.Sprintf("%s:x:%s:", last, gid)); r.ExitCode != 0 {
				return r, true
			}
		}
		r := s.appendLine("/etc/passwd", fmt.Sprintf("%s:x:%s:%s:%s:%s:%s", last, uid, gid, flag(a, "-c"), flag(a, "-d"), flag(a, "-s")))
		if r.ExitCode == 0 {
			r = s.appendLine("/etc/shadow", last+":!:20000:0:99999:7:::")
		}
		return r, true
	case "usermod":
		return s.usermod(a), true
	case "userdel":
		return s.dropEntry(last, "/etc/passwd", "/etc/shadow"), true
	case "groupdel":
		return s.dropEntry(last, "/etc/group"), true
	case "gpasswd":
		if len(a) == 3 {
			return s.editGroup(a[2], a[1], a[0] == "-a"), true
		}
	case "getfacl":
		var b strings.Builder
		b.WriteString("user::rwx\n")
		var defs []string
		for _, e := range s.acl[last] {
			if strings.HasPrefix(e, "d:") {
				defs = append(defs, "default:user:"+strings.TrimPrefix(e, "d:u:"))
				continue
			}
			b.WriteString("user:" + strings.TrimPrefix(e, "u:") + "\n")
		}
		b.WriteString("group::r-x\nmask::r-x\nother::---\n")
		for _, x := range defs {
			b.WriteString(x + "\n")
		}
		return ok(b.String()), true
	case "setfacl":
		if len(a) == 3 && a[0] == "-m" {
			s.acl[last] = append(s.acl[last], a[1])
		}
	case "systemctl":
		return s.systemctl(a), true
	case "hostnamectl":
		if len(a) == 2 && a[0] == "set-hostname" {
			if _, err := s.FS.WriteAtomic("/etc/hostname", []byte(a[1]+"\n"), 0o644, platform.Owner{}); err != nil {
				return fail(1, err.Error()), true
			}
		}
	case "dpkg-query":
		if v, has := s.installed[last]; has {
			return ok("install ok installed\t" + v), true
		}
		return fail(1, "dpkg-query: no packages found matching "+last), true
	case "apt-get":
		if len(a) > 0 && (a[0] == "install" || a[0] == "remove") {
			for _, p := range a[1:] {
				if !strings.HasPrefix(p, "-") && !strings.HasPrefix(p, "Dpkg::") {
					if a[0] == "install" {
						s.installed[p] = "1.0-sandbox"
					} else {
						delete(s.installed, p)
					}
				}
			}
		}
	case "nginx":
		return s.nginxTest(), true
	case "php-fpm8.3":
		return ok("NOTICE: configuration file test is successful\n"), true
	case "lego":
		return s.lego(c), true
	case "findmnt":
		return ok(s.Mount + "\n"), true
	case "setquota":
		if len(a) == 7 {
			s.quota[a[1]] = [4]string{a[2], a[3], a[4], a[5]}
		}
	case "repquota":
		var b strings.Builder
		b.WriteString("User,BlockStatus,FileStatus,BlockUsed,BlockSoftLimit,BlockHardLimit,BlockGrace,FileUsed,FileSoftLimit,FileHardLimit,FileGrace\n")
		for _, uid := range sortedKeys(s.quota) {
			q := s.quota[uid]
			fmt.Fprintf(&b, "#%s,ok,ok,0,%s,%s,,1,%s,%s,\n", uid, q[0], q[1], q[2], q[3])
		}
		return ok(b.String()), true
	}
	return platform.Result{}, true
}

func (s *Sim) systemctl(a []string) platform.Result {
	if len(a) < 1 {
		return platform.Result{}
	}
	unit := ""
	if len(a) > 1 {
		unit = a[1]
	}
	if a[0] == "enable" || a[0] == "disable" { // enable/disable --now <unit>
		unit = a[len(a)-1]
	}
	isActive := s.active[unit]
	if _, set := s.active[unit]; !set && (strings.HasSuffix(unit, ".service") || strings.HasSuffix(unit, ".timer")) &&
		!strings.HasPrefix(unit, "itso-php@") { // master PHP của account chỉ chạy khi agent bật
		isActive = true
	}
	switch a[0] {
	case "is-active":
		if isActive {
			return ok("active\n")
		}
		return platform.Result{ExitCode: 3, Stdout: []byte("inactive\n")}
	case "is-enabled":
		return ok("enabled\n")
	case "start", "restart", "reload":
		s.active[unit] = true
	case "stop":
		s.active[unit] = false
	case "enable":
		if contains(a, "--now") {
			s.active[unit] = true
		}
	case "disable":
		if contains(a, "--now") {
			s.active[unit] = false
		}
	}
	return platform.Result{}
}

func flag(a []string, name string) string {
	for i := 0; i+1 < len(a); i++ {
		if a[i] == name {
			return a[i+1]
		}
	}
	return ""
}

func (s *Sim) lines(p string) []string {
	b, err := s.FS.ReadFile(p)
	if err != nil || len(b) == 0 {
		return nil
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func (s *Sim) write(p string, lines []string) platform.Result {
	mode := uint32(0o644)
	if p == "/etc/shadow" {
		mode = 0o640
	}
	if _, err := s.FS.WriteAtomic(p, []byte(strings.Join(lines, "\n")+"\n"), modeOf(mode), platform.Owner{}); err != nil {
		return fail(10, err.Error())
	}
	return platform.Result{}
}

func (s *Sim) appendLine(p, line string) platform.Result {
	name, _, _ := strings.Cut(line, ":")
	ls := s.lines(p)
	for _, l := range ls {
		if strings.HasPrefix(l, name+":") {
			return fail(9, fmt.Sprintf("%s: '%s' already exists", p, name))
		}
	}
	return s.write(p, append(ls, line))
}

func (s *Sim) freeSystemID(file string) string {
	used := map[string]bool{}
	for _, l := range append(s.lines("/etc/group"), s.lines(file)...) {
		if f := strings.Split(l, ":"); len(f) > 2 {
			used[f[2]] = true
		}
	}
	for g := 999; g > 100; g-- {
		if !used[strconv.Itoa(g)] {
			return strconv.Itoa(g)
		}
	}
	return "100"
}

func (s *Sim) editGroup(group, user string, add bool) platform.Result {
	ls := s.lines("/etc/group")
	for i, l := range ls {
		f := strings.Split(l, ":")
		if len(f) != 4 || f[0] != group {
			continue
		}
		var m []string
		if f[3] != "" {
			m = strings.Split(f[3], ",")
		}
		out := []string{}
		for _, x := range m {
			if x != user {
				out = append(out, x)
			}
		}
		if add {
			out = append(out, user)
		}
		f[3] = strings.Join(out, ",")
		ls[i] = strings.Join(f, ":")
		return s.write("/etc/group", ls)
	}
	return fail(3, "gpasswd: group '"+group+"' does not exist")
}

func (s *Sim) usermod(a []string) platform.Result {
	if len(a) == 0 {
		return fail(2, "usermod: thiếu tham số")
	}
	name := a[len(a)-1]
	pw := s.lines("/etc/passwd")
	found := false
	for i, l := range pw {
		f := strings.Split(l, ":")
		if len(f) == 7 && f[0] == name {
			found = true
			if sh := flag(a, "-s"); sh != "" {
				f[6] = sh
			}
			pw[i] = strings.Join(f, ":")
		}
	}
	if !found {
		return fail(6, "usermod: user '"+name+"' does not exist")
	}
	if r := s.write("/etc/passwd", pw); r.ExitCode != 0 {
		return r
	}
	sh := s.lines("/etc/shadow")
	for i, l := range sh {
		f := strings.Split(l, ":")
		if len(f) != 9 || f[0] != name {
			continue
		}
		for j, x := range a {
			switch x {
			case "-L":
				if !strings.HasPrefix(f[1], "!") {
					f[1] = "!" + f[1]
				}
			case "-U":
				f[1] = strings.TrimPrefix(f[1], "!")
			case "-e":
				if j+1 < len(a) {
					f[7] = a[j+1]
				}
			}
		}
		sh[i] = strings.Join(f, ":")
	}
	return s.write("/etc/shadow", sh)
}

// dropEntry mô phỏng userdel/groupdel: xóa dòng "<name>:" và tên khỏi danh sách thành viên group.
func (s *Sim) dropEntry(name string, files ...string) platform.Result {
	found := false
	for _, f := range files {
		var keep []string
		for _, l := range s.lines(f) {
			if strings.HasPrefix(l, name+":") {
				found = true
				continue
			}
			keep = append(keep, l)
		}
		if r := s.write(f, keep); r.ExitCode != 0 {
			return r
		}
	}
	if !found {
		return fail(6, "user/group "+name+" does not exist")
	}
	if files[0] == "/etc/passwd" {
		var keep []string
		for _, l := range s.lines("/etc/group") {
			f := strings.SplitN(l, ":", 4)
			if len(f) == 4 && f[3] != "" {
				var ms []string
				for _, m := range strings.Split(f[3], ",") {
					if m != name {
						ms = append(ms, m)
					}
				}
				f[3] = strings.Join(ms, ",")
				l = strings.Join(f, ":")
			}
			keep = append(keep, l)
		}
		return s.write("/etc/group", keep)
	}
	return ok("")
}
