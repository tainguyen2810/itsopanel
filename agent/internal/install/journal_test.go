package install_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"itso.local/agent/internal/install"
	"itso.local/agent/internal/platform"
)

var errCrash = errors.New("kill -9")

// TestUpdateCrashAtEachStep giả lập tiến trình `itso update` chết ngay sau từng bước journal (ADR 0059), rồi chạy
// `itso repair --fix`: trước migrated phải giữ bản cũ; từ migrated trở đi phải hoàn tất lên bản mới.
func TestUpdateCrashAtEachStep(t *testing.T) {
	for i, step := range install.JournalSteps {
		t.Run(step, func(t *testing.T) {
			r := installed(t)
			ctx := context.Background()
			r.e.AfterStep = func(s string) error {
				if s == step {
					return errCrash
				}
				return nil
			}
			if err := r.e.Update(ctx, release(t, "1.1.0")); !errors.Is(err, errCrash) {
				t.Fatalf("mong đợi crash sau %s: %v", step, err)
			}
			r.e.AfterStep = nil
			j, err := r.e.ReadJournal()
			if err != nil || j == nil || j.Step != step || j.VersionFrom != "1.0.0" || j.VersionTo != "1.1.0" {
				t.Fatalf("journal sau crash: %+v %v", j, err)
			}
			// doctor/repair không --fix chỉ báo; update mới bị chặn.
			if c := find(r.e.Doctor(ctx), "update_journal"); c.Status != install.Fail || !strings.Contains(c.Detail, step) {
				t.Fatalf("doctor: %+v", c)
			}
			cs, err := r.e.Repair(ctx, false)
			if err != nil || find(cs, "update_journal").Status != install.Fail {
				t.Fatalf("repair không fix: %+v %v", cs, err)
			}
			if err := r.e.Update(ctx, release(t, "1.2.0")); err == nil || !strings.Contains(err.Error(), "itso repair --fix") {
				t.Fatalf("update khi journal dở phải bị chặn: %v", err)
			}
			cs, err = r.e.Repair(ctx, true)
			if err != nil {
				t.Fatal(err, r.out.String())
			}
			if c := find(cs, "update_journal"); c.Status != install.Pass {
				t.Fatalf("repair --fix: %+v", c)
			}
			if j, _ := r.e.ReadJournal(); j != nil {
				t.Fatal("journal phải bị xóa sau repair")
			}
			h := r.e.History()
			if len(h) == 0 || h[0].Action != "repair" {
				t.Fatalf("lịch sử: %+v", h)
			}
			beforeMigrated := i < 3
			if beforeMigrated {
				if r.e.CurrentVersion() != "1.0.0" || h[0].Result != "rolled_back" || r.state().Version != "1.0.0" {
					t.Fatalf("trước migrated phải giữ 1.0.0: %s %+v", r.e.CurrentVersion(), h[0])
				}
			} else {
				if r.e.CurrentVersion() != "1.1.0" || h[0].Result != "succeeded" || r.state().Previous != "1.0.0" {
					t.Fatalf("từ migrated phải hoàn tất 1.1.0: %s %+v", r.e.CurrentVersion(), h[0])
				}
			}
			// Sau repair, cập nhật tiếp hoạt động bình thường.
			if err := r.e.Update(ctx, release(t, "1.2.0")); err != nil {
				t.Fatal(err)
			}
			if r.e.CurrentVersion() != "1.2.0" || r.e.History()[0].Result != "succeeded" {
				t.Fatal(r.e.CurrentVersion(), r.e.History()[0])
			}
		})
	}
}

// TestRepairRollsBackWhenFinishUnhealthy: crash sau switched, khi repair thì sức khỏe hỏng → quay về bản cũ.
func TestRepairRollsBackWhenFinishUnhealthy(t *testing.T) {
	r := installed(t)
	ctx := context.Background()
	r.e.AfterStep = func(s string) error {
		if s == install.StepSwitched {
			return errCrash
		}
		return nil
	}
	if err := r.e.Update(ctx, release(t, "1.1.0")); !errors.Is(err, errCrash) {
		t.Fatal(err)
	}
	r.e.AfterStep = nil
	r.fail["systemctl is-active itso-web.service"] = platform.Result{ExitCode: 3, Stdout: []byte("failed\n")}
	cs, err := r.e.Repair(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if c := find(cs, "update_journal"); c.Status != install.Warn || !strings.Contains(c.Detail, "quay về 1.0.0") {
		t.Fatalf("%+v", c)
	}
	if r.e.CurrentVersion() != "1.0.0" || r.e.History()[0].Result != "rolled_back" {
		t.Fatal(r.e.CurrentVersion(), r.e.History())
	}
	if j, _ := r.e.ReadJournal(); j != nil {
		t.Fatal("journal phải bị xóa")
	}
}

// TestUpdateHistoryAndOrder: update thành công ghi lịch sử; migrate chạy từ bản mới trước khi đổi symlink.
func TestUpdateHistoryAndOrder(t *testing.T) {
	r := installed(t)
	ctx := context.Background()
	r.fake.Reset()
	if err := r.e.Update(ctx, release(t, "1.1.0")); err != nil {
		t.Fatal(err)
	}
	w := strings.Join(r.writes(), "\n")
	if !strings.Contains(w, "/opt/itso/releases/1.1.0/api/artisan migrate --force") {
		t.Fatalf("migrate phải chạy từ bản mới:\n%s", w)
	}
	if j, _ := r.e.ReadJournal(); j != nil {
		t.Fatal("journal phải bị xóa khi xong")
	}
	if err := r.e.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	h := r.e.History()
	if len(h) != 2 || h[0].Action != "rollback" || h[1].Action != "update" || h[1].Result != "succeeded" || h[1].DurationSec == nil {
		t.Fatalf("%+v", h)
	}
	// Journal hỏng → doctor FAIL, update từ chối.
	if err := r.fs.MkdirAll(install.VarDir); err != nil {
		t.Fatal(err)
	}
	if _, err := r.fs.WriteAtomic(install.JournalFile, []byte(`{"step":"rm -rf"}`), 0o644, platform.Owner{}); err != nil {
		t.Fatal(err)
	}
	if c := find(r.e.Doctor(ctx), "update_journal"); c.Status != install.Fail {
		t.Fatalf("%+v", c)
	}
	if err := r.e.Update(ctx, release(t, "1.2.0")); err == nil {
		t.Fatal("journal hỏng phải chặn update")
	}
}

func find(cs []install.Check, name string) install.Check {
	for _, c := range cs {
		if c.Name == name {
			return c
		}
	}
	return install.Check{}
}
