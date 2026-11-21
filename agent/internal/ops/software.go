package ops

import (
	"context"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/validate"
)

// coreRecipes là phần mềm panel cần để thực thi giới hạn/tường lửa: không cho gỡ qua op.
var coreRecipes = map[string]bool{"acl": true, "quota": true, "nftables": true}

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{
			contracts.OpSoftwareInstall: d.softwareInstall,
			contracts.OpSoftwareRemove:  d.softwareRemove,
		}
	})
}

var aptOpts = []string{"-y", "-q", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"}

func (d *Deps) softwareInstall(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareInstallParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	pkgs, err := validate.Recipe(string(p.Recipe))
	if err != nil {
		return nil, opErr(err)
	}
	ver, err := d.pkgVersion(ctx, pkgs[0])
	if err != nil {
		return nil, err
	}
	if ver != nil {
		return toData(contracts.SoftwareInstallResult{Installed: true, Version: ver, Changed: false})
	}
	args := append(append([]string{"install"}, aptOpts...), pkgs...)
	res, err := d.run(ctx, "apt-get", args...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 { // danh sách gói cũ/thiếu: cập nhật một lần rồi thử lại
		if _, err := d.must(ctx, "dependency_unavailable", "apt-get", "update", "-q"); err != nil {
			return nil, err
		}
		if _, err := d.must(ctx, "dependency_unavailable", "apt-get", args...); err != nil {
			return nil, err
		}
	}
	if ver, err = d.pkgVersion(ctx, pkgs[0]); err != nil {
		return nil, err
	}
	return toData(contracts.SoftwareInstallResult{Installed: ver != nil, Version: ver, Changed: true})
}

func (d *Deps) softwareRemove(ctx context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.SoftwareRemoveParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	pkgs, err := validate.Recipe(string(p.Recipe))
	if err != nil {
		return nil, opErr(err)
	}
	if coreRecipes[string(p.Recipe)] {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "recipe " + string(p.Recipe) + " là thành phần lõi, không gỡ được"}
	}
	ver, err := d.pkgVersion(ctx, pkgs[0])
	if err != nil {
		return nil, err
	}
	if ver == nil {
		return toData(contracts.SoftwareRemoveResult{Installed: false, Changed: false})
	}
	if _, err := d.must(ctx, "dependency_unavailable", "apt-get", append([]string{"remove", "-y", "-q"}, pkgs...)...); err != nil {
		return nil, err
	}
	return toData(contracts.SoftwareRemoveResult{Installed: false, Changed: true})
}
