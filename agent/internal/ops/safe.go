package ops

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sync"
	"time"

	"itso.local/agent/internal/platform"
	"itso.local/agent/internal/registry"
)

// Safe-apply dùng chung cho tường lửa và SSH (D-76, D-77, ADR 0023/0024):
//
//  1. lưu cấu hình cũ vào <dir>/<apply_id>.prev, áp dụng cấu hình mới;
//  2. hẹn hoàn tác bằng transient timer systemd (`systemd-run --on-active`) gọi
//     `itso-agent safe-rollback <kind> <apply_id>` — vẫn chạy khi agent/panel chết;
//  3. trả token ngẫu nhiên; trình duyệt xác nhận bằng request mới → `*.confirm{apply_id, token}` dừng timer.
//
// Ngoài timer, mọi op của loại đó (và lúc agent khởi động) kiểm hạn: quá hạn mà còn chờ → hoàn tác ngay
// (phòng khi timer không chạy được, và để test bằng đồng hồ giả).

// AgentBin là binary agent mà timer hoàn tác gọi lại (đường dẫn cài đặt, packaging/systemd/itso-agent.service).
const AgentBin = "/opt/itso/current/bin/itso-agent"

type safeKind struct {
	name string // "firewall" | "sshd"
	dir  string // /var/lib/itso/<name>
	unit string // tên transient unit hoàn tác
	// restore khôi phục cấu hình đã lưu ở <dir>/<apply_id>.prev.
	restore func(ctx context.Context, d *Deps, k safeKind, applyID string) error
}

type safePending struct {
	ApplyID     string `json:"apply_id"`
	TokenSHA256 string `json:"token_sha256"`
	RollbackAt  string `json:"rollback_at"`
	CreatedAt   string `json:"created_at"`
}

