package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Database hosting (D-71, ADR 0018). Agent quản trị bằng xác thực socket (root → mariadb, postgres → psql), câu SQL gửi
// qua stdin, định danh đã validate + quote, mật khẩu đã giới hạn bộ ký tự. Dump/import chạy dưới uid account bằng
// danh tính chủ (unix_socket/peer) nên SQL trong file chỉ có quyền của account.

type engine string

const (
	engMy engine = "mysql"
	engPG engine = "pg"

	// EngMySQL / EngPG: hằng engine xuất ra cho test.
	EngMySQL = engMy
	EngPG    = engPG
)

var (
	reDBName   = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	rePassword = regexp.MustCompile(`^[A-Za-z0-9._~!@#%^*+=:,-]{12,128}$`)
	reserved   = map[string]bool{"mysql": true, "information_schema": true, "performance_schema": true, "sys": true,
		"postgres": true, "template0": true, "template1": true, "root": true}
	myCharsets = map[string]bool{"utf8mb4": true, "utf8mb3": true, "latin1": true, "ascii": true, "binary": true}
	pgCharsets = map[string]string{"utf8": "UTF8", "UTF8": "UTF8", "LATIN1": "LATIN1", "latin1": "LATIN1", "utf8mb4": "UTF8"}
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		h := map[string]registry.Handler{}
		for _, e := range []engine{engMy, engPG} {
			e := e
			h["db."+string(e)+".owner_ensure"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbOwnerEnsure(ctx, env, e)
			}
			h["db."+string(e)+".create"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbCreate(ctx, env, e)
			}
			h["db."+string(e)+".drop"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbDrop(ctx, env, e)
			}
			h["db."+string(e)+".user_ensure"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbUserEnsure(ctx, env, e)
			}
			h["db."+string(e)+".user_drop"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbUserDrop(ctx, env, e)
			}
			h["db."+string(e)+".grant"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbGrant(ctx, env, e)
			}
			h["db."+string(e)+".lock"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbLock(ctx, env, e)
			}
			h["db."+string(e)+".inspect"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbInspect(ctx, env, e)
			}
			h["db."+string(e)+".dump"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbDump(ctx, env, e)
			}
			h["db."+string(e)+".import"] = func(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
				return d.dbImport(ctx, env, e)
			}
		}
		return h
	})
}

func invalid(f string, a ...any) error {
	return &registry.OpError{Code: "invalid_params", Message: fmt.Sprintf(f, a...)}
}

// CheckDBName kiểm tên DB/DB user: regex, tiền tố `<username>_`, không trùng tên hệ thống, PostgreSQL ≤ 63 ký tự.
func CheckDBName(e engine, a contracts.Account, name string) error {
	if !reDBName.MatchString(name) || reserved[name] {
		return &registry.OpError{Code: "invalid_params", Message: fmt.Sprintf("tên %q không hợp lệ", name)}
	}
	if e == engPG && len(name) > 63 {
		return invalid("tên PostgreSQL tối đa 63 ký tự")
	}
	if !strings.HasPrefix(name, string(a.Username)+"_") || len(name) == len(a.Username)+1 {
		return &registry.OpError{Code: "invalid_params", Message: fmt.Sprintf("tên %q phải có tiền tố %s_", name, a.Username)}
	}
	return nil
}

// CheckPassword kiểm mật khẩu (bộ ký tự không có nháy/gạch chéo ngược/khoảng trắng — an toàn khi đặt trong chuỗi SQL).
func CheckPassword(p string) error {
	if !rePassword.MatchString(p) {
		return invalid("mật khẩu không hợp lệ (12–128 ký tự, không nháy, gạch chéo ngược, khoảng trắng)")
	}
	return nil
}

func myIdent(n string) string { return "`" + n + "`" }
func pgIdent(n string) string { return `"` + n + `"` }
func lit(s string) string     { return "'" + s + "'" }

// myLike là mẫu LIKE cho mọi tên có tiền tố `<user>_` (gạch dưới được escape).
func myLike(u string) string { return lit(u + `\\_%`) }
func pgLike(u string) string { return lit(u + `\_%`) }

