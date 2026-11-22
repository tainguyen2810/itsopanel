package ops

import (
	"context"
	"encoding/csv"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpQuotaApply:    d.quotaApply,
			contracts.OpQuotaReport:   d.quotaReport,
			contracts.OpMetricsCgroup: d.metricsCgroup,
		}
	})
}

var quotaOpts = map[string]bool{"usrquota": true, "usrjquota": true, "uquota": true, "quota": true}

// quotaMode phát hiện chế độ quota của filesystem chứa /home (ADR 0012): "kernel" nếu mount có user quota.
func (d *Deps) quotaMode(ctx context.Context) (mode, mount string, err error) {
	target := HomeBase
	if d.HomeMount != "" {
		target = d.HomeMount
	}
	res, err := d.run(ctx, "findmnt", "-n", "-o", "TARGET,FSTYPE,OPTIONS", "--target", target)
	if err != nil {
		return "", "", err
	}
	f := strings.Fields(string(res.Stdout))
	if res.ExitCode != 0 || len(f) < 3 {
		return "soft", "", nil
	}
	for _, o := range strings.Split(f[2], ",") {
		k, _, _ := strings.Cut(o, "=")
		if quotaOpts[k] {
			return "kernel", f[0], nil
		}
	}
	return "soft", f[0], nil
}

// quotaRow là một dòng repquota -O csv (đơn vị block: KiB).
type quotaRow struct {
	BlockUsed, BlockSoft, BlockHard, FileUsed, FileSoft, FileHard int64
}

// repquota đọc quota mọi user của mount (một lệnh), khóa theo UID.
func (d *Deps) repquota(ctx context.Context, mount string) (map[int64]quotaRow, error) {
	res, err := d.must(ctx, "dependency_unavailable", "repquota", "-u", "-n", "-p", "-O", "csv", mount)
	if err != nil {
		return nil, err
	}
	recs, err := csv.NewReader(strings.NewReader(string(res.Stdout))).ReadAll()
	if err != nil || len(recs) == 0 {
		return map[int64]quotaRow{}, nil
	}
	col := map[string]int{}
	for i, h := range recs[0] {
		col[strings.TrimSpace(h)] = i
	}
	get := func(r []string, name string) int64 {
		i, ok := col[name]
		if !ok || i >= len(r) {
			return 0
		}
		v, _ := strconv.ParseInt(strings.TrimSpace(r[i]), 10, 64)
		return v
	}
	out := map[int64]quotaRow{}
	for _, r := range recs[1:] {
		if len(r) == 0 {
			continue
		}
		uid, err := strconv.ParseInt(strings.TrimPrefix(strings.TrimSpace(r[0]), "#"), 10, 64)
		if err != nil {
			continue
		}
		out[uid] = quotaRow{BlockUsed: get(r, "BlockUsed"), BlockSoft: get(r, "BlockSoftLimit"), BlockHard: get(r, "BlockHardLimit"),
			FileUsed: get(r, "FileUsed"), FileSoft: get(r, "FileSoftLimit"), FileHard: get(r, "FileHardLimit")}
	}
	return out, nil
}

// QuotaLimits tính giới hạn setquota: block KiB, soft = 95% hard (ADR 0012).
func QuotaLimits(l contracts.Limits) quotaRow {
	bh := l.DiskMB * 1024
	return quotaRow{BlockSoft: bh * 95 / 100, BlockHard: bh, FileSoft: l.InodeLimit * 95 / 100, FileHard: l.InodeLimit}
}

func (d *Deps) quotaApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.QuotaApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.Limits(p.Limits).Check(); err != nil {
		return nil, opErr(err)
	}
	if _, err := d.lookupAccount(p.Account); err != nil {
		return nil, err
	}
	mode, mount, err := d.quotaMode(ctx)
	if err != nil {
		return nil, err
	}
	m := contracts.QuotaMode(mode)
	if mode != "kernel" {
		return toData(contracts.QuotaApplyResult{Applied: false, Mode: &m})
	}
	want := QuotaLimits(p.Limits)
	cur, err := d.repquota(ctx, mount)
	if err != nil {
		return nil, err
	}
	if c, ok := cur[int64(p.Account.UID)]; ok && c.BlockSoft == want.BlockSoft && c.BlockHard == want.BlockHard &&
		c.FileSoft == want.FileSoft && c.FileHard == want.FileHard {
		return toData(contracts.QuotaApplyResult{Applied: true, Mode: &m})
	}
	i := func(v int64) string { return strconv.FormatInt(v, 10) }
	if _, err := d.must(ctx, "internal", "setquota", "-u", i(int64(p.Account.UID)), i(want.BlockSoft), i(want.BlockHard),
		i(want.FileSoft), i(want.FileHard), mount); err != nil {
		return nil, err
	}
	return toData(contracts.QuotaApplyResult{Applied: true, Mode: &m})
}

