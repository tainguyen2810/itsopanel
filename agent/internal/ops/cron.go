package ops

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/fsx"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// Cron bằng systemd timer trong slice account (D-74, ADR 0021). Lệnh người dùng nằm trong script root 0644,
// không bao giờ được escape vào unit.

const (
	CronDir      = "/etc/itso-cron" // ngoài /etc/itso (0750): bash đọc script dưới uid account
	UnitDir      = "/etc/systemd/system"
	cronPrefix   = "itso-cron-"
	outputTail   = 8192
	maxCronBytes = 1024
)

var cronMu sync.Mutex

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpCronApply:   d.cronApply,
			contracts.OpCronInspect: d.cronInspect,
			contracts.OpCronRunOnce: d.cronRunOnce,
		}
	})
}

// ---------- cron → OnCalendar ----------

type cronField struct {
	name     string
	min, max int
}

var cronFields = []cronField{{"phút", 0, 59}, {"giờ", 0, 23}, {"ngày", 1, 31}, {"tháng", 1, 12}, {"thứ", 0, 7}}

var dowNames = []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

// parseField trả tập giá trị của một trường (sắp xếp) và cờ "*" (không giới hạn).
func parseField(s string, f cronField) ([]int, bool, error) {
	if s == "*" {
		return nil, true, nil
	}
	set := map[int]bool{}
	for _, term := range strings.Split(s, ",") {
		rng, stepS, hasStep := strings.Cut(term, "/")
		step := 1
		if hasStep {
			n, err := strconv.Atoi(stepS)
			if err != nil || n < 1 || n > f.max {
				return nil, false, invalid("bước %q của trường %s không hợp lệ", stepS, f.name)
			}
			step = n
		}
		lo, hi := f.min, f.max
		switch {
		case rng == "*":
		case strings.Contains(rng, "-"):
			a, b, _ := strings.Cut(rng, "-")
			x, e1 := strconv.Atoi(a)
			y, e2 := strconv.Atoi(b)
			if e1 != nil || e2 != nil || x > y {
				return nil, false, invalid("khoảng %q của trường %s không hợp lệ", rng, f.name)
			}
			lo, hi = x, y
		default:
			x, err := strconv.Atoi(rng)
			if err != nil {
				return nil, false, invalid("giá trị %q của trường %s không hợp lệ", rng, f.name)
			}
			lo, hi = x, x
			if hasStep { // "a/n" = a, a+n, … tới max
				hi = f.max
			}
		}
		if lo < f.min || hi > f.max || lo > hi { // lo > hi: "a/n" với a vượt max (vd. giờ 27/1) → tập rỗng
			return nil, false, invalid("trường %s ngoài miền %d–%d", f.name, f.min, f.max)
		}
		for v := lo; v <= hi; v += step {
			set[v] = true
		}
	}
	out := make([]int, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	sort.Ints(out)
	return out, false, nil
}

// compress viết tập giá trị theo cú pháp systemd: "a..b" cho đoạn liên tiếp (≥3), còn lại liệt kê bằng dấu phẩy.
func compress(vals []int, name func(int) string) string {
	var parts []string
	for i := 0; i < len(vals); {
		j := i
		for j+1 < len(vals) && vals[j+1] == vals[j]+1 {
			j++
		}
		if j-i >= 2 {
			parts = append(parts, name(vals[i])+".."+name(vals[j]))
		} else {
			for k := i; k <= j; k++ {
				parts = append(parts, name(vals[k]))
			}
		}
		i = j + 1
	}
	return strings.Join(parts, ",")
}

func daysIn(month int) int {
	return time.Date(2024, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day() // 2024 nhuận: 29/2 hợp lệ
}

// CronToOnCalendar chuyển biểu thức cron 5 trường thành OnCalendar. Từ chối DOM+DOW cùng giới hạn (cron: OR,
// systemd: AND) và lịch không bao giờ xảy ra.
func CronToOnCalendar(expr string) (string, error) {
	f := strings.Fields(expr)
	if len(f) != 5 || len(expr) > 100 {
		return "", invalid("biểu thức cron phải có đúng 5 trường")
	}
	vals := make([][]int, 5)
	star := make([]bool, 5)
	for i, cf := range cronFields {
		v, s, err := parseField(f[i], cf)
		if err != nil {
			return "", err
		}
		vals[i], star[i] = v, s
	}
	if !star[2] && !star[4] {
		return "", invalid("không hỗ trợ giới hạn cùng lúc ngày trong tháng và thứ trong tuần")
	}
	months := vals[3]
	if star[3] {
		months = []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	}
	if !star[2] {
		possible := false
		for _, m := range months {
			if vals[2][0] <= daysIn(m) {
				possible = true
			}
		}
		if !possible {
			return "", invalid("lịch cron không bao giờ xảy ra")
		}
	}
	num := func(v int) string { return fmt.Sprintf("%02d", v) }
	part := func(i int) string {
		if star[i] {
			return "*"
		}
		return compress(vals[i], num)
	}
	cal := fmt.Sprintf("*-%s-%s %s:%s:00", part(3), part(2), part(1), part(0))
	if !star[4] {
		set := map[int]bool{}
		for _, v := range vals[4] {
			set[v%7] = true
		}
		// systemd bắt đầu tuần từ thứ Hai: đánh số Mon=0…Sun=6 để đoạn liên tiếp đúng thứ tự.
		var mon []int
		for v := range set {
			mon = append(mon, (v+6)%7)
		}
		sort.Ints(mon)
		cal = compress(mon, func(i int) string { return dowNames[(i+1)%7] }) + " " + cal
	}
	return cal, nil
}

// ---------- unit + script ----------

func cronUnit(uuid string) string { return cronPrefix + uuid }

// CronScript là nội dung script của job: một dòng lệnh, chạy bằng /bin/bash dưới uid account.
func CronScript(command string) string {
	return "#!/bin/bash\n# Sinh bởi itso-agent (cron). Không sửa tay.\n" + command + "\n"
}

// CronService sinh unit service (ADR 0021 §1).
func CronService(user string, uid int64, uuid, workDir string, timeout int64) string {
	return fmt.Sprintf(`# Sinh bởi itso-agent (cron.apply) · account %[1]s · không sửa tay
[Unit]
Description=ITSO cron %[3]s (%[1]s)

[Service]
Type=oneshot
User=%[1]s
Group=%[1]s
Slice=itso-acct-%[2]d.slice
WorkingDirectory=%[4]s
ExecStart=/bin/bash %[6]s/%[1]s/%[3]s.sh
RuntimeMaxSec=%[5]d
NoNewPrivileges=yes
PrivateTmp=yes
Nice=10
IOSchedulingClass=idle
StandardOutput=journal
StandardError=journal
SyslogIdentifier=itso-cron-%[3]s
`, user, uid, uuid, workDir, timeout, CronDir)
}

// CronTimer sinh unit timer.
func CronTimer(user, uuid, cal string) string {
	return fmt.Sprintf(`# Sinh bởi itso-agent (cron.apply) · account %[1]s · không sửa tay
[Unit]
Description=ITSO cron timer %[2]s (%[1]s)

[Timer]
OnCalendar=%[3]s
Persistent=false
AccuracySec=1s
RandomizedDelaySec=0

[Install]
WantedBy=timers.target
`, user, uuid, cal)
}

// cronUserDir tạo /etc/itso-cron/<user> (root:<group account> 0750): account khác không đọc được lệnh cron.
func (d *Deps) cronUserDir(u *passwdEntry) error {
	if err := d.mkdirs(CronDir); err != nil {
		return err
	}
	if _, err := d.FS.EnsureDir(CronDir+"/"+u.Name, 0o750, platform.Owner{GID: int(u.GID)}); err != nil {
		return opErr(err)
	}
	return nil
}

func checkCronCommand(c string) error {
	if c == "" || len(c) > maxCronBytes || strings.ContainsAny(c, "\x00\r\n") {
		return invalid("lệnh cron phải là một dòng, 1–%d byte", maxCronBytes)
	}
	return nil
}

// workDirOf kiểm working_dir (tương đối trong home, "." = home) và trả đường dẫn tuyệt đối.
func workDirOf(a contracts.Account, rel string) (string, error) {
	home := homeOf(a.Username)
	if rel == "." || rel == "" {
		return home, nil
	}
	if err := fsx.CheckPath(rel); err != nil {
		return "", &registry.OpError{Code: fsx.Code(err), Message: err.Error()}
	}
	return home + "/" + rel, nil
}

func (d *Deps) cronApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CronApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	type plan struct{ uuid, script, service, timer string }
	var want []plan
	keep := map[string]bool{}
	for _, e := range p.Entries {
		id := string(e.UUID)
		if err := validate.UUID(id); err != nil {
			return nil, opErr(err)
		}
		if keep[id] {
			return nil, invalid("uuid cron trùng: %s", id)
		}
		if err := checkCronCommand(string(e.Command)); err != nil {
			return nil, err
		}
		if e.TimeoutSec < 60 || e.TimeoutSec > 86400 {
			return nil, invalid("timeout_sec 60–86400")
		}
		cal, err := CronToOnCalendar(string(e.Schedule))
		if err != nil {
			return nil, err
		}
		wd, err := workDirOf(p.Account, string(e.WorkingDir))
		if err != nil {
			return nil, err
		}
		if !e.Enabled {
			continue
		}
		keep[id] = true
		want = append(want, plan{id, CronScript(string(e.Command)), CronService(u.Name, u.UID, id, wd, e.TimeoutSec), CronTimer(u.Name, id, cal)})
	}
	cronMu.Lock()
	defer cronMu.Unlock()
	dir := CronDir + "/" + u.Name
	existing, err := d.FS.ReadDir(dir)
	if err != nil {
		return nil, opErr(err)
	}
	var removed int64
	reload := false
	for _, name := range existing {
		id, isScript := strings.CutSuffix(name, ".sh")
		if !isScript || validate.UUID(id) != nil || keep[id] {
			continue
		}
		unit := cronUnit(id)
		if err := d.stopIfActive(ctx, unit+".timer"); err != nil {
			return nil, err
		}
		if _, err := d.run(ctx, "systemctl", "disable", unit+".timer"); err != nil {
			return nil, err
		}
		for _, f := range []string{UnitDir + "/" + unit + ".timer", UnitDir + "/" + unit + ".service", dir + "/" + name} {
			if _, err := d.FS.Remove(f); err != nil {
				return nil, opErr(err)
			}
		}
		removed++
		reload = true
	}
	var changedTimers []string
	if len(want) > 0 {
		if err := d.cronUserDir(u); err != nil {
			return nil, err
		}
	}
	for _, w := range want {
		unit := cronUnit(w.uuid)
		changed := false
		for _, f := range []struct{ path, body string }{
			{dir + "/" + w.uuid + ".sh", w.script},
			{UnitDir + "/" + unit + ".service", w.service},
			{UnitDir + "/" + unit + ".timer", w.timer},
		} {
			mode, owner := fs.FileMode(0o644), platform.Owner{}
			if strings.HasSuffix(f.path, ".sh") { // script: root:<group account> 0640 — account đọc được, không sửa được
				mode, owner = 0o640, platform.Owner{GID: int(u.GID)}
			}
			c, err := d.FS.WriteAtomic(f.path, []byte(f.body), mode, owner)
			if err != nil {
				return nil, opErr(err)
			}
			changed = changed || c
		}
		if changed {
			changedTimers = append(changedTimers, unit+".timer")
			reload = true
		}
	}
	if reload {
		if _, err := d.must(ctx, "internal", "systemctl", "daemon-reload"); err != nil {
			return nil, err
		}
	}
	for _, t := range changedTimers {
		if _, err := d.must(ctx, "internal", "systemctl", "enable", "--now", t); err != nil {
			return nil, err
		}
		if _, err := d.must(ctx, "internal", "systemctl", "restart", t); err != nil { // nạp lại OnCalendar mới
			return nil, err
		}
	}
	return toData(contracts.CronApplyResult{Count: int64(len(p.Entries)), Active: int64(len(want)), Removed: removed})
}

func unixTS(v string) *string {
	v = strings.TrimPrefix(strings.TrimSpace(v), "@")
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return nil
	}
	s := time.Unix(n, 0).UTC().Format(time.RFC3339)
	return &s
}