// sql chạy câu SQL quản trị (stdin) và trả stdout. MariaDB: root qua unix_socket; PostgreSQL: user postgres qua peer.
func (d *Deps) sql(ctx context.Context, e engine, stmt string) (string, error) {
	c := platform.Cmd{Bin: "mariadb", Args: []string{"--batch", "--skip-column-names", "--protocol=socket"}, Stdin: []byte(stmt)}
	if e == engPG {
		cred, err := d.systemCred("postgres")
		if err != nil {
			return "", err
		}
		c = platform.Cmd{Bin: "psql", Args: []string{"-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", "postgres"}, As: cred, Stdin: []byte(stmt)}
	}
	res, err := d.Run.Run(ctx, c)
	if err != nil {
		if ctx.Err() != nil {
			return "", &registry.OpError{Code: "deadline_exceeded", Message: c.Bin + ": " + ctx.Err().Error(), Retryable: true}
		}
		return "", &registry.OpError{Code: "dependency_unavailable", Message: c.Bin + ": " + err.Error(), Retryable: true}
	}
	if res.ExitCode != 0 {
		msg := strings.TrimSpace(string(res.Stderr))
		code := "precondition_failed"
		if strings.Contains(msg, "connect") || strings.Contains(msg, "No such file") {
			code = "dependency_unavailable"
		}
		return "", cmdFailed(code, c.Bin, res)
	}
	return string(res.Stdout), nil
}

// systemCred trả uid/gid của user hệ thống (postgres).
func (d *Deps) systemCred(name string) (*platform.Cred, error) {
	us, err := d.users()
	if err != nil {
		return nil, opErr(err)
	}
	for _, u := range us {
		if u.Name == name {
			return &platform.Cred{UID: uint32(u.UID), GID: uint32(u.GID)}, nil
		}
	}
	return nil, &registry.OpError{Code: "dependency_unavailable", Message: "chưa cài " + name + " (thiếu user hệ thống)", Retryable: true}
}

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

func (d *Deps) dbAccount(a contracts.Account) error {
	_, err := d.lookupAccount(a)
	return err
}

// OwnerSQL trả câu lệnh tạo danh tính chủ của account (ADR 0018 §5).
func OwnerSQL(e engine, u string) string {
	if e == engMy {
		return fmt.Sprintf("CREATE USER IF NOT EXISTS %s@'localhost' IDENTIFIED VIA unix_socket WITH MAX_USER_CONNECTIONS 20;\n"+
			"GRANT ALL PRIVILEGES ON `%s\\_%%`.* TO %s@'localhost';\n", lit(u), u, lit(u))
	}
	return fmt.Sprintf("CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20;\n", pgIdent(u))
}

func (d *Deps) ownerEnsure(ctx context.Context, e engine, a contracts.Account) (bool, error) {
	u := string(a.Username)
	q := fmt.Sprintf("SELECT COUNT(*) FROM mysql.user WHERE User=%s AND Host='localhost';\n", lit(u))
	if e == engPG {
		q = fmt.Sprintf("SELECT COUNT(*) FROM pg_roles WHERE rolname=%s;\n", lit(u))
	}
	out, err := d.sql(ctx, e, q)
	if err != nil {
		return false, err
	}
	exists := strings.TrimSpace(out) != "0" && strings.TrimSpace(out) != ""
	if e == engPG && exists {
		return false, nil
	}
	if _, err := d.sql(ctx, e, OwnerSQL(e, u)); err != nil { // MariaDB: chạy lại để chắc chắn còn GRANT theo tiền tố
		return false, err
	}
	return !exists, nil
}

func (d *Deps) dbOwnerEnsure(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlOwnerEnsureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := d.dbAccount(p.Account); err != nil {
		return nil, err
	}
	created, err := d.ownerEnsure(ctx, e, p.Account)
	if err != nil {
		return nil, err
	}
	return toData(contracts.DBMysqlOwnerEnsureResult{Created: created})
}

func (d *Deps) dbExists(ctx context.Context, e engine, name string) (bool, error) {
	q := fmt.Sprintf("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name=%s;\n", lit(name))
	if e == engPG {
		q = fmt.Sprintf("SELECT COUNT(*) FROM pg_database WHERE datname=%s;\n", lit(name))
	}
	out, err := d.sql(ctx, e, q)
	if err != nil {
		return false, err
	}
	v := strings.TrimSpace(out)
	return v != "" && v != "0", nil
}

