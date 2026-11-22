package ops

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"itso.local/agent/internal/platform"
)

// wpSim mô phỏng WP-CLI cho sandbox/test (chạy qua systemd-run … php wp-cli.phar). Trạng thái "file" nằm thật trên
// gốc FS giả (version.php, header plugin/theme, wp-config.php, .maintenance) để snapshot/khôi phục bằng restic thật
// kiểm được; trạng thái "DB" nằm trong dump của dbSim (dòng `-- opt k=v`, `-- migrated …`).
type wpSim struct {
	// Available: bản cập nhật có sẵn — "core", "plugin/<slug>", "theme/<slug>" → phiên bản.
	Available map[string]string
	// Fail: tiền tố subcommand (vd. "plugin update akismet") → lỗi; file của thành phần vẫn bị ghi dở trước khi lỗi.
	Fail map[string]string
	// ChecksumFail: core verify-checksums báo sai lệch.
	ChecksumFail bool
	// Stdin ghi lại stdin mỗi lệnh (test kiểm mật khẩu không nằm trong argv).
	Stdin []string
}

// WP trả trình mô phỏng WP-CLI (tạo khi gọi lần đầu).
func (s *Sim) WP() *wpSim {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wp == nil {
		s.wp = &wpSim{Available: map[string]string{}, Fail: map[string]string{}}
	}
	return s.wp
}

// DBDump trả nội dung "DB" mô phỏng (engine "mariadb"/"psql").
func (s *Sim) DBDump(engine, name string) string {
	s.data.mu.Lock()
	defer s.data.mu.Unlock()
	return string(s.data.dumps[engine+"/"+name])
}

// SetDBDump đặt nội dung "DB" mô phỏng (DB phải đã được tạo).
func (s *Sim) SetDBDump(engine, name, body string) {
	s.data.mu.Lock()
	defer s.data.mu.Unlock()
	s.data.dumps[engine+"/"+name] = []byte(body)
}

func isWPCLI(c platform.Cmd) bool {
	return c.Bin == "systemd-run" && contains(c.Args, WPCLIPath)
}

var (
	reSimDefine = regexp.MustCompile(`define\(\s*'([A-Z_]+)'\s*,\s*(.*?)\s*\);`)
	reSimHeader = regexp.MustCompile(`(?m)^\s*\*?\s*Version:\s*(\S+)`)
	reSimTitle  = regexp.MustCompile(`(?m)^\s*\*?\s*(?:Plugin|Theme) Name:\s*(.+)$`)
)

func (s *Sim) wpHandle(c platform.Cmd) platform.Result {
	w := s.WP()
	i := slicesIndex(c.Args, WPCLIPath)
	var site string
	var args []string
	for _, a := range c.Args[i+1:] {
		switch {
		case strings.HasPrefix(a, "--path="):
			site = strings.TrimPrefix(a, "--path=")
		case a == "--no-color" || a == "--skip-plugins" || a == "--skip-themes":
		default:
			args = append(args, a)
		}
	}
	s.mu.Lock()
	w.Stdin = append(w.Stdin, string(c.Stdin))
	s.mu.Unlock()
	if err := WPAllowed(args); err != nil {
		return fail(1, "Error: "+err.Error())
	}
	rel, cut := strings.CutPrefix(site, strings.TrimSuffix(s.FS.Root, "/"))
	if !cut {
		rel = site
	}
	ws := &wpSimSite{s: s, w: w, root: rel}
	return ws.run(args, strings.TrimSuffix(string(c.Stdin), "\n"))
}

func slicesIndex(a []string, v string) int {
	for i, x := range a {
		if x == v {
			return i
		}
	}
	return -1
}

type wpSimSite struct {
	s    *Sim
	w    *wpSim
	root string // đường dẫn logic trên FS giả
}

func (ws *wpSimSite) read(p string) string {
	b, err := ws.s.FS.ReadFile(ws.root + "/" + p)
	if err != nil {
		return ""
	}
	return string(b)
}

func (ws *wpSimSite) write(p, body string) {
	_ = ws.s.FS.MkdirAll(filepath.Dir(ws.root + "/" + p))
	_, _ = ws.s.FS.WriteAtomic(ws.root+"/"+p, []byte(body), 0o644, platform.Owner{})
}

func (ws *wpSimSite) defines() map[string]string {
	out := map[string]string{}
	for _, m := range reSimDefine.FindAllStringSubmatch(ws.read("wp-config.php"), -1) {
		out[m[1]] = strings.Trim(m[2], "'")
	}
	return out
}

