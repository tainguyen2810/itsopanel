package ops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"

	"itso.local/agent/internal/platform"
)

// dbSim mô phỏng tối thiểu MariaDB/PostgreSQL cho sandbox: chỉ hiểu đúng các câu SQL mà db.go sinh ra.
type dbSim struct {
	mu    sync.Mutex
	dbs   map[string]map[string]bool            // engine → tên DB
	users map[string]map[string]map[string]bool // engine → user → host ("" cho PG)
	dumps map[string][]byte                     // engine/db → nội dung import cuối (để dump trả lại)
	pure  map[string][3]string                  // FTP user → uid, gid, dir
}

func newDBSim() *dbSim {
	return &dbSim{
		dbs:   map[string]map[string]bool{"mariadb": {}, "psql": {}},
		users: map[string]map[string]map[string]bool{"mariadb": {}, "psql": {}},
		dumps: map[string][]byte{}, pure: map[string][3]string{},
	}
}

var (
	reSimCreateUser = regexp.MustCompile(`^CREATE USER (?:IF NOT EXISTS )?'([a-z0-9_]+)'@'([^']+)'`)
	reSimCreateRole = regexp.MustCompile(`^CREATE ROLE "([a-z0-9_]+)"`)
	reSimCreateDB   = regexp.MustCompile("^CREATE DATABASE (?:IF NOT EXISTS )?[`\"]([a-z0-9_]+)[`\"]")
	reSimDropDB     = regexp.MustCompile("^DROP DATABASE (?:IF EXISTS )?[`\"]([a-z0-9_]+)[`\"]")
	reSimDropUser   = regexp.MustCompile(`'([a-z0-9_]+)'@'([^']+)'`)
	reSimDropRole   = regexp.MustCompile(`^DROP ROLE (?:IF EXISTS )?"([a-z0-9_]+)"`)
	reSimRename     = regexp.MustCompile(`^RENAME USER '([a-z0-9_]+)'@'([^']+)' TO '[a-z0-9_]+'@'([^']+)'`)
	reSimEq         = regexp.MustCompile(`(?:User|rolname|schema_name|datname)='([a-z0-9_]+)'`)
	reSimLike       = regexp.MustCompile(`LIKE '([a-z0-9]+)\\{1,2}_%'`)
	reSimHost       = regexp.MustCompile(`Host='([^']+)'`)
	reSimTable      = regexp.MustCompile(`table_(?:schema|catalog)='([a-z0-9_]+)'`)
)

func (s *dbSim) sql(bin, stmt string) platform.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	dbs, users := s.dbs[bin], s.users[bin]
	var out strings.Builder
	for _, l := range strings.Split(stmt, "\n") {
		l = strings.TrimSpace(l)
		switch {
		case l == "" || strings.HasPrefix(l, `\connect`):
		case reSimCreateUser.MatchString(l):
			m := reSimCreateUser.FindStringSubmatch(l)
			if users[m[1]] == nil {
				users[m[1]] = map[string]bool{}
			} else if users[m[1]][m[2]] && !strings.Contains(l, "IF NOT EXISTS") {
				return fail(1, "ERROR 1396 (HY000): Operation CREATE USER failed")
			}
			users[m[1]][m[2]] = true
		case reSimCreateRole.MatchString(l):
			m := reSimCreateRole.FindStringSubmatch(l)
			if users[m[1]] != nil {
				return fail(1, "ERROR:  role \""+m[1]+"\" already exists")
			}
			users[m[1]] = map[string]bool{"": true}
		case reSimCreateDB.MatchString(l):
			dbs[reSimCreateDB.FindStringSubmatch(l)[1]] = true
		case reSimDropDB.MatchString(l):
			delete(dbs, reSimDropDB.FindStringSubmatch(l)[1])
		case strings.HasPrefix(l, "DROP USER"):
			for _, m := range reSimDropUser.FindAllStringSubmatch(l, -1) {
				delete(users[m[1]], m[2])
				if len(users[m[1]]) == 0 {
					delete(users, m[1])
				}
			}
		case reSimDropRole.MatchString(l):
			delete(users, reSimDropRole.FindStringSubmatch(l)[1])
		case reSimRename.MatchString(l):
			m := reSimRename.FindStringSubmatch(l)
			if users[m[1]] != nil {
				delete(users[m[1]], m[2])
				users[m[1]][m[3]] = true
			}
		case strings.HasPrefix(l, "SELECT"):
			out.WriteString(s.query(bin, l))
		}
	}
	return ok(out.String())
}