// CreateSQL trả câu lệnh tạo database.
func CreateSQL(e engine, owner, name, charset string) string {
	if e == engMy {
		return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s CHARACTER SET %s;\n", myIdent(name), charset)
	}
	if v, ok := pgCharsets[charset]; ok {
		charset = v
	} else if charset != "LATIN1" {
		charset = "UTF8"
	}
	return fmt.Sprintf("CREATE DATABASE %s OWNER %s ENCODING %s TEMPLATE template0;\nREVOKE ALL ON DATABASE %s FROM PUBLIC;\n",
		pgIdent(name), pgIdent(owner), lit(charset), pgIdent(name))
}

func (d *Deps) dbCreate(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlCreateParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := CheckDBName(e, p.Account, string(p.Name)); err != nil {
		return nil, err
	}
	cs := p.Charset
	if e == engMy && !myCharsets[cs] {
		return nil, invalid("charset MariaDB không hỗ trợ: %q", cs)
	}
	if e == engPG {
		v, ok := pgCharsets[cs]
		if !ok {
			return nil, invalid("encoding PostgreSQL không hỗ trợ: %q", cs)
		}
		cs = v
	}
	if err := d.dbAccount(p.Account); err != nil {
		return nil, err
	}
	if _, err := d.ownerEnsure(ctx, e, p.Account); err != nil {
		return nil, err
	}
	exists, err := d.dbExists(ctx, e, string(p.Name))
	if err != nil {
		return nil, err
	}
	if !exists {
		if _, err := d.sql(ctx, e, CreateSQL(e, string(p.Account.Username), string(p.Name), cs)); err != nil {
			return nil, err
		}
	}
	return toData(contracts.DBMysqlCreateResult{Created: !exists})
}

func (d *Deps) dbDrop(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlDropParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := CheckDBName(e, p.Account, string(p.Name)); err != nil {
		return nil, err
	}
	if p.ConfirmName != p.Name {
		return nil, invalid("confirm_name phải trùng name")
	}
	exists, err := d.dbExists(ctx, e, string(p.Name))
	if err != nil {
		return nil, err
	}
	if exists {
		stmt := fmt.Sprintf("DROP DATABASE IF EXISTS %s;\n", myIdent(string(p.Name)))
		if e == engPG {
			stmt = fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE);\n", pgIdent(string(p.Name)))
		}
		if _, err := d.sql(ctx, e, stmt); err != nil {
			return nil, err
		}
	}
	return toData(contracts.DBMysqlDropResult{Dropped: exists})
}

// myHosts trả các host của user MariaDB (đã kiểm định dạng).
func (d *Deps) myHosts(ctx context.Context, u string) ([]string, error) {
	out, err := d.sql(ctx, engMy, fmt.Sprintf("SELECT Host FROM mysql.user WHERE User=%s;\n", lit(u)))
	if err != nil {
		return nil, err
	}
	var hs []string
	for _, h := range lines(out) {
		if h == "localhost" || h == "%" {
			hs = append(hs, h)
		}
	}
	return hs, nil
}

func (d *Deps) pgRoleExists(ctx context.Context, u string) (bool, error) {
	out, err := d.sql(ctx, engPG, fmt.Sprintf("SELECT COUNT(*) FROM pg_roles WHERE rolname=%s;\n", lit(u)))
	if err != nil {
		return false, err
	}
	v := strings.TrimSpace(out)
	return v != "" && v != "0", nil
}