func (ws *wpSimSite) dbName() string { return ws.defines()["DB_NAME"] }

func (ws *wpSimSite) db() string { return ws.s.DBDump("mariadb", ws.dbName()) }

func (ws *wpSimSite) dbAppend(line string) {
	n := ws.dbName()
	ws.s.data.mu.Lock()
	defer ws.s.data.mu.Unlock()
	ws.s.data.dumps["mariadb/"+n] = append(ws.s.data.dumps["mariadb/"+n], []byte(line+"\n")...)
}

func (ws *wpSimSite) option(k string) (string, bool) {
	v, found := "", false
	for _, l := range strings.Split(ws.db(), "\n") {
		if kv, ok := strings.CutPrefix(l, "-- opt "+k+"="); ok {
			v, found = kv, true
		}
	}
	return v, found
}

func (ws *wpSimSite) setDefine(name, val string) {
	cfg := ws.read("wp-config.php")
	line := fmt.Sprintf("define( '%s', %s );", name, val)
	re := regexp.MustCompile(`define\(\s*'` + name + `'\s*,[^\n]*\);`)
	if re.MatchString(cfg) {
		cfg = re.ReplaceAllLiteralString(cfg, line)
	} else {
		cfg = strings.Replace(cfg, "/* That's all", line+"\n/* That's all", 1)
	}
	ws.writeConfig(cfg)
}

// writeConfig ghi wp-config.php giữ quyền hiện có (0400 → lệnh ghi thất bại như thật).
func (ws *wpSimSite) writeConfig(cfg string) bool {
	p, _ := ws.s.FS.Path(ws.root + "/wp-config.php")
	if fi, err := os.Stat(p); err == nil && fi.Mode().Perm()&0o200 == 0 {
		return false
	}
	ws.write("wp-config.php", cfg)
	return true
}

func (ws *wpSimSite) components(kind string) []map[string]string {
	dir := map[string]string{"plugin": "wp-content/plugins", "theme": "wp-content/themes"}[kind]
	real, _ := ws.s.FS.Path(ws.root + "/" + dir)
	ents, _ := os.ReadDir(real)
	var out []map[string]string
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		f := e.Name() + "/" + e.Name() + ".php"
		if kind == "theme" {
			f = e.Name() + "/style.css"
		}
		body := ws.read(dir + "/" + f)
		m := reSimHeader.FindStringSubmatch(body)
		if m == nil {
			continue
		}
		title := e.Name()
		if t := reSimTitle.FindStringSubmatch(body); t != nil {
			title = strings.TrimSpace(t[1])
		}
		out = append(out, map[string]string{"name": e.Name(), "title": title, "status": "active", "version": m[1],
			"update_version": ws.w.Available[kind+"/"+e.Name()], "file": dir + "/" + f})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["name"] < out[j]["name"] })
	return out
}

// SimPluginFile trả nội dung file chính của plugin mô phỏng.
func SimPluginFile(slug, title, version string) string {
	return fmt.Sprintf("<?php\n/**\n * Plugin Name: %s\n * Version: %s\n */\n", title, version)
}

// SimThemeFile trả style.css của theme mô phỏng.
func SimThemeFile(title, version string) string {
	return fmt.Sprintf("/*\nTheme Name: %s\nVersion: %s\n*/\n", title, version)
}

func (ws *wpSimSite) failFor(cmd string) (string, bool) {
	for k, v := range ws.w.Fail {
		if strings.HasPrefix(cmd, k) {
			return v, true
		}
	}
	return "", false
}

func (ws *wpSimSite) coreVersion() string {
	m := reWPVersion.FindStringSubmatch(ws.read("wp-includes/version.php"))
	if m == nil {
		return ""
	}
	return m[1]
}

func flagVal(args []string, name string) string {
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--"+name+"="); ok {
			return v
		}
	}
	return ""
}

func positional(args []string) []string {
	var out []string
	for _, a := range args {
		if !strings.HasPrefix(a, "--") {
			out = append(out, a)
		}
	}
	return out
}

