package install

// Journal cập nhật (D-114, ADR 0059): `itso update` ghi bước đã xong vào /var/lib/itso/update.journal (ghi tạm rồi
// rename, fsync) để sau kill -9 hoặc mất điện `itso repair --fix` biết phải dọn hay hoàn tất. Lịch sử mọi lượt
// update/rollback/repair nối vào /var/lib/itso/update-history.jsonl (panel đọc qua /system/updates). Không chứa secret.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"time"

	"itso.local/agent/internal/platform"
)

const (
	JournalFile = VarDir + "/update.journal"
	HistoryFile = VarDir + "/update-history.jsonl"
	historyKeep = 200
)

// Các bước journal theo thứ tự.
const (
	StepDownloaded = "downloaded"
	StepVerified   = "verified"
	StepExtracted  = "extracted"
	StepMigrated   = "migrated"
	StepSwitched   = "switched"
	StepRestarted  = "restarted"
)

// JournalSteps là thứ tự bước của một lượt update.
var JournalSteps = []string{StepDownloaded, StepVerified, StepExtracted, StepMigrated, StepSwitched, StepRestarted}

// Journal là trạng thái lượt update đang dở.
type Journal struct {
	VersionFrom string    `json:"version_from"`
	VersionTo   string    `json:"version_to"`
	Step        string    `json:"step"`
	StartedAt   time.Time `json:"started_at"`
	BreakingDB  bool      `json:"breaking_db,omitempty"`
}

// HistoryEntry là một dòng update-history.jsonl (khớp SystemUpdates.history trong OpenAPI).
type HistoryEntry struct {
	Action      string     `json:"action"` // update | rollback | repair
	VersionFrom string     `json:"version_from"`
	VersionTo   string     `json:"version_to"`
	Result      string     `json:"result"` // succeeded | rolled_back | failed | interrupted
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at"`
	DurationSec *int64     `json:"duration_sec"`
	By          string     `json:"by"`
	Note        *string    `json:"note"`
}

// ReadJournal trả journal dở (nil nếu không có).
func (e *Env) ReadJournal() (*Journal, error) {
	var j Journal
	ok, err := e.readJSON(JournalFile, &j)
	if err != nil {
		return nil, fmt.Errorf("journal cập nhật hỏng: %w", err)
	}
	if !ok {
		return nil, nil
	}
	if !slices.Contains(JournalSteps, j.Step) || !reVersion.MatchString(j.VersionTo) || !reVersion.MatchString(j.VersionFrom) {
		return nil, fmt.Errorf("journal cập nhật không hợp lệ (bước %q)", j.Step)
	}
	return &j, nil
}

// journalStep ghi bước vừa xong rồi gọi AfterStep (test giả lập crash ngay sau bước).
func (e *Env) journalStep(j *Journal, step string) error {
	j.Step = step
	if err := e.writeJSON(JournalFile, j, 0o644, platform.Owner{}); err != nil {
		return fmt.Errorf("ghi journal: %w", err)
	}
	if e.AfterStep != nil {
		return e.AfterStep(step)
	}
	return nil
}

func (e *Env) clearJournal() error {
	_, err := e.FS.Remove(JournalFile)
	return err
}

// appendHistory nối một dòng lịch sử, giữ historyKeep dòng mới nhất.
func (e *Env) appendHistory(h HistoryEntry) error {
	if h.FinishedAt == nil {
		t := e.now().UTC()
		h.FinishedAt = &t
	}
	if h.DurationSec == nil {
		d := int64(h.FinishedAt.Sub(h.StartedAt).Seconds())
		if d < 0 {
			d = 0
		}
		h.DurationSec = &d
	}
	line, err := json.Marshal(h)
	if err != nil {
		return err
	}
	old, err := e.FS.ReadFile(HistoryFile)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	lines := bytes.Split(bytes.TrimRight(old, "\n"), []byte("\n"))
	if len(old) == 0 {
		lines = nil
	}
	lines = append(lines, line)
	if len(lines) > historyKeep {
		lines = lines[len(lines)-historyKeep:]
	}
	if err := e.FS.MkdirAll(VarDir); err != nil {
		return err
	}
	_, err = e.FS.WriteAtomic(HistoryFile, append(bytes.Join(lines, []byte("\n")), '\n'), 0o644, platform.Owner{})
	return err
}

// History đọc lịch sử, mới nhất trước. Dòng hỏng bị bỏ qua.
func (e *Env) History() []HistoryEntry {
	b, err := e.FS.ReadFile(HistoryFile)
	if err != nil {
		return nil
	}
	var out []HistoryEntry
	for _, l := range bytes.Split(b, []byte("\n")) {
		var h HistoryEntry
		if len(bytes.TrimSpace(l)) == 0 || json.Unmarshal(l, &h) != nil {
			continue
		}
		out = append(out, h)
	}
	slices.Reverse(out)
	return out
}

func strp(s string) *string { return &s }