func (d *Deps) dbUserEnsure(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlUserEnsureParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u := string(p.Username)
	if err := CheckDBName(e, p.Account, u); err != nil {
		return nil, err
	}
	var pw string
	if len(p.Password) > 0 && string(p.Password) != "null" {
		if err := json.Unmarshal(p.Password, &pw); err != nil {
			return nil, invalid("password phải là chuỗi hoặc null")
		}
		if err := CheckPassword(pw); err != nil {
			return nil, err
		}
	}
	host := string(p.Host)
	if host != "localhost" && host != "%" {
		return nil, invalid("host chỉ nhận localhost hoặc %%")
	}
	if p.MaxConnections < 1 || p.MaxConnections > 500 {
		return nil, invalid("max_connections 1–500")
	}
	if err := d.dbAccount(p.Account); err != nil {
		return nil, err
	}
	created := false
	var stmt strings.Builder
	if e == engMy {
		hs, err := d.myHosts(ctx, u)
		if err != nil {
			return nil, err
		}
		switch {
		case len(hs) == 0:
			if pw == "" {
				return nil, &registry.OpError{Code: "precondition_failed", Message: "user mới cần mật khẩu"}
			}
			fmt.Fprintf(&stmt, "CREATE USER %s@%s IDENTIFIED BY %s WITH MAX_USER_CONNECTIONS %d;\n", lit(u), lit(host), lit(pw), p.MaxConnections)
			created = true
		default:
			if hs[0] != host {
				fmt.Fprintf(&stmt, "RENAME USER %s@%s TO %s@%s;\n", lit(u), lit(hs[0]), lit(u), lit(host))
			}
			fmt.Fprintf(&stmt, "ALTER USER %s@%s", lit(u), lit(host))
			if pw != "" {
				fmt.Fprintf(&stmt, " IDENTIFIED BY %s", lit(pw))
			}
			fmt.Fprintf(&stmt, " WITH MAX_USER_CONNECTIONS %d;\n", p.MaxConnections)
		}
	} else {
		exists, err := d.pgRoleExists(ctx, u)
		if err != nil {
			return nil, err
		}
		if !exists {
			if pw == "" {
				return nil, &registry.OpError{Code: "precondition_failed", Message: "user mới cần mật khẩu"}
			}
			fmt.Fprintf(&stmt, "CREATE ROLE %s LOGIN PASSWORD %s CONNECTION LIMIT %d NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n",
				pgIdent(u), lit(pw), p.MaxConnections)
			created = true
		} else {
			fmt.Fprintf(&stmt, "ALTER ROLE %s", pgIdent(u))
			if pw != "" {
				fmt.Fprintf(&stmt, " PASSWORD %s", lit(pw))
			}
			fmt.Fprintf(&stmt, " CONNECTION LIMIT %d;\n", p.MaxConnections)
		}
	}
	if _, err := d.sql(ctx, e, stmt.String()); err != nil {
		return nil, redactPw(err, pw)
	}
	return toData(contracts.DBMysqlUserEnsureResult{Created: created, Changed: created || pw != ""})
}

// redactPw xóa mật khẩu khỏi thông báo lỗi (stderr của client có thể lặp lại câu lệnh).
func redactPw(err error, pw string) error {
	if pw == "" {
		return err
	}
	if oe, ok := err.(*registry.OpError); ok {
		oe.Message = strings.ReplaceAll(oe.Message, pw, "***")
	}
	return err
}

// accountDBs trả danh sách database theo tiền tố của account.
func (d *Deps) accountDBs(ctx context.Context, e engine, u string) ([]string, error) {
	q := fmt.Sprintf("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE %s;\n", myLike(u))
	if e == engPG {
		q = fmt.Sprintf("SELECT datname FROM pg_database WHERE datname LIKE %s;\n", pgLike(u))
	}
	out, err := d.sql(ctx, e, q)
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, n := range lines(out) {
		if reDBName.MatchString(n) && strings.HasPrefix(n, u+"_") {
			dbs = append(dbs, n)
		}
	}
	return dbs, nil
}

func (d *Deps) dbUserDrop(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlUserDropParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u := string(p.Username)
	if err := CheckDBName(e, p.Account, u); err != nil {
		return nil, err
	}
	dropped := false
	if e == engMy {
		hs, err := d.myHosts(ctx, u)
		if err != nil {
			return nil, err
		}
		if len(hs) > 0 {
			if _, err := d.sql(ctx, e, fmt.Sprintf("DROP USER IF EXISTS %s@'localhost', %s@'%%';\n", lit(u), lit(u))); err != nil {
				return nil, err
			}
			dropped = true
		}
	} else {
		exists, err := d.pgRoleExists(ctx, u)
		if err != nil {
			return nil, err
		}
		if exists {
			dbs, err := d.accountDBs(ctx, e, string(p.Account.Username))
			if err != nil {
				return nil, err
			}
			var b strings.Builder
			for _, db := range dbs { // đối tượng user tạo ra chuyển cho danh tính chủ trước khi xóa role
				fmt.Fprintf(&b, "\\connect %s\nREASSIGN OWNED BY %s TO %s;\nDROP OWNED BY %s;\n", pgIdent(db), pgIdent(u), pgIdent(string(p.Account.Username)), pgIdent(u))
			}
			fmt.Fprintf(&b, "\\connect postgres\nDROP ROLE IF EXISTS %s;\n", pgIdent(u))
			if _, err := d.sql(ctx, e, b.String()); err != nil {
				return nil, err
			}
			dropped = true
		}
	}
	return toData(contracts.DBMysqlUserDropResult{Dropped: dropped})
}

