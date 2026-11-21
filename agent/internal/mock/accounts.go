package mock

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sync"

	"itso.local/agent/internal/contracts"
	"itso.local/agent/internal/envelope"
	"itso.local/agent/internal/registry"
)

// Op hosting account giả (Prompt 3.4): giữ trạng thái trong bộ nhớ, không đụng tới máy thật.
// Params đã qua kiểm schema ở envelope.Parse; kết quả dùng struct sinh từ contracts.

type mockAccount struct {
	UID       contracts.UID
	Home      string
	Shell     string
	Limits    contracts.Limits
	Suspended bool
}

type accountStore struct {
	mu       sync.Mutex
	accounts map[contracts.Username]*mockAccount
}

func decode[T any](env *envelope.Envelope) (T, error) {
	var p T
	if err := json.Unmarshal(env.Params, &p); err != nil {
		return p, &registry.OpError{Code: "invalid_params", Message: err.Error()}
	}
	return p, nil
}

func registerAccounts(r *registry.Registry) error {
	st := &accountStore{accounts: map[contracts.Username]*mockAccount{}}
	handlers := map[string]registry.Handler{
		contracts.OpAccountEnsure:    st.ensure,
		contracts.OpAccountSuspend:   st.suspend,
		contracts.OpAccountUnsuspend: st.unsuspend,
		contracts.OpAccountRemove:    st.remove,
		contracts.OpQuotaApply:       st.quotaApply,
		contracts.OpQuotaReport:      st.quotaReport,
	}
	for op, h := range handlers {
		if err := r.Register(op, h); err != nil {
			return err
		}
	}
	if err := registerData(r, st); err != nil {
		return err
	}
	return registerWeb(r, st)
}

// get trả account khớp cả username lẫn uid (uid lệch → precondition_failed, không có → not_found).
func (s *accountStore) get(a contracts.Account) (*mockAccount, error) {
	acc, ok := s.accounts[a.Username]
	if !ok {
		return nil, &registry.OpError{Code: "not_found", Message: "không có account " + string(a.Username)}
	}
	if acc.UID != a.UID {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "uid không khớp account " + string(a.Username)}
	}
	return acc, nil
}

func (s *accountStore) ensure(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.AccountEnsureParams](env)
	if err != nil {
		return nil, err
	}
	if p.HomePath != "/home/"+string(p.Account.Username) {
		return nil, &registry.OpError{Code: "path_outside_home", Message: "home_path phải là /home/<username>"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, acc := range s.accounts {
		if acc.UID == p.Account.UID && name != p.Account.Username {
			return nil, &registry.OpError{Code: "already_exists", Message: "uid đã thuộc account khác"}
		}
	}
	if acc, ok := s.accounts[p.Account.Username]; ok {
		if acc.UID != p.Account.UID {
			return nil, &registry.OpError{Code: "already_exists", Message: "username đã có với uid khác"}
		}
		acc.Shell, acc.Limits = p.Shell, p.Limits
		return toData(contracts.AccountEnsureResult{Created: false, UID: acc.UID})
	}
	s.accounts[p.Account.Username] = &mockAccount{UID: p.Account.UID, Home: p.HomePath, Shell: p.Shell, Limits: p.Limits}
	return toData(contracts.AccountEnsureResult{Created: true, UID: p.Account.UID})
}

func (s *accountStore) suspend(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.AccountSuspendParams](env)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, err := s.get(p.Account)
	if err != nil {
		return nil, err
	}
	acc.Suspended = true
	return toData(contracts.AccountSuspendResult{Suspended: true})
}

func (s *accountStore) unsuspend(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.AccountUnsuspendParams](env)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, err := s.get(p.Account)
	if err != nil {
		return nil, err
	}
	acc.Suspended = false
	return toData(contracts.AccountUnsuspendResult{Suspended: false})
}

func (s *accountStore) remove(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.AccountRemoveParams](env)
	if err != nil {
		return nil, err
	}
	if p.ConfirmUsername != p.Account.Username {
		return nil, &registry.OpError{Code: "precondition_failed", Message: "confirm_username không khớp"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, err := s.get(p.Account)
	if err != nil {
		return nil, err
	}
	delete(s.accounts, p.Account.Username)
	return toData(contracts.AccountRemoveResult{RemovedObjects: []contracts.AccountRemoveResultRemovedObjectsItem{
		{Kind: "linux_user", Name: string(p.Account.Username)},
		{Kind: "home", Name: acc.Home},
		{Kind: "systemd_slice", Name: fmt.Sprintf("itso-acct-%d.slice", p.Account.UID)},
	}})
}

func (s *accountStore) quotaApply(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.QuotaApplyParams](env)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, err := s.get(p.Account)
	if err != nil {
		return nil, err
	}
	acc.Limits = p.Limits
	return toData(contracts.QuotaApplyResult{Applied: true})
}

// quotaReport trả mức dùng giả, ổn định theo username (≤ 60% hạn mức đĩa); account lạ bị bỏ qua.
func (s *accountStore) quotaReport(_ context.Context, env *envelope.Envelope) (map[string]any, error) {
	p, err := decode[contracts.QuotaReportParams](env)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	usage := make([]contracts.QuotaReportResultUsageItem, 0, len(p.Accounts))
	for _, a := range p.Accounts {
		acc, err := s.get(a)
		if err != nil {
			continue
		}
		h := fnv.New32a()
		_, _ = h.Write([]byte(a.Username))
		seed := int64(h.Sum32() % 1000)
		usage = append(usage, contracts.QuotaReportResultUsageItem{
			Username: a.Username,
			DiskMB:   acc.Limits.DiskMB * (seed%60 + 1) / 100,
			Inodes:   acc.Limits.InodeLimit * (seed%40 + 1) / 100,
			CPUPct:   float64(seed%250) / 10,
			RAMMB:    acc.Limits.RAMMB * (seed%50 + 1) / 100,
		})
	}
	return toData(contracts.QuotaReportResult{Usage: usage})
}
