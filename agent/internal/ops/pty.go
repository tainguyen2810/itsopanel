package ops

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
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
		return map[string]registry.Handler{contracts.OpPtyOpen: d.ptyOpen, contracts.OpPtyOpenRoot: d.ptyOpenRoot,
			contracts.OpPtyPolicy: d.ptyPolicy, contracts.OpPtyList: d.ptyList, contracts.OpPtyRecordingRead: d.ptyRecordingRead}
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
		Home: homeOf(p.Account.Username), Cols: int(p.Cols), Rows: int(p.Rows), Idle: time.Duration(p.IdleTimeoutSec) * time.Second,
		Mode: "account", Record: d.RecordUser})
	if err := issueErr(err); err != nil {
		return nil, err
	}
	return toData(contracts.PtyOpenResult{Ticket: t, ExpiresAt: exp.UTC().Format(time.RFC3339), UnixUser: contracts.Username(u.Name)})
}

func issueErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, term.ErrLimit):
		return &registry.OpError{Code: "quota_exceeded", Message: err.Error()}
	case errors.Is(err, term.ErrDuplicate):
		return &registry.OpError{Code: "already_exists", Message: err.Error()}
	}
	return &registry.OpError{Code: "internal", Message: "không sinh được ticket", Retryable: true}
}

// ptyOpenRoot (ADR 0028): chỉ khi policy cục bộ root_terminal=true (bật bằng `itso policy set terminal.root on`
// trên máy chủ). Panel không có op ghi policy. Phiên root luôn được ghi; không ghi được thì không mở.
func (d *Deps) ptyOpenRoot(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PtyOpenRootParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if !d.RootTerminal {
		return nil, &registry.OpError{Code: "op_disabled", Message: "terminal root đang tắt trong policy cục bộ (itso policy set terminal.root on)"}
	}
	if err := validate.UUID(string(p.SessionUUID)); err != nil {
		return nil, opErr(err)
	}
	if p.Cols < 20 || p.Cols > 500 || p.Rows < 5 || p.Rows > 200 || p.IdleTimeoutSec < 60 || p.IdleTimeoutSec > 3600 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "cols/rows/idle_timeout_sec ngoài miền"}
	}
	if d.Term == nil {
		return nil, &registry.OpError{Code: "dependency_unavailable", Message: "agent chưa bật socket terminal", Retryable: true}
	}
	if d.Term.RecDir == "" {
		return nil, &registry.OpError{Code: "dependency_unavailable", Message: "chưa có thư mục ghi phiên", Retryable: true}
	}
	t, exp, err := d.Term.Issue(term.Session{UUID: string(p.SessionUUID), User: "root", UID: 0, GID: 0, Home: "/root",
		Cols: int(p.Cols), Rows: int(p.Rows), Idle: time.Duration(p.IdleTimeoutSec) * time.Second, Mode: "root", Record: true})
	if err := issueErr(err); err != nil {
		return nil, err
	}
	return toData(contracts.PtyOpenRootResult{Ticket: t, ExpiresAt: exp.UTC().Format(time.RFC3339), UnixUser: "root", Recording: true})
}

// IdleTimeoutSec là thời gian nhàn rỗi mặc định panel dùng (TerminalService::IDLE_SEC).
const IdleTimeoutSec = 900

func (d *Deps) ptyPolicy(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PtyPolicyParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	return toData(contracts.PtyPolicyResult{RootEnabled: d.RootTerminal, RecordRoot: true, RecordUser: d.RecordUser,
		MaxSessionsPerAccount: term.MaxPerAccount, IdleTimeoutSec: IdleTimeoutSec})
}

func (d *Deps) ptyList(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PtyListParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	out := contracts.PtyListResult{Sessions: []contracts.PtyListResultSessionsItem{}}
	if d.Term != nil {
		for _, l := range d.Term.Lives() {
			if len(out.Sessions) == 500 {
				break
			}
			out.Sessions = append(out.Sessions, contracts.PtyListResultSessionsItem{SessionUUID: contracts.UUID(l.UUID),
				Mode: l.Mode, UnixUser: l.User, StartedAt: l.Started.UTC().Format(time.RFC3339),
				LastInputAt: l.LastInput.UTC().Format(time.RFC3339), Recording: l.Recording, RecordingBytes: contracts.Bytes(l.RecordingBytes)})
		}
	}
	return toData(out)
}

func (d *Deps) ptyRecordingRead(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	var p contracts.PtyRecordingReadParams
	if err := decode(env, &p); err != nil {
		return nil, err
	}
	if err := validate.UUID(string(p.SessionUUID)); err != nil {
		return nil, opErr(err)
	}
	if p.Offset < 0 || p.MaxBytes < 1024 || p.MaxBytes > 1<<20 {
		return nil, &registry.OpError{Code: "invalid_params", Message: "offset/max_bytes ngoài miền"}
	}
	dir, err := d.FS.Path(RecordingDir)
	if err != nil {
		return nil, opErr(err)
	}
	path, err := term.RecordingPath(dir, string(p.SessionUUID))
	if err != nil {
		return nil, opErr(err)
	}
	live := d.Term != nil && d.Term.Recording(string(p.SessionUUID))
	pg, err := term.ReadPage(path, p.Offset, p.MaxBytes, live)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &registry.OpError{Code: "not_found", Message: "không có bản ghi cho phiên này"}
	}
	if err != nil {
		return nil, &registry.OpError{Code: "invalid_params", Message: err.Error()}
	}
	res := contracts.PtyRecordingReadResult{Width: int64(pg.Width), Height: int64(pg.Height), NextOffset: pg.NextOffset,
		Truncated: pg.Truncated, Eof: pg.EOF, Events: make([]contracts.PtyRecordingReadResultEventsItem, 0, len(pg.Events))}
	for _, e := range pg.Events {
		res.Events = append(res.Events, contracts.PtyRecordingReadResultEventsItem{T: e.T, Data: e.Data})
	}
	return toData(res)
}

// RecordingDir là thư mục bản ghi phiên (root 0700, file 0600).
const RecordingDir = "/var/lib/itso/recordings"

// TermUnit là tên transient unit của phiên.
func TermUnit(s *term.Session) string { return "itso-term-" + s.UUID + ".service" }

// TermArgv là argv systemd-run của shell trong jail (golden test).
func TermArgv(s *term.Session) ([]string, error) {
	if s.ModeOf() == "root" {
		if err := validate.UUID(s.UUID); err != nil {
			return nil, err
		}
		if s.User != "root" || s.UID != 0 {
			return nil, errors.New("phiên root phải là user root")
		}
		return []string{"--pty", "--quiet", "--collect", "--service-type=exec", "--unit=" + TermUnit(s),
			"--slice=system.slice", "--working-directory=/root", "-E", "HOME=/root", "-E", "USER=root", "-E", "LOGNAME=root",
			"-E", "SHELL=" + LoginShell, "-E", "TERM=xterm-256color", "-E", "LANG=C.UTF-8", LoginShell, "-l"}, nil
	}
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
	if dir, err := d.FS.Path(RecordingDir); err == nil {
		m.RecDir = dir
	}
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