func (d *Deps) cronInspect(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CronInspectParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if len(p.Uuids) > 200 {
		return nil, invalid("tối đa 200 uuid")
	}
	out := contracts.CronInspectResult{Jobs: []contracts.CronInspectResultJobsItem{}}
	for _, id := range p.Uuids {
		if err := validate.UUID(string(id)); err != nil {
			return nil, opErr(err)
		}
		res, err := d.must(ctx, "internal", "systemctl", "show", cronUnit(string(id))+".service",
			"-p", "ExecMainStartTimestamp", "-p", "ExecMainExitTimestamp", "-p", "ExecMainStatus", "-p", "Result", "--timestamp=unix")
		if err != nil {
			return nil, err
		}
		kv := map[string]string{}
		for _, l := range strings.Split(string(res.Stdout), "\n") {
			if k, v, okKV := strings.Cut(l, "="); okKV {
				kv[k] = v
			}
		}
		j := contracts.CronInspectResultJobsItem{UUID: id, Result: "never",
			LastStartedAt: unixTS(kv["ExecMainStartTimestamp"]), LastFinishedAt: unixTS(kv["ExecMainExitTimestamp"])}
		if j.LastStartedAt != nil {
			if n, err := strconv.ParseInt(kv["ExecMainStatus"], 10, 64); err == nil && j.LastFinishedAt != nil {
				j.ExitCode = &n
			}
			switch {
			case kv["Result"] == "timeout":
				j.Result = "timeout"
			case kv["Result"] == "success" && (j.ExitCode == nil || *j.ExitCode == 0):
				j.Result = "success"
			default:
				j.Result = "failed"
			}
		}
		out.Jobs = append(out.Jobs, j)
	}
	return toData(out)
}

