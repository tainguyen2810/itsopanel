package ops

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"sort"
	"strings"
	"sync"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// PHP-FPM: master riêng mỗi account (unit itso-php@<ver>-<user>), pool theo website (D-68, ADR 0015).

// PHPSupportedVersion là phiên bản PHP duy nhất Phase 5 hỗ trợ (kho Ubuntu 24.04).
const PHPSupportedVersion = "8.3"

const (
	phpConfBase = "/etc/itso/php"
	phpRunDir   = "/run/itso/php"
)

var phpMu sync.Mutex

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpPHPPoolApply:      d.phpPoolApply,
			contracts.OpPHPPoolRemove:     d.phpPoolRemove,
			contracts.OpPHPVersionInstall: d.phpVersionInstall,
			contracts.OpPHPVersionRemove:  d.phpVersionRemove,
			contracts.OpPHPExtInstall:     d.phpExtInstall,
		}
	})
}

func phpAcctDir(ver string, u contracts.Username) string {
	return phpConfBase + "/" + ver + "/" + string(u)
}

func poolPath(ver string, u contracts.Username, websiteUUID string) string {
	return phpAcctDir(ver, u) + "/pool.d/" + PoolKey(websiteUUID) + ".conf"
}

// PHPUnit là instance systemd master PHP-FPM của account.
func PHPUnit(ver string, u contracts.Username) string {
	return "itso-php@" + ver + "-" + string(u) + ".service"
}

func phpDropIn(ver string, u contracts.Username) string {
	return "/etc/systemd/system/itso-php@" + ver + "-" + string(u) + ".service.d/10-itso.conf"
}

func phpBin(ver string) string { return "php-fpm" + ver }

// runAs chạy lệnh dưới uid/gid account (setresuid trong tiến trình con, không su/sudo).
func (d *Deps) runAs(ctx context.Context, cred platform.Cred, bin string, args ...string) (platform.Result, error) {
	res, err := d.Run.Run(ctx, platform.Cmd{Bin: bin, Args: args, As: &cred})
	if err != nil {
		if ctx.Err() != nil {
			return res, &registry.OpError{Code: "deadline_exceeded", Message: bin + ": " + ctx.Err().Error(), Retryable: true}
		}
		return res, &registry.OpError{Code: "dependency_unavailable", Message: bin + ": " + err.Error(), Retryable: true}
	}
	return res, nil
}

type poolData struct {
	WebsiteUUID, User, SiteDir, Pool, Socket, SiteRoot, MemoryLimit, UploadMax, DisableFunctions string
	MaxChildren, MaxExecutionTime                                                                int64
}

type masterData struct {
	Version, User string
	UID           int64
}

func checkPool(p contracts.PHPPoolApplyParams) (*poolData, error) {
	if err := checkAccount(p.Account); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(p.WebsiteUUID)); err != nil {
		return nil, err
	}
	if err := validate.Domain(string(p.SiteDir)); err != nil {
		return nil, err
	}
	if err := validate.PHPVersion(string(p.Version), true); err != nil {
		return nil, err
	}
	if p.PmMaxChildren < 1 || p.PmMaxChildren > 64 {
		return nil, &validate.Error{Code: "invalid_params", Field: "pm_max_children", Msg: "1–64"}
	}
	if p.MaxExecutionTime < 1 || p.MaxExecutionTime > 3600 {
		return nil, &validate.Error{Code: "invalid_params", Field: "max_execution_time", Msg: "1–3600 giây"}
	}
	for _, s := range []string{string(p.MemoryLimit), string(p.UploadMaxFilesize)} {
		if err := validate.NginxSize(s); err != nil {
			return nil, err
		}
	}
	if err := validate.PHPFunctions(p.DisableFunctions); err != nil {
		return nil, err
	}
	fns := append([]string(nil), p.DisableFunctions...)
	sort.Strings(fns)
	return &poolData{WebsiteUUID: string(p.WebsiteUUID), User: string(p.Account.Username), SiteDir: string(p.SiteDir),
		Pool: string(p.Account.Username) + "-" + PoolKey(string(p.WebsiteUUID)), Socket: PHPSocket(p.Account.Username, string(p.WebsiteUUID)),
		SiteRoot: siteRoot(p.Account.Username, string(p.SiteDir)), MemoryLimit: strings.ToUpper(string(p.MemoryLimit)),
		UploadMax: strings.ToUpper(string(p.UploadMaxFilesize)), DisableFunctions: strings.Join(fns, ","),
		MaxChildren: p.PmMaxChildren, MaxExecutionTime: p.MaxExecutionTime}, nil
}