func (ws *wpSimSite) run(args []string, stdin string) platform.Result {
	cmd := strings.Join(args, " ")
	if msg, bad := ws.failFor(cmd); bad && !strings.HasPrefix(cmd, "plugin update") && !strings.HasPrefix(cmd, "theme update") &&
		!strings.HasPrefix(cmd, "core update") {
		return fail(1, "Error: "+msg)
	}
	key := args[0]
	if key != "search-replace" {
		key += " " + args[1]
	}
	installed := ws.coreVersion() != ""
	if !installed && key != "core download" {
		return fail(1, "Error: This does not seem to be a WordPress installation.")
	}
	pos := positional(args)
	switch key {
	case "core download":
		if installed {
			return fail(1, "Error: WordPress files seem to already be present here.")
		}
		ws.write("index.php", "<?php\nrequire __DIR__ . '/wp-blog-header.php';\n")
		ws.write("wp-includes/version.php", "<?php\n$wp_version = '6.6.2';\n")
		ws.write("wp-config-sample.php", "<?php\n")
		ws.write("wp-content/themes/twentytwentyfour/style.css", SimThemeFile("Twenty Twenty-Four", "1.2"))
		ws.write("wp-content/plugins/akismet/akismet.php", SimPluginFile("akismet", "Akismet Anti-spam", "5.3"))
		return ok("Success: WordPress downloaded.\n")
	case "core version":
		return ok(ws.coreVersion() + "\n")
	case "config create":
		if ws.read("wp-config.php") != "" {
			return fail(1, "Error: The 'wp-config.php' file already exists.")
		}
		if stdin == "" {
			return fail(1, "Error: missing dbpass")
		}
		ws.write("wp-config.php", fmt.Sprintf("<?php\ndefine( 'DB_NAME', '%s' );\ndefine( 'DB_USER', '%s' );\ndefine( 'DB_PASSWORD', '%s' );\n"+
			"define( 'DB_HOST', 'localhost' );\ndefine( 'AUTH_KEY', 'sim-0' );\n/* That's all, stop editing! */\n",
			flagVal(args, "dbname"), flagVal(args, "dbuser"), stdin))
		return ok("Success: Generated 'wp-config.php' file.\n")
	}
	if ws.read("wp-config.php") == "" {
		return fail(1, "Error: 'wp-config.php' not found.")
	}
	switch key {
	case "core install":
		if stdin == "" {
			return fail(1, "Error: missing admin_password")
		}
		if _, done := ws.option("siteurl"); done {
			return ok("WordPress is already installed.\n")
		}
		url := flagVal(args, "url")
		ws.dbAppend("CREATE TABLE wp_options (option_name varchar(191));")
		ws.dbAppend("-- opt siteurl=" + url)
		ws.dbAppend("-- opt home=" + url)
		ws.dbAppend("-- opt blog_public=1")
		ws.dbAppend("-- user " + flagVal(args, "admin_user"))
		return ok("Success: WordPress installed successfully.\n")
	case "core check-update":
		if v := ws.w.Available["core"]; v != "" {
			b, _ := json.Marshal([]map[string]string{{"version": v, "update_type": "minor", "package_url": "https://downloads.wordpress.org/x.zip"}})
			return ok(string(b) + "\n")
		}
		return ok("[]\n")
	case "core update":
		v := ws.w.Available["core"]
		if v == "" {
			return ok("Success: WordPress is up to date.\n")
		}
		ws.write("wp-includes/version.php", "<?php\n$wp_version = '"+v+"';\n")
		if msg, bad := ws.failFor(cmd); bad {
			ws.write("wp-includes/version.php", "<?php\n// cập nhật dở\n")
			return fail(1, "Error: "+msg)
		}
		return ok("Success: WordPress updated successfully.\n")
	case "core update-db":
		ws.dbAppend("-- migrated core " + ws.coreVersion())
		return ok("Success: WordPress database upgraded successfully.\n")
	case "core verify-checksums":
		if ws.w.ChecksumFail {
			return platform.Result{ExitCode: 1, Stderr: []byte("Warning: File doesn't verify against checksum: wp-includes/load.php\nError: WordPress installation doesn't verify against checksums.\n")}
		}
		return ok("Success: WordPress installation verifies against checksums.\n")
	case "plugin verify-checksums":
		return ok("Success: Verified 1 of 1 plugins.\n")
	case "plugin list", "theme list":
		items := ws.components(args[0])
		for _, it := range items {
			delete(it, "file")
		}
		if items == nil {
			items = []map[string]string{}
		}
		b, _ := json.Marshal(items)
		return ok(string(b) + "\n")
	case "plugin update", "theme update":
		slug := pos[2]
		for _, it := range ws.components(args[0]) {
			if it["name"] != slug {
				continue
			}
			v := ws.w.Available[args[0]+"/"+slug]
			if v == "" {
				return ok("Success: Plugin already updated.\n")
			}
			body := SimPluginFile(slug, it["title"], v)
			if args[0] == "theme" {
				body = SimThemeFile(it["title"], v)
			}
			ws.write(it["file"], body)
			ws.dbAppend("-- migrated " + args[0] + " " + slug + " " + v)
			if msg, bad := ws.failFor(cmd); bad {
				ws.write(it["file"], "<?php // giải nén dở\n")
				return fail(1, "Error: "+msg)
			}
			return ok("Success: Updated 1 of 1 " + args[0] + "s.\n")
		}
		return fail(1, "Error: The '"+slug+"' "+args[0]+" could not be found.")
	case "option get":
		v, found := ws.option(pos[2])
		if !found {
			return fail(1, "Error: Could not get '"+pos[2]+"' option. Does it exist?")
		}
		return ok(v + "\n")
	case "option update":
		ws.dbAppend("-- opt " + pos[2] + "=" + pos[3])
		return ok("Success: Updated '" + pos[2] + "' option.\n")
	case "config set":
		val := ""
		if len(pos) > 3 {
			val = pos[3]
		} else if flagVal(args, "prompt") == "value" {
			val = stdin
		}
		if !contains(args, "--raw") {
			val = "'" + val + "'"
		}
		cfg := ws.read("wp-config.php")
		if p, _ := ws.s.FS.Path(ws.root + "/wp-config.php"); isReadOnly(p) {
			return fail(1, "Error: The 'wp-config.php' file is not writable.")
		}
		_ = cfg
		ws.setDefine(pos[2], val)
		return ok("Success: Updated the constant '" + pos[2] + "' in the 'wp-config.php' file.\n")
	case "config delete":
		cfg := ws.read("wp-config.php")
		re := regexp.MustCompile(`define\(\s*'` + regexp.QuoteMeta(pos[2]) + `'\s*,[^\n]*\);\n?`)
		if !re.MatchString(cfg) {
			return fail(1, "Error: The constant '"+pos[2]+"' is not defined in the 'wp-config.php' file.")
		}
		if !ws.writeConfig(re.ReplaceAllString(cfg, "")) {
			return fail(1, "Error: The 'wp-config.php' file is not writable.")
		}
		return ok("Success: Deleted the constant.\n")
	case "config shuffle-salts":
		cfg := ws.read("wp-config.php")
		n := strings.Count(cfg, "sim-") + 1
		if !ws.writeConfig(regexp.MustCompile(`'AUTH_KEY',\s*'[^']*'`).ReplaceAllString(cfg, fmt.Sprintf("'AUTH_KEY', 'sim-%d'", n))) {
			return fail(1, "Error: The 'wp-config.php' file is not writable.")
		}
		return ok("Success: Shuffled the salt keys.\n")
	case "maintenance-mode activate":
		ws.write(".maintenance", "<?php $upgrading = time(); ?>")
		return ok("Success: Activated Maintenance mode.\n")
	case "maintenance-mode deactivate":
		_, _ = ws.s.FS.Remove(ws.root + "/.maintenance")
		return ok("Success: Deactivated Maintenance mode.\n")
	case "maintenance-mode is-active":
		if ws.read(".maintenance") != "" {
			return ok("")
		}
		return platform.Result{ExitCode: 1}
	case "search-replace":
		from, to := pos[1], pos[2]
		n := 0
		var lines []string
		for _, l := range strings.Split(ws.db(), "\n") {
			if strings.Contains(l, from) {
				n += strings.Count(l, from)
				l = strings.ReplaceAll(l, from, to)
			}
			lines = append(lines, l)
		}
		ws.s.SetDBDump("mariadb", ws.dbName(), strings.Join(lines, "\n"))
		return ok(fmt.Sprintf("%d\n", n))
	case "user update":
		if stdin == "" {
			return fail(1, "Error: missing user_pass")
		}
		if !strings.Contains(ws.db(), "-- user "+pos[2]+"\n") {
			return fail(1, "Error: Invalid user ID, email or login: '"+pos[2]+"'")
		}
		return ok("Success: Updated user 1.\n")
	}
	return fail(1, "Error: sandbox chưa mô phỏng: "+cmd)
}

func isReadOnly(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().Perm()&0o200 == 0
}