type safeState struct {
	State   string `json:"state"` // idle|pending_confirm|confirmed|rolled_back
	ApplyID string `json:"apply_id,omitempty"`
	At      string `json:"at,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
	Rules   int64  `json:"rules,omitempty"`
}

var safeMu sync.Mutex // tuần tự hóa mọi safe-apply/confirm/rollback (cả hai loại)

func (k safeKind) pendingPath() string       { return k.dir + "/pending.json" }
func (k safeKind) statePath() string         { return k.dir + "/state.json" }
func (k safeKind) prevPath(id string) string { return k.dir + "/" + id + ".prev" }

func (d *Deps) safeReadJSON(p string, v any) (bool, error) {
	b, err := d.FS.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, opErr(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, &registry.OpError{Code: "internal", Message: p + " hỏng: " + err.Error()}
	}
	return true, nil
}

func (d *Deps) safeWriteJSON(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if _, err := d.FS.WriteAtomic(p, append(b, '\n'), 0o600, platform.Owner{}); err != nil {
		return opErr(err)
	}
	return nil
}

func (d *Deps) safeState(k safeKind) (safeState, error) {
	st := safeState{State: "idle"}
	_, err := d.safeReadJSON(k.statePath(), &st)
	return st, err
}

func (d *Deps) safePending(k safeKind) (*safePending, error) {
	var p safePending
	found, err := d.safeReadJSON(k.pendingPath(), &p)
	if err != nil || !found {
		return nil, err
	}
	return &p, nil
}

// safeExpire hoàn tác lần áp dụng đang chờ nếu đã quá hạn. Gọi khi giữ safeMu.
func (d *Deps) safeExpire(ctx context.Context, k safeKind) error {
	p, err := d.safePending(k)
	if err != nil || p == nil {
		return err
	}
	at, err := time.Parse(time.RFC3339, p.RollbackAt)
	if err == nil && d.now().Before(at) {
		return nil
	}
	return d.safeRollbackLocked(ctx, k, p.ApplyID)
}

// safeRollbackLocked khôi phục cấu hình cũ, ghi trạng thái rolled_back, dừng timer (nếu còn).
func (d *Deps) safeRollbackLocked(ctx context.Context, k safeKind, applyID string) error {
	p, err := d.safePending(k)
	if err != nil {
		return err
	}
	if p == nil || p.ApplyID != applyID {
		return nil // đã xác nhận hoặc đã hoàn tác: không làm gì (timer chạy muộn)
	}
	if err := k.restore(ctx, d, k, applyID); err != nil {
		return err
	}
	if err := d.safeWriteJSON(k.statePath(), safeState{State: "rolled_back", ApplyID: applyID,
		At: d.now().UTC().Format(time.RFC3339)}); err != nil {
		return err
	}
	if _, err := d.FS.Remove(k.pendingPath()); err != nil {
		return opErr(err)
	}
	_, _ = d.FS.Remove(k.prevPath(applyID))
	// Khi chính timer gọi thì unit đang chạy; stop trên timer không ảnh hưởng service hiện tại.
	_, _ = d.run(ctx, "systemctl", "stop", k.unit+".timer")
	return nil
}

// safeArm ghi lần chờ xác nhận và hẹn timer hoàn tác. Trả token thô (chỉ trả về một lần) và hạn.
func (d *Deps) safeArm(ctx context.Context, k safeKind, applyID string, within int64) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	at := d.now().Add(time.Duration(within) * time.Second).UTC().Truncate(time.Second)
	if err := d.safeWriteJSON(k.pendingPath(), safePending{ApplyID: applyID, TokenSHA256: hex.EncodeToString(sum[:]),
		RollbackAt: at.Format(time.RFC3339), CreatedAt: d.now().UTC().Format(time.RFC3339)}); err != nil {
		return "", time.Time{}, err
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemd-run", "--quiet", "--collect",
		fmt.Sprintf("--on-active=%ds", within), "--unit="+k.unit, "--timer-property=AccuracySec=1s",
		"--description=ITSO safe-apply rollback ("+k.name+")",
		AgentBin, "safe-rollback", k.name, applyID); err != nil {
		// Không hẹn được timer thì không được giữ cấu hình mới: hoàn tác ngay.
		if rb := d.safeRollbackLocked(ctx, k, applyID); rb != nil {
			return "", time.Time{}, &registry.OpError{Code: "internal", Message: "không hẹn được timer và hoàn tác thất bại: " + rb.Error()}
		}
		return "", time.Time{}, err
	}
	if err := d.safeWriteJSON(k.statePath(), safeState{State: "pending_confirm", ApplyID: applyID,
		At: d.now().UTC().Format(time.RFC3339)}); err != nil {
		return "", time.Time{}, err
	}
	return token, at, nil
}

// safeBegin kiểm hạn lần trước và từ chối khi còn một lần đang chờ (mỗi loại chỉ một).
func (d *Deps) safeBegin(ctx context.Context, k safeKind) error {
	if err := d.mkdirs(k.dir); err != nil {
		return err
	}
	if err := d.safeExpire(ctx, k); err != nil {
		return err
	}
	p, err := d.safePending(k)
	if err != nil {
		return err
	}
	if p != nil {
		return &registry.OpError{Code: "busy", Message: k.name + ": còn lần áp dụng " + p.ApplyID + " chờ xác nhận", Retryable: true}
	}
	return nil
}

// safeConfirm xác nhận bằng token. Sai token → precondition_failed; đã quá hạn → hoàn tác và báo rolled_back.
func (d *Deps) safeConfirm(ctx context.Context, k safeKind, applyID, token string) (confirmed, rolledBack bool, err error) {
	safeMu.Lock()
	defer safeMu.Unlock()
	if err := d.safeExpire(ctx, k); err != nil {
		return false, false, err
	}
	p, err := d.safePending(k)
	if err != nil {
		return false, false, err
	}
	if p == nil || p.ApplyID != applyID {
		st, err := d.safeState(k)
		if err != nil {
			return false, false, err
		}
		if st.ApplyID == applyID && st.State == "confirmed" {
			return true, false, nil // xác nhận lặp lại (idempotent)
		}
		if st.ApplyID == applyID && st.State == "rolled_back" {
			return false, true, nil
		}
		return false, false, &registry.OpError{Code: "not_found", Message: k.name + ": không có lần áp dụng " + applyID + " đang chờ"}
	}
	sum := sha256.Sum256([]byte(token))
	want, _ := hex.DecodeString(p.TokenSHA256)
	if subtle.ConstantTimeCompare(sum[:], want) != 1 {
		return false, false, &registry.OpError{Code: "precondition_failed", Message: k.name + ": token xác nhận không đúng"}
	}
	if _, err := d.must(ctx, "dependency_unavailable", "systemctl", "stop", k.unit+".timer"); err != nil {
		return false, false, err
	}
	st, err := d.safeState(k)
	if err != nil {
		return false, false, err
	}
	st.State, st.ApplyID, st.At = "confirmed", applyID, d.now().UTC().Format(time.RFC3339)
	if err := d.safeWriteJSON(k.statePath(), st); err != nil {
		return false, false, err
	}
	if _, err := d.FS.Remove(k.pendingPath()); err != nil {
		return false, false, opErr(err)
	}
	_, _ = d.FS.Remove(k.prevPath(applyID))
	return true, false, nil
}

func (d *Deps) safeKindByName(name string) (safeKind, bool) {
	switch name {
	case "firewall":
		return firewallKind, true
	case "sshd":
		return sshdKind, true
	}
	return safeKind{}, false
}

// SafeRollback là điểm vào của `itso-agent safe-rollback <kind> <apply_id>` (timer systemd gọi).
func SafeRollback(ctx context.Context, d *Deps, kind, applyID string) error {
	k, ok := d.safeKindByName(kind)
	if !ok {
		return fmt.Errorf("safe-rollback: loại không hợp lệ %q", kind)
	}
	if !reUUID.MatchString(applyID) {
		return fmt.Errorf("safe-rollback: apply_id không hợp lệ")
	}
	safeMu.Lock()
	defer safeMu.Unlock()
	return d.safeRollbackLocked(ctx, k, applyID)
}

// RecoverSafeApply chạy lúc agent khởi động: lần chờ đã quá hạn (timer không chạy được) → hoàn tác.
func RecoverSafeApply(ctx context.Context, d *Deps) error {
	safeMu.Lock()
	defer safeMu.Unlock()
	var errs []error
	for _, k := range []safeKind{firewallKind, sshdKind} {
		errs = append(errs, d.safeExpire(ctx, k))
	}
	return errors.Join(errs...)
}