// RenderPool sinh pool PHP-FPM từ params đã validate (cho test/fuzz).
func RenderPool(p contracts.PHPPoolApplyParams) ([]byte, error) {
	v, err := checkPool(p)
	if err != nil {
		return nil, err
	}
	return render("pool.conf.tmpl", v)
}

func (d *Deps) phpPoolApply(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PHPPoolApplyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	v, err := checkPool(p)
	if err != nil {
		return nil, opErr(err)
	}
	ver, u := string(p.Version), p.Account.Username
	pool, err := render("pool.conf.tmpl", v)
	if err != nil {
		return nil, opErr(err)
	}
	md := masterData{Version: ver, User: string(u), UID: int64(p.Account.UID)}
	master, err := render("php-fpm.conf.tmpl", md)
	if err != nil {
		return nil, opErr(err)
	}
	dropin, err := render("php-dropin.conf.tmpl", md)
	if err != nil {
		return nil, opErr(err)
	}
	usr, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	if !d.FS.Exists(v.SiteRoot + "/tmp") {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "chưa có bố cục site (fs.site_layout.ensure trước)"}
	}
	if pv, err := d.pkgVersion(ctx, "php"+ver+"-fpm"); err != nil {
		return nil, err
	} else if pv == nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "PHP " + ver + " chưa cài (php.version.install)"}
	}

	phpMu.Lock()
	defer phpMu.Unlock()
	path := poolPath(ver, u, v.WebsiteUUID)
	old, rerr := d.FS.ReadFile(path)
	existed := rerr == nil
	if rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return nil, opErr(rerr)
	}
	if existed && !bytes.Contains(old, []byte("; website "+v.WebsiteUUID+" ")) {
		return nil, &registry.OpError{Code: "already_exists", Message: "pool " + PoolKey(v.WebsiteUUID) + " đã thuộc website khác của account"}
	}
	for _, dir := range []string{phpAcctDir(ver, u) + "/pool.d", "/run/itso"} {
		if err := d.FS.MkdirAll(dir); err != nil {
			return nil, opErr(err)
		}
	}
	// /run/itso/php 1733: mọi master (uid account) tạo được socket nhưng không liệt kê/xóa của nhau.
	if _, err := d.FS.EnsureDir(phpRunDir, fs.ModeSticky|0o733, platform.Owner{}); err != nil {
		return nil, opErr(err)
	}
	poolChanged, err := d.FS.WriteAtomic(path, pool, 0o644, platform.Owner{})
	if err != nil {
		return nil, opErr(err)
	}
	masterChanged, err := d.FS.WriteAtomic(phpAcctDir(ver, u)+"/php-fpm.conf", master, 0o644, platform.Owner{})
	if err != nil {
		return nil, opErr(err)
	}
	if err := d.FS.MkdirAll(strings.TrimSuffix(phpDropIn(ver, u), "/10-itso.conf")); err != nil {
		return nil, opErr(err)
	}
	dropChanged, err := d.FS.WriteAtomic(phpDropIn(ver, u), dropin, 0o644, platform.Owner{})
	if err != nil {
		return nil, opErr(err)
	}
	changed := poolChanged || masterChanged || dropChanged
	if changed {
		// Kiểm cấu hình dưới uid account (đúng quyền đọc mà master sẽ có).
		res, err := d.runAs(ctx, platform.Cred{UID: uint32(usr.UID), GID: uint32(usr.GID)}, phpBin(ver), "-t", "--fpm-config", phpAcctDir(ver, u)+"/php-fpm.conf")
		if err != nil {
			return nil, err
		}
		if res.ExitCode != 0 {
			if existed {
				_, err = d.FS.WriteAtomic(path, old, 0o644, platform.Owner{})
			} else {
				_, err = d.FS.Remove(path)
			}
			if err != nil {
				return nil, &registry.OpError{Code: "internal", Message: "php-fpm -t lỗi và hoàn tác thất bại: " + err.Error()}
			}
			return nil, cmdFailed("config_test_failed", "php-fpm -t", res)
		}
	}
	if dropChanged {
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "daemon-reload"); err != nil {
			return nil, err
		}
	}
	unit := PHPUnit(ver, u)
	reloaded := false
	st, err := d.run(ctx, "systemctl", "is-active", unit)
	if err != nil {
		return nil, err
	}
	switch {
	case st.ExitCode != 0:
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "enable", "--now", unit); err != nil {
			return nil, err
		}
		reloaded = true
	case dropChanged:
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "restart", unit); err != nil {
			return nil, err
		}
		reloaded = true
	case changed:
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", unit); err != nil {
			return nil, err
		}
		reloaded = true
	}
	return toData(contracts.PHPPoolApplyResult{Socket: v.Socket, Unit: unit, Reloaded: reloaded, Changed: changed})
}