// GrantSQL sinh câu lệnh đặt quyền (thu hồi hết rồi cấp lại theo danh sách; rỗng = chỉ thu hồi).
func GrantSQL(e engine, owner, user, host, db string, privs []string) string {
	var b strings.Builder
	has := func(x string) bool { return contains(privs, x) || contains(privs, "ALL") }
	if e == engMy {
		u := lit(user) + "@" + lit(host)
		fmt.Fprintf(&b, "GRANT SELECT ON %s.* TO %s;\nREVOKE ALL PRIVILEGES ON %s.* FROM %s;\n", myIdent(db), u, myIdent(db), u)
		if len(privs) > 0 {
			list := "ALL PRIVILEGES"
			if !contains(privs, "ALL") {
				list = strings.Join(privs, ", ")
			}
			fmt.Fprintf(&b, "GRANT %s ON %s.* TO %s;\n", list, myIdent(db), u)
		}
		return b.String()
	}
	ru, ro, rd := pgIdent(user), pgIdent(owner), pgIdent(db)
	fmt.Fprintf(&b, "\\connect %s\nREVOKE ALL ON SCHEMA public FROM %s;\nREVOKE ALL ON ALL TABLES IN SCHEMA public FROM %s;\n"+
		"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %s;\n"+
		"ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public REVOKE ALL ON TABLES FROM %s;\n"+
		"ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %s;\n"+
		"\\connect postgres\nREVOKE ALL ON DATABASE %s FROM %s;\n", rd, ru, ru, ru, ro, ru, ro, ru, rd, ru)
	if len(privs) == 0 {
		return b.String()
	}
	var tbl []string
	if contains(privs, "ALL") {
		tbl = []string{"ALL"}
	} else {
		for _, x := range []string{"SELECT", "INSERT", "UPDATE", "DELETE"} {
			if contains(privs, x) {
				tbl = append(tbl, x)
			}
		}
	}
	schema := "USAGE"
	if has("CREATE") || has("ALTER") || has("DROP") || has("INDEX") {
		schema = "USAGE, CREATE"
	}
	fmt.Fprintf(&b, "GRANT CONNECT, TEMPORARY ON DATABASE %s TO %s;\n\\connect %s\nGRANT %s ON SCHEMA public TO %s;\n", rd, ru, rd, schema, ru)
	if len(tbl) > 0 {
		t := strings.Join(tbl, ", ")
		fmt.Fprintf(&b, "GRANT %s ON ALL TABLES IN SCHEMA public TO %s;\n"+
			"ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public GRANT %s ON TABLES TO %s;\n", t, ru, ro, t, ru)
		if has("INSERT") || has("UPDATE") {
			fmt.Fprintf(&b, "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %s;\n"+
				"ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %s;\n", ru, ro, ru)
		}
	}
	return b.String()
}

var allowedPrivs = map[string]bool{"ALL": true, "SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true,
	"CREATE": true, "DROP": true, "ALTER": true, "INDEX": true}