func (d *Deps) cronRunOnce(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.CronRunOnceParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	id := string(p.UUID)
	if err := validate.UUID(id); err != nil {
		return nil, opErr(err)
	}
	if err := checkCronCommand(string(p.Command)); err != nil {
		return nil, err
	}
	wd, err := workDirOf(p.Account, string(p.WorkingDir))
	if err != nil {
		return nil, err
	}
	timeout := int64(300)
	if p.TimeoutSec != nil {
		timeout = *p.TimeoutSec
	}
	if timeout < 1 || timeout > 900 {
		return nil, invalid("timeout_sec 1–900")
	}
	slice, err := validate.SliceName(u.UID)
	if err != nil {
		return nil, opErr(err)
	}
	dir := CronDir + "/" + u.Name
	script := dir + "/" + id + ".run.sh" // script riêng cho lần chạy tay: không đụng job đang lên lịch
	if err := d.cronUserDir(u); err != nil {
		return nil, err
	}
	if _, err := d.FS.WriteAtomic(script, []byte(CronScript(string(p.Command))), 0o640, platform.Owner{GID: int(u.GID)}); err != nil {
		return nil, opErr(err)
	}
	defer func() { _, _ = d.FS.Remove(script) }()
	started := d.now().UTC()
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: "systemd-run", Args: []string{
		"--wait", "--pipe", "--collect", "--quiet",
		"--unit=" + cronPrefix + "run-" + id,
		fmt.Sprintf("--uid=%d", u.UID), fmt.Sprintf("--gid=%d", u.GID), "--slice=" + slice,
		"--working-directory=" + wd,
		"-p", fmt.Sprintf("RuntimeMaxSec=%d", timeout), "-p", "NoNewPrivileges=yes", "-p", "PrivateTmp=yes",
		"/bin/bash", script,
	}})
	finished := d.now().UTC()
	if err != nil {
		return nil, opErr(err)
	}
	out := append(append([]byte{}, res.Stdout...), res.Stderr...)
	if len(out) > outputTail {
		out = out[len(out)-outputTail:]
	}
	timedOut := strings.Contains(string(res.Stderr), "result: timeout") || finished.Sub(started) >= time.Duration(timeout)*time.Second
	return toData(contracts.CronRunOnceResult{ExitCode: int64(res.ExitCode), OutputTail: strings.ToValidUTF8(string(out), "�"),
		TimedOut: timedOut, StartedAt: started.Format(time.RFC3339), FinishedAt: finished.Format(time.RFC3339)})
}