// journalCheck mô tả journal cho doctor/repair (không sửa).
func (e *Env) journalCheck() (Check, *Journal) {
	j, err := e.ReadJournal()
	switch {
	case err != nil:
		return Check{Name: "update_journal", Status: Fail, Detail: err.Error() + " (xem " + JournalFile + ")"}, nil
	case j == nil:
		return Check{Name: "update_journal", Status: Pass, Detail: "không có lượt cập nhật dở"}, nil
	}
	return Check{Name: "update_journal", Status: Fail, Detail: fmt.Sprintf(
		"cập nhật %s → %s dừng sau bước %s (%s): chạy itso repair --fix", j.VersionFrom, j.VersionTo, j.Step,
		j.StartedAt.UTC().Format(time.RFC3339))}, j
}

// resumeUpdate xử lý journal dở theo ADR 0059 §2. Trả check kết quả.
//   - trước migrated: bản cũ vẫn chạy, DB chưa đổi → dọn bản giải nén dở, bật lại site (artisan up).
//   - migrated/switched/restarted: migration chỉ mở rộng nên hoàn tất (trỏ bản mới, cài unit, restart, kiểm
//     sức khỏe); sức khỏe lỗi → quay về bản cũ.
func (e *Env) resumeUpdate(ctx context.Context, j *Journal) (Check, error) {
	idx := slices.Index(JournalSteps, j.Step)
	hist := HistoryEntry{Action: "repair", VersionFrom: j.VersionFrom, VersionTo: j.VersionTo, StartedAt: e.now().UTC(), By: "itso repair"}
	if idx < slices.Index(JournalSteps, StepMigrated) {
		if e.CurrentVersion() != j.VersionFrom {
			if err := e.activate(j.VersionFrom); err != nil {
				return Check{}, err
			}
		}
		_ = e.FS.RemoveTree(ReleasesDir + "/.tmp-" + j.VersionTo)
		if e.FS.Exists(ReleasesDir+"/"+j.VersionTo) && !e.FS.Exists(ReleasesDir+"/"+j.VersionTo+"/.complete") {
			_ = e.FS.RemoveTree(ReleasesDir + "/" + j.VersionTo)
		}
		if _, err := e.artisan(ctx, "up"); err != nil {
			e.printf("  cảnh báo: artisan up lỗi: %v\n", err)
		}
		hist.Result, hist.Note = "rolled_back", strp("ngắt sau bước "+j.Step+": giữ bản "+j.VersionFrom+", DB chưa đổi")
		if err := e.finishRepair(hist); err != nil {
			return Check{}, err
		}
		return Check{Name: "update_journal", Status: Pass, Detail: fmt.Sprintf("ngắt sau %s: đã dọn bản %s dở, giữ %s", j.Step, j.VersionTo, j.VersionFrom)}, nil
	}
	if j.BreakingDB {
		return Check{Name: "update_journal", Status: Fail, Detail: fmt.Sprintf(
			"bản %s có breaking_db: không tự hoàn tất; khôi phục %s/pre-update/%s.dump rồi itso rollback", j.VersionTo, BackupDir, j.VersionFrom)}, nil
	}
	finish := func() error {
		if err := e.activate(j.VersionTo); err != nil {
			return err
		}
		if err := e.linkEnv(); err != nil {
			return err
		}
		if err := e.installUnits(ctx); err != nil {
			return err
		}
		if _, err := e.cmd(ctx, "systemctl", "restart", "itso.target"); err != nil {
			return err
		}
		return e.healthy(ctx)
	}
	if err := finish(); err != nil {
		e.printf("  hoàn tất %s lỗi: %v → quay về %s\n", j.VersionTo, err, j.VersionFrom)
		if aerr := e.activate(j.VersionFrom); aerr != nil {
			return Check{}, fmt.Errorf("%v; quay về lỗi: %w", err, aerr)
		}
		_ = e.installUnits(ctx)
		_, _ = e.cmd(ctx, "systemctl", "restart", "itso.target")
		_, _ = e.artisan(ctx, "up")
		hist.Result, hist.Note = "rolled_back", strp("hoàn tất lỗi ("+err.Error()+"), đã quay về "+j.VersionFrom)
		if herr := e.finishRepair(hist); herr != nil {
			return Check{}, herr
		}
		return Check{Name: "update_journal", Status: Warn, Detail: fmt.Sprintf("không hoàn tất được %s, đã quay về %s: %v", j.VersionTo, j.VersionFrom, err)}, nil
	}
	if _, err := e.artisan(ctx, "up"); err != nil {
		e.printf("  cảnh báo: artisan up lỗi: %v\n", err)
	}
	var st State
	if _, err := e.readJSON(StateFile, &st); err != nil {
		return Check{}, err
	}
	st.Previous, st.Version = j.VersionFrom, j.VersionTo
	if err := e.saveState(&st); err != nil {
		return Check{}, err
	}
	hist.Result, hist.Note = "succeeded", strp("ngắt sau bước "+j.Step+": đã hoàn tất lên "+j.VersionTo)
	if err := e.finishRepair(hist); err != nil {
		return Check{}, err
	}
	return Check{Name: "update_journal", Status: Pass, Detail: fmt.Sprintf("ngắt sau %s: đã hoàn tất %s → %s", j.Step, j.VersionFrom, j.VersionTo)}, nil
}

func (e *Env) finishRepair(h HistoryEntry) error {
	if err := e.appendHistory(h); err != nil {
		return err
	}
	if err := e.clearJournal(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
