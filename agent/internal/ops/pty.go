package ops

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
	"itso.local/agent/internal/term"
	"itso.local/agent/internal/validate"
)

// Terminal USER (D-75, ADR 0022): pty.open chỉ cấp ticket một lần 30 s; shell chạy khi itso-gateway ATTACH qua
// socket stream. Jail: systemd-run --pty dưới uid account trong slice, chỉ thấy home của mình.

// LoginShell là shell của account có quyền SSH (ProvisioningService đặt /bin/bash khi gói ssh_allowed).
const LoginShell = "/bin/bash"

func init() {
	extraRegistrations = append(extraRegistrations, func(d *Deps) map[string]registry.Handler {
		return map[string]registry.Handler{contracts.OpPtyOpen: d.ptyOpen}
	})
}

func (d *Deps) ptyOpen(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PtyOpenParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(p.SessionUUID)); err != nil {
		return nil, opErr(err)
	}
	if p.Cols < 20 || p.Cols > 500 || p.Rows < 5 || p.Rows > 200 || p.IdleTimeoutSec < 60 || p.IdleTimeoutSec > 3600 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "cols/rows/idle_timeout_sec ngoài miền"}
	}
	u, err := d.lookupAccount(p.Account)
	if err != nil {
		return nil, err
	}
	if u.UID < validate.UIDMin || u.UID == 0 {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "chỉ mở terminal cho user account (uid ≥ 20000)"}
	}
	if u.Shell != LoginShell {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "account không có quyền SSH (shell " + u.Shell + ")"}
	}
	if d.Term == nil {
		return nil, &registry.OpError{Code: "dependency_unavailable", Message: "agent chưa bật socket terminal", Retryable: true}
	}
	t, exp, err := d.Term.Issue(term.Session{UUID: string(p.SessionUUID), User: u.Name, UID: int(u.UID), GID: int(u.GID),
		Home: homeOf(p.Account.Username), Cols: int(p.Cols), Rows: int(p.Rows), Idle: time.Duration(p.IdleTimeoutSec) * time.Second})
	if errors.Is(err, term.ErrLimit) {
		return nil, &registry.OpError{Code: "quota_exceeded", Message: err.Error()}
	}
	if err != nil {
		return nil, &registry.OpError{Code: "internal", Message: "không sinh được ticket", Retryable: true}
	}
	return toData(contracts.PtyOpenResult{Ticket: t, ExpiresAt: exp.UTC().Format(time.RFC3339), UnixUser: contracts.Username(u.Name)})
}

// TermUnit là tên transient unit của phiên.
func TermUnit(s *term.Session) string { return "itso-term-" + s.UUID + ".service" }

// TermArgv là argv systemd-run của shell trong jail (golden test).
func TermArgv(s *term.Session) ([]string, error) {
	slice, err := validate.SliceName(int64(s.UID))
	if err != nil {
		return nil, err
	}
	if err := validate.UUID(s.UUID); err != nil {
		return nil, err
	}
	if err := validate.Username(s.User); err != nil {
		return nil, err
	}
	home := HomeBase + "/" + s.User
	return []string{"--pty", "--quiet", "--collect", "--service-type=exec", "--unit=" + TermUnit(s),
		fmt.Sprintf("--uid=%d", s.UID), fmt.Sprintf("--gid=%d", s.GID), "--slice=" + slice,
		"-p", "ProtectSystem=strict", "-p", "ProtectHome=tmpfs", "-p", "BindPaths=" + home, "-p", "PrivateTmp=yes",
		"-p", "PrivateDevices=yes", "-p", "NoNewPrivileges=yes", "-p", "RestrictSUIDSGID=yes", "-p", "ProtectKernelTunables=yes",
		"-p", "ProtectKernelModules=yes", "-p", "ProtectControlGroups=yes", "-p", "ProtectProc=invisible", "-p", "ProcSubset=pid",
		"--working-directory=" + home, "-E", "HOME=" + home, "-E", "USER=" + s.User, "-E", "LOGNAME=" + s.User,
		"-E", "SHELL=" + LoginShell, "-E", "TERM=xterm-256color", "-E", "LANG=C.UTF-8", LoginShell, "-l"}, nil
}

// NewTermManager tạo bộ quản lý phiên: sandbox → shell giả; thật → systemd-run --pty (runner phải cấp được pty).
func NewTermManager(d *Deps, log *slog.Logger) *term.Manager {
	m := &term.Manager{Now: d.Now, Log: log}
	if d.Sandbox {
		m.Spawn = func(_ context.Context, s *term.Session) (term.Proc, error) { return term.NewFakeShell(s), nil }
		return m
	}
	m.Spawn = func(_ context.Context, s *term.Session) (term.Proc, error) {
		st, ok := d.Run.(platform.PTYStarter)
		if !ok {
			return nil, errors.New("runner không cấp được pty")
		}
		argv, err := TermArgv(s)
		if err != nil {
			return nil, err
		}
		t, err := st.StartPTY(platform.Cmd{Bin: "systemd-run", Args: argv}, s.Cols, s.Rows)
		if err != nil {
			return nil, err
		}
		return ttyProc{t}, nil
	}
	m.Stop = func(s *term.Session) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = d.Run.Run(ctx, platform.Cmd{Bin: "systemctl", Args: []string{"stop", "--no-block", TermUnit(s)}})
	}
	return m
}

type ttyProc struct{ t *platform.TTY }

func (p ttyProc) Read(b []byte) (int, error)  { return p.t.Master.Read(b) }
func (p ttyProc) Write(b []byte) (int, error) { return p.t.Master.Write(b) }
func (p ttyProc) Close() error                { return p.t.Close() }
func (p ttyProc) Resize(c, r int) error       { return p.t.Resize(c, r) }
func (p ttyProc) Done() <-chan struct{}       { return p.t.Done() }
