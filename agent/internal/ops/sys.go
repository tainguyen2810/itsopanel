package ops

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// HomeBase là thư mục chứa home của hosting account (07 §5).
const HomeBase = "/home"

// run chạy một lệnh trong bảng Bins. Lỗi khởi chạy (không có binary, ctx hủy) → OpError.
func (d *Deps) run(ctx context.Context, bin string, args ...string) (platform.Result, error) {
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: bin, Args: args})
	if err != nil {
		if ctx.Err() != nil {
			return res, &registry.OpError{Code: "deadline_exceeded", Message: bin + ": " + ctx.Err().Error(), Retryable: true}
		}
		return res, &registry.OpError{Code: "dependency_unavailable", Message: bin + ": " + err.Error(), Retryable: true}
	}
	return res, nil
}

// must chạy lệnh và coi exit ≠ 0 là lỗi với mã code.
func (d *Deps) must(ctx context.Context, code, bin string, args ...string) (platform.Result, error) {
	res, err := d.run(ctx, bin, args...)
	if err != nil {
		return res, err
	}
	if res.ExitCode != 0 {
		return res, cmdFailed(code, bin, res)
	}
	return res, nil
}

func cmdFailed(code, bin string, res platform.Result) error {
	msg := strings.TrimSpace(string(res.Stderr))
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return &registry.OpError{Code: code, Message: fmt.Sprintf("%s thoát mã %d: %s", bin, res.ExitCode, msg),
		Retryable: code == "dependency_unavailable" || code == "busy"}
}

// passwdEntry là một dòng /etc/passwd.
type passwdEntry struct {
	Name, Gecos, Home, Shell string
	UID, GID                 int64
}

type groupEntry struct {
	Name    string
	GID     int64
	Members []string
}

// readLines đọc file dạng dòng của FS; file không tồn tại → rỗng.
func (d *Deps) readLines(p string) ([]string, error) {
	b, err := d.FS.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n"), nil
}

func (d *Deps) users() ([]passwdEntry, error) {
	lines, err := d.readLines("/etc/passwd")
	if err != nil {
		return nil, err
	}
	var out []passwdEntry
	for _, l := range lines {
		f := strings.Split(l, ":")
		if len(f) != 7 {
			continue
		}
		uid, err1 := strconv.ParseInt(f[2], 10, 64)
		gid, err2 := strconv.ParseInt(f[3], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, passwdEntry{Name: f[0], UID: uid, GID: gid, Gecos: f[4], Home: f[5], Shell: f[6]})
	}
	return out, nil
}

func (d *Deps) groups() ([]groupEntry, error) {
	lines, err := d.readLines("/etc/group")
	if err != nil {
		return nil, err
	}
	var out []groupEntry
	for _, l := range lines {
		f := strings.Split(l, ":")
		if len(f) != 4 {
			continue
		}
		gid, err := strconv.ParseInt(f[2], 10, 64)
		if err != nil {
			continue
		}
		var m []string
		if f[3] != "" {
			m = strings.Split(f[3], ",")
		}
		out = append(out, groupEntry{Name: f[0], GID: gid, Members: m})
	}
	return out, nil
}

// shadow trả (trường mật khẩu, trường hết hạn) của user; ok=false nếu không có.
func (d *Deps) shadow(name string) (pw, expire string, ok bool, err error) {
	lines, err := d.readLines("/etc/shadow")
	if err != nil {
		return "", "", false, err
	}
	for _, l := range lines {
		f := strings.Split(l, ":")
		if len(f) == 9 && f[0] == name {
			return f[1], f[7], true, nil
		}
	}
	return "", "", false, nil
}

func (d *Deps) groupByName(name string) (*groupEntry, error) {
	gs, err := d.groups()
	if err != nil {
		return nil, err
	}
	for i := range gs {
		if gs[i].Name == name {
			return &gs[i], nil
		}
	}
	return nil, nil
}

// checkAccount kiểm lại username + UID (không tin schema).
func checkAccount(a contracts.Account) error {
	if err := validate.Username(string(a.Username)); err != nil {
		return err
	}
	return validate.UID(int64(a.UID))
}

// lookupAccount tìm user Linux của account: không có → not_found; khác UID → precondition_failed.
func (d *Deps) lookupAccount(a contracts.Account) (*passwdEntry, error) {
	if err := checkAccount(a); err != nil {
		return nil, opErr(err)
	}
	us, err := d.users()
	if err != nil {
		return nil, opErr(err)
	}
	for i := range us {
		if us[i].Name == string(a.Username) {
			if us[i].UID != int64(a.UID) {
				return nil, &registry.OpError{Code: "precondition_failed", Message: fmt.Sprintf("user %s có uid %d, không phải %d", a.Username, us[i].UID, a.UID)}
			}
			return &us[i], nil
		}
	}
	return nil, &registry.OpError{Code: "not_found", Message: "không có user " + string(a.Username)}
}

func homeOf(u contracts.Username) string { return HomeBase + "/" + string(u) }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func modeOf(m uint32) fs.FileMode { return fs.FileMode(m) }

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// mkdirs tạo các thư mục còn thiếu trên đường dẫn (root 0755); thư mục đã có giữ nguyên quyền.
func (d *Deps) mkdirs(p string) error {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	cur := ""
	for _, s := range parts {
		cur += "/" + s
		if d.FS.Exists(cur) {
			continue
		}
		if _, err := d.FS.EnsureDir(cur, 0o755, platform.Owner{}); err != nil {
			return opErr(err)
		}
	}
	return nil
}