// duWalk đo dung lượng (block thật) và số inode của cây thư mục, không theo symlink, không vượt filesystem.
func duWalk(root string) (kib, inodes int64) {
	var dev uint64
	if st, err := os.Lstat(root); err == nil {
		if s, ok := st.Sys().(*syscall.Stat_t); ok {
			dev = uint64(s.Dev) //nolint:unconvert // kiểu khác nhau theo arch
		}
	}
	_ = filepath.WalkDir(root, func(_ string, e fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		fi, err := e.Info()
		if err != nil {
			return nil
		}
		if s, ok := fi.Sys().(*syscall.Stat_t); ok {
			if uint64(s.Dev) != dev { //nolint:unconvert
				return filepath.SkipDir
			}
			kib += s.Blocks / 2
		}
		inodes++
		return nil
	})
	return kib, inodes
}

func (d *Deps) quotaReport(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.QuotaReportParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	for _, a := range p.Accounts {
		if err := checkAccount(a); err != nil {
			return nil, opErr(err)
		}
	}
	mode, mount, err := d.quotaMode(ctx)
	if err != nil {
		return nil, err
	}
	var rows map[int64]quotaRow
	if mode == "kernel" {
		if rows, err = d.repquota(ctx, mount); err != nil {
			return nil, err
		}
	}
	out := contracts.QuotaReportResult{Usage: []contracts.QuotaReportResultUsageItem{}}
	for _, a := range p.Accounts {
		if _, err := d.lookupAccount(a); err != nil {
			continue // account không có (hoặc lệch UID) bị bỏ qua, như mock
		}
		var kib, inodes int64
		if mode == "kernel" {
			kib, inodes = rows[int64(a.UID)].BlockUsed, rows[int64(a.UID)].FileUsed
		} else if rp, err := d.FS.Path(homeOf(a.Username)); err == nil {
			kib, inodes = duWalk(rp)
		}
		cg := d.cgroupStats(a)
		out.Usage = append(out.Usage, contracts.QuotaReportResultUsageItem{Username: a.Username, DiskMB: kib / 1024,
			Inodes: inodes, CPUPct: 0, RAMMB: cg.MemoryCurrentMB})
	}
	return toData(out)
}

// CgroupDir là thư mục cgroup v2 của slice account (itso.slice/itso-acct.slice/itso-acct-<uid>.slice).
func CgroupDir(uid contracts.UID) string {
	return fmt.Sprintf("/sys/fs/cgroup/itso.slice/itso-acct.slice/itso-acct-%d.slice", uid)
}

// keyed đọc file "khóa giá trị" của cgroup (cpu.stat, memory.events).
func keyed(s string) map[string]int64 {
	out := map[string]int64{}
	for _, l := range strings.Split(s, "\n") {
		if f := strings.Fields(l); len(f) == 2 {
			out[f[0]], _ = strconv.ParseInt(f[1], 10, 64)
		}
	}
	return out
}

func (d *Deps) cgroupStats(a contracts.Account) contracts.MetricsCgroupResultAccountsItem {
	dir := CgroupDir(a.UID)
	num := func(name string) (int64, bool) {
		v, err := strconv.ParseInt(d.hostFile(dir+"/"+name), 10, 64)
		return v, err == nil
	}
	cpu := keyed(d.hostFile(dir + "/cpu.stat"))
	item := contracts.MetricsCgroupResultAccountsItem{Username: a.Username, CPUUsageUsec: cpu["usage_usec"],
		CPUThrottledUsec: cpu["throttled_usec"], OomKills: keyed(d.hostFile(dir + "/memory.events"))["oom_kill"]}
	if v, ok := num("memory.current"); ok {
		item.MemoryCurrentMB = v >> 20
	}
	if v, ok := num("memory.max"); ok { // "max" = không giới hạn → null
		mb := v >> 20
		item.MemoryMaxMB = &mb
	}
	if v, ok := num("pids.current"); ok {
		item.PidsCurrent = v
	}
	return item
}

func (d *Deps) metricsCgroup(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.MetricsCgroupParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	out := contracts.MetricsCgroupResult{Accounts: []contracts.MetricsCgroupResultAccountsItem{}, SampledAt: d.now().UTC().Format(time.RFC3339)}
	for _, a := range p.Accounts {
		if err := checkAccount(a); err != nil {
			return nil, opErr(err)
		}
		out.Accounts = append(out.Accounts, d.cgroupStats(a))
	}
	return toData(out)
}