func (d *Deps) dbGrant(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlGrantParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u, db := string(p.Username), string(p.Database)
	if err := CheckDBName(e, p.Account, u); err != nil {
		return nil, err
	}
	if err := CheckDBName(e, p.Account, db); err != nil {
		return nil, err
	}
	var privs []string
	for _, x := range p.Privileges {
		if !allowedPrivs[string(x)] {
			return nil, invalid("quyền không hỗ trợ: %q", x)
		}
		if !contains(privs, string(x)) {
			privs = append(privs, string(x))
		}
	}
	host := "localhost"
	if e == engMy {
		hs, err := d.myHosts(ctx, u)
		if err != nil {
			return nil, err
		}
		if len(hs) == 0 {
			return nil, &registry.OpError{Code: "not_found", Message: "không có user " + u}
		}
		host = hs[0]
	} else if ok, err := d.pgRoleExists(ctx, u); err != nil {
		return nil, err
	} else if !ok {
		return nil, &registry.OpError{Code: "not_found", Message: "không có user " + u}
	}
	if _, err := d.sql(ctx, e, GrantSQL(e, string(p.Account.Username), u, host, db, privs)); err != nil {
		return nil, err
	}
	return toData(contracts.DBMysqlGrantResult{Granted: len(privs) > 0})
}

func (d *Deps) dbLock(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlLockParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	u := string(p.Account.Username)
	var b strings.Builder
	n := 0
	if e == engMy {
		out, err := d.sql(ctx, e, fmt.Sprintf("SELECT User, Host FROM mysql.user WHERE User=%s OR User LIKE %s;\n", lit(u), myLike(u)))
		if err != nil {
			return nil, err
		}
		act := "UNLOCK"
		if p.Locked {
			act = "LOCK"
		}
		for _, l := range lines(out) {
			f := strings.Fields(l)
			if len(f) != 2 || !reDBName.MatchString(f[0]) || (f[1] != "localhost" && f[1] != "%") {
				continue
			}
			fmt.Fprintf(&b, "ALTER USER %s@%s ACCOUNT %s;\n", lit(f[0]), lit(f[1]), act)
			n++
		}
	} else {
		out, err := d.sql(ctx, e, fmt.Sprintf("SELECT rolname FROM pg_roles WHERE rolname=%s OR rolname LIKE %s;\n", lit(u), pgLike(u)))
		if err != nil {
			return nil, err
		}
		act := "LOGIN"
		if p.Locked {
			act = "NOLOGIN"
		}
		for _, r := range lines(out) {
			if !reDBName.MatchString(r) {
				continue
			}
			fmt.Fprintf(&b, "ALTER ROLE %s %s;\n", pgIdent(r), act)
			n++
		}
	}
	if n > 0 {
		if _, err := d.sql(ctx, e, b.String()); err != nil {
			return nil, err
		}
	}
	return toData(contracts.DBMysqlLockResult{Changed: int64(n)})
}

func (d *Deps) dbInspect(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlInspectParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	u := string(p.Account.Username)
	q := fmt.Sprintf("SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0) FROM information_schema.schemata s "+
		"LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name WHERE s.schema_name LIKE %s GROUP BY s.schema_name;\n", myLike(u))
	uq := fmt.Sprintf("SELECT DISTINCT User FROM mysql.user WHERE User LIKE %s;\n", myLike(u))
	if e == engPG {
		q = fmt.Sprintf("SELECT datname, pg_database_size(datname) FROM pg_database WHERE datname LIKE %s;\n", pgLike(u))
		uq = fmt.Sprintf("SELECT rolname FROM pg_roles WHERE rolname LIKE %s;\n", pgLike(u))
	}
	out, err := d.sql(ctx, e, q)
	if err != nil {
		return nil, err
	}
	res := contracts.DBMysqlInspectResult{Databases: []contracts.DBMysqlInspectResultDatabasesItem{}, Users: []contracts.DBName{}}
	for _, l := range lines(out) {
		f := strings.FieldsFunc(l, func(r rune) bool { return r == '\t' || r == '|' })
		if len(f) != 2 || !reDBName.MatchString(f[0]) {
			continue
		}
		sz, _ := strconv.ParseInt(strings.TrimSpace(f[1]), 10, 64)
		res.Databases = append(res.Databases, contracts.DBMysqlInspectResultDatabasesItem{Name: contracts.DBName(f[0]), SizeBytes: contracts.Bytes(sz)})
	}
	out, err = d.sql(ctx, e, uq)
	if err != nil {
		return nil, err
	}
	for _, l := range lines(out) {
		if reDBName.MatchString(l) {
			res.Users = append(res.Users, contracts.DBName(l))
		}
	}
	return toData(res)
}