func (d *Deps) phpPoolRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PHPPoolRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := checkAccount(p.Account); err != nil {
		return nil, opErr(err)
	}
	if err := validate.UUID(string(p.WebsiteUUID)); err != nil {
		return nil, opErr(err)
	}
	u, id := p.Account.Username, string(p.WebsiteUUID)
	phpMu.Lock()
	defer phpMu.Unlock()
	vers, err := d.FS.ReadDir(phpConfBase)
	if err != nil {
		return nil, opErr(err)
	}
	removed := false
	for _, ver := range vers {
		if validate.PHPVersion(ver, false) != nil {
			continue
		}
		path := poolPath(ver, u, id)
		b, err := d.FS.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, opErr(err)
		}
		if !bytes.Contains(b, []byte("; website "+id+" ")) {
			continue // pool trùng hex8 của website khác: không đụng tới
		}
		if _, err := d.FS.Remove(path); err != nil {
			return nil, opErr(err)
		}
		removed = true
		rest, err := d.FS.ReadDir(phpAcctDir(ver, u) + "/pool.d")
		if err != nil {
			return nil, opErr(err)
		}
		unit := PHPUnit(ver, u)
		if len(rest) == 0 { // hết pool: dừng master, xóa cấu hình master + drop-in
			if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "disable", "--now", unit); err != nil {
				return nil, err
			}
			for _, f := range []string{phpAcctDir(ver, u) + "/php-fpm.conf", phpDropIn(ver, u)} {
				if _, err := d.FS.Remove(f); err != nil {
					return nil, opErr(err)
				}
			}
			if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "daemon-reload"); err != nil {
				return nil, err
			}
			continue
		}
		if st, err := d.run(ctx, "systemctl", "is-active", unit); err != nil {
			return nil, err
		} else if st.ExitCode == 0 {
			if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", unit); err != nil {
				return nil, err
			}
		}
	}
	return toData(contracts.PHPPoolRemoveResult{Removed: removed})
}

// phpPackages trả gói apt cho phiên bản + extension (allowlist).
func phpPackages(ver string, exts []contracts.PHPExtension) ([]string, error) {
	pkgs := []string{"php" + ver + "-fpm", "php" + ver + "-cli", "php" + ver + "-common"}
	for _, e := range exts {
		if err := validate.PHPExtension(string(e)); err != nil {
			return nil, err
		}
		if pk := "php" + ver + "-" + string(e); !contains(pkgs, pk) {
			pkgs = append(pkgs, pk)
		}
	}
	return pkgs, nil
}

// aptEnsure cài các gói còn thiếu; trả danh sách gói đã cài thêm.
func (d *Deps) aptEnsure(ctx context.Context, pkgs []string) ([]string, error) {
	var missing []string
	for _, pk := range pkgs {
		v, err := d.pkgVersion(ctx, pk)
		if err != nil {
			return nil, err
		}
		if v == nil {
			missing = append(missing, pk)
		}
	}
	if len(missing) == 0 {
		return nil, nil
	}
	args := append(append([]string{"install"}, aptOpts...), missing...)
	res, err := d.run(ctx, "apt-get", args...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		if _, err := d.must(ctx, "dependency_unavailable", "apt-get", "update", "-q"); err != nil {
			return nil, err
		}
		if _, err := d.must(ctx, "dependency_unavailable", "apt-get", args...); err != nil {
			return nil, err
		}
	}
	return missing, nil
}