func (s *dbSim) query(bin, q string) string {
	dbs, users := s.dbs[bin], s.users[bin]
	onDBs := strings.Contains(q, "schemata") || strings.Contains(q, "pg_database")
	var names []string
	if onDBs {
		for n := range dbs {
			names = append(names, n)
		}
	} else {
		for n := range users {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	eq := reSimEq.FindStringSubmatch(q)
	like := reSimLike.FindStringSubmatch(q)
	match := func(n string) bool {
		return (eq != nil && n == eq[1]) || (like != nil && strings.HasPrefix(n, like[1]+"_"))
	}
	if strings.Contains(q, "COUNT(*) FROM information_schema.tables") { // migrate.verify: số bảng = số CREATE TABLE trong dump đã nạp
		all := reSimTable.FindAllStringSubmatch(q, -1)
		if all == nil {
			return "0\n"
		}
		m := all[len(all)-1] // PG: table_schema='public' AND table_catalog='<db>'
		n := 0
		for _, l := range strings.Split(string(s.dumps[bin+"/"+m[1]]), "\n") {
			if strings.HasPrefix(l, "CREATE TABLE") {
				n++
			}
		}
		return fmt.Sprintf("%d\n", n)
	}
	if strings.HasPrefix(q, "SELECT COUNT(*)") {
		c := 0
		for _, n := range names {
			if match(n) {
				if h := reSimHost.FindStringSubmatch(q); h != nil && !users[n][h[1]] {
					continue
				}
				c++
			}
		}
		return fmt.Sprintf("%d\n", c)
	}
	sep := "\t"
	if bin == "psql" {
		sep = "|"
	}
	var b strings.Builder
	for _, n := range names {
		if !match(n) {
			continue
		}
		switch {
		case strings.HasPrefix(q, "SELECT Host"):
			for h := range users[n] {
				b.WriteString(h + "\n")
			}
		case strings.HasPrefix(q, "SELECT User, Host"):
			for h := range users[n] {
				b.WriteString(n + sep + h + "\n")
			}
		case onDBs && (strings.Contains(q, "SUM(") || strings.Contains(q, "pg_database_size")):
			fmt.Fprintf(&b, "%s%s%d\n", n, sep, len(s.dumps[bin+"/"+n]))
		default:
			b.WriteString(n + "\n")
		}
	}
	return b.String()
}

// pureSim mô phỏng `pure-pw` (show/useradd/usermod/passwd/userdel).
func (s *dbSim) purePw(a []string) platform.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(a) == 1 && a[0] == "list" {
		var b strings.Builder
		for _, n := range sortedKeys(s.pure) {
			fmt.Fprintf(&b, "%s\t%s/./\n", n, s.pure[n][2])
		}
		return ok(b.String())
	}
	if len(a) < 2 {
		return fail(1, "pure-pw: thiếu tham số")
	}
	u, has := s.pure[a[1]]
	switch a[0] {
	case "show":
		if !has {
			return fail(1, "Unable to fetch info about user")
		}
		return ok(fmt.Sprintf("Login              : %s\nUID                : %s\nGID                : %s\nDirectory          : %s/./\n", a[1], u[0], u[1], u[2]))
	case "useradd", "usermod":
		if a[0] == "useradd" && has {
			return fail(1, "Error. A user with the same name already exists")
		}
		if a[0] == "usermod" && !has {
			return fail(1, "Error. User not found")
		}
		s.pure[a[1]] = [3]string{flag(a, "-u"), flag(a, "-g"), flag(a, "-d")}
	case "passwd":
		if !has {
			return fail(1, "Error. User not found")
		}
	case "userdel":
		delete(s.pure, a[1])
	}
	return ok("")
}

// handle mô phỏng lệnh dữ liệu của Phase 6; handled=false nếu không thuộc nhóm này.
func (s *dbSim) handle(c platform.Cmd) (platform.Result, bool) {
	switch c.Bin {
	case "mariadb", "psql":
		return s.sql(c.Bin, string(c.Stdin)), true
	case "pure-pw":
		return s.purePw(c.Args), true
	case "sshd":
		return ok(""), true
	case "chpasswd":
		if !bytes.Contains(c.Stdin, []byte(":")) {
			return fail(1, "chpasswd: line 1: missing new password"), true
		}
		return ok(""), true
	case "systemd-run":
		return ok("sandbox: lệnh cron không thực sự chạy\n"), true
	}
	return platform.Result{}, false
}

// stream mô phỏng tiến trình luồng: helper File Manager chạy trong tiến trình; dump trả nội dung đã import;
// import đọc hết stdin.
func (s *dbSim) stream(ctx context.Context, p platform.Proc) (int, error) {
	switch p.Bin {
	case "itso-fs-helper":
		return SandboxFSHelper(ctx, p)
	case "restic":
		// Sandbox dùng restic thật nếu máy dev có (repo dưới gốc sandbox, Phase 8); không có thì báo thiếu phụ thuộc.
		if _, err := os.Stat(platform.Bins["restic"]); err != nil {
			if p.Stderr != nil {
				fmt.Fprintln(p.Stderr, "restic: not installed on this dev machine")
			}
			return -1, errors.New("restic không có trên máy dev")
		}
		return platform.ExecRunner{}.Stream(ctx, p)
	case "mariadb-dump", "pg_dump":
		bin := map[string]string{"mariadb-dump": "mariadb", "pg_dump": "psql"}[p.Bin]
		name := p.Args[len(p.Args)-1]
		if p.Bin == "pg_dump" && name == PanelDB {
			// CSDL panel trong sandbox: dump giả cố định (backup panel, Phase 8).
			_, err := p.Stdout.Write([]byte("PGDMP sandbox panel dump\n"))
			return 0, err
		}
		s.mu.Lock()
		exists := s.dbs[bin][name]
		body := append([]byte("-- sandbox dump "+name+"\n"), s.dumps[bin+"/"+name]...)
		s.mu.Unlock()
		if !exists {
			if p.Stderr != nil {
				fmt.Fprintf(p.Stderr, "Unknown database '%s'\n", name)
			}
			return 2, nil
		}
		_, err := p.Stdout.Write(body)
		return 0, err
	case "mariadb", "psql", "pg_restore":
		name := p.Args[len(p.Args)-1]
		eng := p.Bin
		if eng == "pg_restore" {
			eng = "psql"
		}
		b, err := io.ReadAll(p.Stdin)
		if err != nil {
			return -1, err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.dbs[eng][name] {
			if p.Stderr != nil {
				fmt.Fprintf(p.Stderr, "Unknown database '%s'\n", name)
			}
			return 1, nil
		}
		s.dumps[eng+"/"+name] = b
		return 0, nil
	}
	if p.Stdin != nil {
		_, _ = io.Copy(io.Discard, p.Stdin)
	}
	return 0, nil
}

// Stream mô phỏng tiến trình luồng (dùng làm FakeRunner.StreamHook).
func (s *Sim) Stream(ctx context.Context, p platform.Proc) (int, error) { return s.data.stream(ctx, p) }