// dumpProc / importProc: lệnh chạy dưới uid account, kết nối bằng danh tính chủ (socket/peer).
func dumpProc(e engine, u, name string) (string, []string) {
	if e == engMy {
		return "mariadb-dump", []string{"--user=" + u, "--single-transaction", "--quick", "--routines", "--triggers", "--events",
			"--no-tablespaces", name}
	}
	return "pg_dump", []string{"-U", u, "--no-owner", "--no-acl", "-d", name}
}

func importProc(e engine, u, name string) (string, []string) {
	if e == engMy {
		return "mariadb", []string{"--user=" + u, "--batch", name}
	}
	return "psql", []string{"-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", u, "-d", name}
}

func (d *Deps) dbDump(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlDumpParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := CheckDBName(e, p.Account, string(p.Name)); err != nil {
		return nil, err
	}
	st, err := d.streamer()
	if err != nil {
		return nil, err
	}
	cred, _, err := d.helperCred(p.Account)
	if err != nil {
		return nil, err
	}
	bin, args := dumpProc(e, string(p.Account.Username), string(p.Name))
	pr, pw := io.Pipe()
	var errb strings.Builder
	type res struct {
		code int
		err  error
	}
	done := make(chan res, 1)
	go func() {
		code, err := st.Stream(ctx, platform.Proc{Bin: bin, Args: args, As: cred, Stdout: pw, Stderr: &errb})
		pw.Close()
		done <- res{code, err}
	}()
	raw, herr := d.callFS(ctx, fsReq{acct: p.Account, op: "write_stream", stdin: pr,
		params: map[string]any{"target": p.Target, "gzip": p.Compress, "overwrite": true}})
	_ = pr.Close()
	r := <-done
	if herr != nil && (r.err != nil || r.code == 0) { // helper lỗi trước (đường dẫn, quota…): lỗi pipe của dump là hệ quả
		return nil, herr
	}
	if r.err != nil || r.code != 0 {
		if herr == nil { // dump lỗi giữa chừng: không để lại file dở
			_, _ = d.callFS(ctx, fsReq{acct: p.Account, op: "delete", params: map[string]any{"paths": []string{string(p.Target)}}})
		}
		msg := errb.String()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if r.err != nil {
			return nil, &registry.OpError{Code: "dependency_unavailable", Message: bin + ": " + r.err.Error(), Retryable: true}
		}
		return nil, &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("%s thoát mã %d: %s", bin, r.code, strings.TrimSpace(msg))}
	}
	if herr != nil {
		return nil, herr
	}
	var out contracts.DBMysqlDumpResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, opErr(err)
	}
	return toData(out)
}

func (d *Deps) dbImport(ctx context.Context, env *envelope.Envelope, e engine) (map[string]any, error) {
	var p contracts.DBMysqlImportParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := CheckDBName(e, p.Account, string(p.Name)); err != nil {
		return nil, err
	}
	st, err := d.streamer()
	if err != nil {
		return nil, err
	}
	cred, _, err := d.helperCred(p.Account)
	if err != nil {
		return nil, err
	}
	bin, args := importProc(e, string(p.Account.Username), string(p.Name))
	pr, pw := io.Pipe()
	cw := &countWriter{w: pw}
	var errb strings.Builder
	type res struct {
		code int
		err  error
	}
	done := make(chan res, 1)
	go func() {
		code, err := st.Stream(ctx, platform.Proc{Bin: bin, Args: args, As: cred, Stdin: pr, Stderr: &errb})
		_ = pr.Close()
		done <- res{code, err}
	}()
	_, herr := d.callFS(ctx, fsReq{acct: p.Account, op: "cat", stdout: cw, params: map[string]any{"path": p.Source}})
	pw.Close()
	r := <-done
	if herr != nil {
		return nil, herr
	}
	if r.err != nil {
		return nil, &registry.OpError{Code: "dependency_unavailable", Message: bin + ": " + r.err.Error(), Retryable: true}
	}
	if r.code != 0 {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return nil, &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("import lỗi (mã %d): %s", r.code, msg)}
	}
	return toData(contracts.DBMysqlImportResult{Bytes: contracts.Bytes(cw.n)})
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	k, err := c.w.Write(p)
	c.n += int64(k)
	return k, err
}