func (d *Deps) phpVersionInstall(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PHPVersionInstallParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.PHPVersion(string(p.Version), true); err != nil {
		return nil, opErr(err)
	}
	pkgs, err := phpPackages(string(p.Version), p.Extensions)
	if err != nil {
		return nil, opErr(err)
	}
	added, err := d.aptEnsure(ctx, pkgs)
	if err != nil {
		return nil, err
	}
	if len(added) > 0 && contains(added, "php"+string(p.Version)+"-fpm") {
		// Master mặc định của gói không dùng: mỗi account có master riêng (itso-php@).
		if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "disable", "--now", "php"+string(p.Version)+"-fpm.service"); err != nil {
			return nil, err
		}
	}
	return toData(contracts.PHPVersionInstallResult{Installed: true, Changed: len(added) > 0})
}

func (d *Deps) phpVersionRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PHPVersionRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ver := string(p.Version)
	// Chỉ gỡ phiên bản agent quản lý (8.3); PHP khác do người khác cài, không đụng tới.
	if err := validate.PHPVersion(ver, true); err != nil {
		return nil, opErr(err)
	}
	accts, err := d.FS.ReadDir(phpConfBase + "/" + ver)
	if err != nil {
		return nil, opErr(err)
	}
	for _, a := range accts {
		if pools, err := d.FS.ReadDir(phpConfBase + "/" + ver + "/" + a + "/pool.d"); err == nil && len(pools) > 0 {
			return nil, &registry.OpError{Code: "precondition_failed", Message: "PHP " + ver + " còn pool của account " + a + " (chuyển/xóa website trước)"}
		}
	}
	v, err := d.pkgVersion(ctx, "php"+ver+"-fpm")
	if err != nil {
		return nil, err
	}
	if v == nil {
		return toData(contracts.PHPVersionRemoveResult{Removed: false})
	}
	if _, err := d.must(ctx, "dependency_unavailable", "apt-get", "remove", "-y", "-q", "php"+ver+"-fpm", "php"+ver+"-cli", "php"+ver+"-common"); err != nil {
		return nil, err
	}
	return toData(contracts.PHPVersionRemoveResult{Removed: true})
}

func (d *Deps) phpExtInstall(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PHPExtInstallParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	ver := string(p.Version)
	if err := validate.PHPVersion(ver, true); err != nil {
		return nil, opErr(err)
	}
	if len(p.Extensions) == 0 || len(p.Extensions) > 20 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "extensions: 1–20"}
	}
	var pkgs []string
	exts := []contracts.PHPExtension{}
	for _, e := range p.Extensions {
		if err := validate.PHPExtension(string(e)); err != nil {
			return nil, opErr(err)
		}
		pkgs = append(pkgs, "php"+ver+"-"+string(e))
		exts = append(exts, e)
	}
	if v, err := d.pkgVersion(ctx, "php"+ver+"-fpm"); err != nil {
		return nil, err
	} else if v == nil {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "PHP " + ver + " chưa cài (php.version.install)"}
	}
	added, err := d.aptEnsure(ctx, pkgs)
	if err != nil {
		return nil, err
	}
	if len(added) > 0 { // master đang chạy nạp extension mới khi reload
		accts, err := d.FS.ReadDir(phpConfBase + "/" + ver)
		if err != nil {
			return nil, opErr(err)
		}
		for _, a := range accts {
			if validate.Username(a) != nil {
				continue
			}
			unit := PHPUnit(ver, contracts.Username(a))
			if st, err := d.run(ctx, "systemctl", "is-active", unit); err == nil && st.ExitCode == 0 {
				if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "reload", unit); err != nil {
					return nil, err
				}
			}
		}
	}
	sort.Slice(exts, func(i, j int) bool { return exts[i] < exts[j] })
	return toData(contracts.PHPExtInstallResult{Installed: exts, Changed: len(added) > 0})
}
