package report

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCoordinatorFixedFallbackAndSettlementBatch(t *testing.T) {
	now := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{{ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat}}
	store.add(reportAt("one", "worker", now, now.Add(time.Hour), "first"))
	store.add(reportAt("two", "worker", now.Add(20*time.Minute), now.Add(80*time.Minute), "second"))
	delivery := &coordinatorDelivery{}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }, NewToken: func() string { return "claim" }})

	if delay, err := c.RunDue(context.Background()); err != nil || delay != time.Hour {
		t.Fatalf("before fallback delay = %v, err = %v", delay, err)
	}
	now = now.Add(time.Hour)
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(delivery.submissions) != 1 || !strings.Contains(delivery.submissions[0].message, "first") || !strings.Contains(delivery.submissions[0].message, "second") {
		t.Fatalf("submission = %#v, want one shared batch", delivery.submissions)
	}
	if store.acked != 2 {
		t.Fatalf("acknowledged = %d, want 2", store.acked)
	}

	store.add(reportAt("done-1", "worker", now, now.Add(5*time.Minute), "done"))
	store.add(reportAt("done-2", "worker", now.Add(2*time.Minute), now.Add(7*time.Minute), "later done"))
	now = now.Add(5 * time.Minute)
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(delivery.submissions) != 2 || !strings.Contains(delivery.submissions[1].message, "later done") {
		t.Fatalf("settlement submission = %#v", delivery.submissions)
	}
}

func TestCoordinatorRoutesAtAttemptAndLeavesPendingWithoutOrchestrator(t *testing.T) {
	now := time.Date(2026, 9, 14, 11, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.add(reportAt("need", "worker", now, now, "decision"))
	delivery := &coordinatorDelivery{}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }, RetryDelay: time.Second})
	if delay, err := c.RunDue(context.Background()); err != nil || delay != UndeliverableRecheck {
		t.Fatalf("no orchestrator delay = %v, err = %v", delay, err)
	}
	if _, ok := c.UndeliverableProjects()["p"]; !ok {
		t.Fatal("project p should be reported undeliverable")
	}
	if store.reports[0].DeliveryState != domain.ReportPending {
		t.Fatalf("state = %s, want pending", store.reports[0].DeliveryState)
	}
	store.sessions = []domain.SessionRecord{
		{ID: "old", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat, IsTerminated: true, CreatedAt: now},
		{ID: "replacement", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat, CreatedAt: now.Add(time.Second)},
	}
	c.Wake()
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(c.UndeliverableProjects()) != 0 {
		t.Fatal("project should no longer be undeliverable")
	}
	if len(delivery.submissions) != 1 || delivery.submissions[0].target != "replacement" {
		t.Fatalf("submissions = %#v", delivery.submissions)
	}
}

func TestCoordinatorStuckInterruptRateLimitAndCoalescing(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{{ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat}}
	first := reportAt("stuck-1", "worker", now, now, "cannot continue")
	first.State = domain.ReportStuck
	second := reportAt("stuck-2", "worker", now.Add(time.Second), now, "cannot continue")
	second.State = domain.ReportStuck
	store.add(first, second)
	delivery := &coordinatorDelivery{}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }})
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(delivery.interrupts) != 1 {
		t.Fatalf("interrupts = %v", delivery.interrupts)
	}
	if !strings.Contains(delivery.submissions[0].message, "repeated 2 times") {
		t.Fatalf("message = %q", delivery.submissions[0].message)
	}
	repeat := reportAt("stuck-3", "worker", now.Add(time.Minute), now, "cannot continue")
	repeat.State = domain.ReportStuck
	store.add(repeat)
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(delivery.interrupts) != 1 {
		t.Fatalf("rate limited interrupts = %v", delivery.interrupts)
	}
	if len(delivery.submissions) != 1 {
		t.Fatalf("throttled repeat created an extra wakeup: %#v", delivery.submissions)
	}
}

func TestCoordinatorBusyOrchestratorDoesNotHoldUpOtherProjects(t *testing.T) {
	// Project p's orchestrator composer holds the operator's unsent draft, so its
	// earliest-due batch is refused. It must back off instead of staying first in
	// line and starving project q's reports on every retry.
	now := time.Date(2026, 9, 14, 13, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{
		{ID: "orch-p", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeTUI},
		{ID: "orch-q", ProjectID: "q", Kind: domain.KindOrchestrator, Mode: domain.SessionModeTUI},
	}
	other := reportAt("q-1", "worker-q", now.Add(time.Second), now, "q finished")
	other.ProjectID = "q"
	store.add(reportAt("p-1", "worker-p", now, now, "p finished"), other)
	delivery := &coordinatorDelivery{submitErrFor: map[domain.SessionID]error{
		"orch-p": fmt.Errorf("send orch-p: %w", ErrOrchestratorBusy),
	}}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }, NewToken: func() string { return "claim" }})

	delay, err := c.RunDue(context.Background())
	if err != nil {
		t.Fatalf("RunDue: %v", err)
	}
	if len(delivery.submissions) != 1 || delivery.submissions[0].target != "orch-q" {
		t.Fatalf("submissions = %#v, want q's report delivered past p's busy orchestrator", delivery.submissions)
	}
	if delay != OrchestratorBusyRetry {
		t.Fatalf("next run in %v, want p's backoff %v", delay, OrchestratorBusyRetry)
	}
	for _, rec := range store.reports {
		if rec.ID == "p-1" && (rec.DeliveryState != domain.ReportPending || !rec.AvailableAt.Equal(now.Add(OrchestratorBusyRetry))) {
			t.Fatalf("p's report = %s available %s, want pending at %s", rec.DeliveryState, rec.AvailableAt, now.Add(OrchestratorBusyRetry))
		}
	}

	now = now.Add(OrchestratorBusyRetry)
	delete(delivery.submitErrFor, "orch-p")
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatalf("RunDue after backoff: %v", err)
	}
	if len(delivery.submissions) != 2 || delivery.submissions[1].target != "orch-p" {
		t.Fatalf("submissions = %#v, want p's report delivered once its composer cleared", delivery.submissions)
	}
}

func TestReportSessionLinkUsesDisplayName(t *testing.T) {
	got := reportSessionLink(domain.ReportRecord{
		SessionID: "worker/1", ProjectID: "proj 1", SessionDisplayName: "Backend [worker]",
	})
	want := `[Backend \[worker\]](ao://sessions/proj%201/worker%2F1)`
	if got != want {
		t.Fatalf("link = %q, want %q", got, want)
	}
}

func TestCoordinatorAcceptanceAndPiggybackFencing(t *testing.T) {
	now := time.Date(2026, 9, 14, 13, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{{ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat}}
	store.add(reportAt("info", "worker", now, now.Add(time.Hour), "context"))
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: &coordinatorDelivery{}, Now: func() time.Time { return now }, NewToken: func() string { return "piggyback-token" }})
	batch, err := c.PreparePiggyback(context.Background(), "orch")
	if err != nil || len(batch.Reports) != 1 {
		t.Fatalf("prepare = %#v, err = %v", batch, err)
	}
	combined := batch.AppendToUserMessage("hello")
	if !strings.HasPrefix(combined, "hello\n\n<ao-worker-reports>\n") ||
		!strings.HasSuffix(combined, "\n</ao-worker-reports>") {
		t.Fatalf("piggyback text = %q", combined)
	}
	if !strings.Contains(combined, "[checkpoint] [worker](ao://sessions/p/worker)") {
		t.Fatalf("piggyback link = %q", combined)
	}
	if store.acked != 0 {
		t.Fatal("claimed report acknowledged before acceptance")
	}
	if err := c.AcceptPiggyback(context.Background(), batch); err != nil {
		t.Fatal(err)
	}
	if store.acked != 1 {
		t.Fatalf("acknowledged = %d", store.acked)
	}
	if count, _ := store.AcknowledgeReportBatch(context.Background(), "p", "stale-token", now); count != 0 {
		t.Fatalf("stale token acknowledged %d reports", count)
	}
}

type coordinatorStore struct {
	mu           sync.Mutex
	now          time.Time
	reports      []domain.ReportRecord
	sessions     []domain.SessionRecord
	interrupts   map[domain.SessionID]time.Time
	acked        int
	sessionLists map[domain.ProjectID]int
}

func newCoordinatorStore(now time.Time) *coordinatorStore {
	return &coordinatorStore{now: now, interrupts: map[domain.SessionID]time.Time{}, sessionLists: map[domain.ProjectID]int{}}
}

func reportAt(id string, worker domain.SessionID, created, available time.Time, note string) domain.ReportRecord {
	return domain.ReportRecord{ID: id, SessionID: worker, ProjectID: "p", State: domain.ReportCheckpoint, Note: note, CreatedAt: created, AvailableAt: available, DeliveryState: domain.ReportPending, RepeatCount: 1}
}

func (s *coordinatorStore) add(records ...domain.ReportRecord) {
	s.reports = append(s.reports, records...)
}
func (s *coordinatorStore) ListSessions(_ context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	s.sessionLists[project]++
	var recs []domain.SessionRecord
	for _, rec := range s.sessions {
		if rec.ProjectID == project {
			recs = append(recs, rec)
		}
	}
	return recs, nil
}
func (s *coordinatorStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	for _, rec := range s.sessions {
		if rec.ID == id {
			return rec, true, nil
		}
	}
	return domain.SessionRecord{}, false, nil
}
func (s *coordinatorStore) ListPendingReportSchedule(context.Context, int64) ([]domain.ReportRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var all []domain.ReportRecord
	for _, rec := range s.reports {
		if rec.DeliveryState == domain.ReportPending {
			all = append(all, rec)
		}
	}
	sortReports(all)
	seen := map[domain.ProjectID]bool{}
	var pending []domain.ReportRecord
	for _, rec := range all {
		if !seen[rec.ProjectID] {
			seen[rec.ProjectID] = true
			pending = append(pending, rec)
		}
	}
	return pending, nil
}
func (s *coordinatorStore) ClaimPendingReportBatch(_ context.Context, project domain.ProjectID, token string, at time.Time) ([]domain.ReportRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	batchID := ""
	for i := range s.reports {
		if s.reports[i].ProjectID == project && s.reports[i].DeliveryState == domain.ReportPending {
			batchID = s.reports[i].DeliveryBatchID
			if batchID == "" {
				batchID = "report-batch:" + s.reports[i].ID
			}
			break
		}
	}
	var claimed []domain.ReportRecord
	for i := range s.reports {
		if s.reports[i].ProjectID == project && s.reports[i].DeliveryState == domain.ReportPending {
			if s.reports[i].DeliveryBatchID != "" && s.reports[i].DeliveryBatchID != batchID {
				continue
			}
			s.reports[i].DeliveryBatchID = batchID
			s.reports[i].DeliveryAttempts++
			s.reports[i].DeliveryState, s.reports[i].ClaimToken, s.reports[i].ClaimedAt = domain.ReportClaimed, token, at
			claimed = append(claimed, s.reports[i])
		}
	}
	sortReports(claimed)
	return claimed, nil
}
func (s *coordinatorStore) AcknowledgeReportBatch(_ context.Context, project domain.ProjectID, token string, at time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for i := range s.reports {
		if s.reports[i].ProjectID == project && s.reports[i].DeliveryState == domain.ReportClaimed && s.reports[i].ClaimToken == token {
			s.reports[i].DeliveryState, s.reports[i].AcknowledgedAt = domain.ReportAcknowledged, at
			count++
		}
	}
	s.acked += count
	return count, nil
}
func (s *coordinatorStore) ReleaseReportBatch(_ context.Context, project domain.ProjectID, token string, _ time.Time, _ string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for i := range s.reports {
		if s.reports[i].ProjectID == project && s.reports[i].DeliveryState == domain.ReportClaimed && s.reports[i].ClaimToken == token {
			s.reports[i].DeliveryState, s.reports[i].ClaimToken = domain.ReportPending, ""
			count++
		}
	}
	return count, nil
}
func (s *coordinatorStore) DeferReportBatch(ctx context.Context, project domain.ProjectID, token string, at time.Time, reason string) (int, error) {
	count, err := s.ReleaseReportBatch(ctx, project, token, at, reason)
	if err != nil {
		return count, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.reports {
		if s.reports[i].ProjectID == project && s.reports[i].DeliveryState == domain.ReportPending && s.reports[i].DeliveryBatchID != "" && s.reports[i].AvailableAt.Before(at) {
			s.reports[i].AvailableAt = at
		}
	}
	return count, nil
}
func (s *coordinatorStore) AcquireReportInterrupt(_ context.Context, worker domain.SessionID, at time.Time, window time.Duration) (bool, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	last, ok := s.interrupts[worker]
	if ok && last.After(at.Add(-window)) {
		return false, last.Add(window), nil
	}
	s.interrupts[worker] = at
	return true, at, nil
}

func sortReports(records []domain.ReportRecord) {
	for i := 1; i < len(records); i++ {
		for j := i; j > 0 && (records[j].AvailableAt.Before(records[j-1].AvailableAt) || (records[j].AvailableAt.Equal(records[j-1].AvailableAt) && records[j].ID < records[j-1].ID)); j-- {
			records[j], records[j-1] = records[j-1], records[j]
		}
	}
}

type coordinatorSubmission struct {
	target       domain.SessionID
	message, key string
}
type coordinatorDelivery struct {
	submissions  []coordinatorSubmission
	interrupts   []domain.SessionID
	submitErr    error
	submitErrFor map[domain.SessionID]error
}

func (d *coordinatorDelivery) Submit(_ context.Context, target domain.SessionID, message, key string) error {
	if d.submitErr != nil {
		return d.submitErr
	}
	if err := d.submitErrFor[target]; err != nil {
		return err
	}
	d.submissions = append(d.submissions, coordinatorSubmission{target, message, key})
	return nil
}
func (d *coordinatorDelivery) Interrupt(_ context.Context, target domain.SessionID) error {
	d.interrupts = append(d.interrupts, target)
	return nil
}

func TestCoordinatorOrphanProjectDoesNotBlockOthers(t *testing.T) {
	now := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{{ID: "orch-b", ProjectID: "b", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat}}
	orphan := reportAt("orphan", "worker-a", now.Add(-time.Hour), now.Add(-time.Hour), "old done")
	orphan.ProjectID = "a"
	need := reportAt("need", "worker-b", now, now, "decision")
	need.ProjectID, need.State = "b", domain.ReportNeedsInput
	store.add(orphan, need)
	delivery := &coordinatorDelivery{}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }})

	delay, err := c.RunDue(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(delivery.submissions) != 1 || delivery.submissions[0].target != "orch-b" {
		t.Fatalf("submissions = %#v, want project b delivered", delivery.submissions)
	}
	if delay != UndeliverableRecheck {
		t.Fatalf("delay = %v, want park recheck %v (no hot retry)", delay, UndeliverableRecheck)
	}
	if _, ok := c.UndeliverableProjects()["a"]; !ok {
		t.Fatal("project a should be parked")
	}
	// Parked project is not retried until its recheck or a Wake.
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.sessionLists["a"] != 1 {
		t.Fatalf("orphan project re-examined %d times, want 1", store.sessionLists["a"])
	}
	// An orchestrator for the orphan project starts: report delivers.
	store.sessions = append(store.sessions, domain.SessionRecord{ID: "orch-a", ProjectID: "a", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat})
	c.Wake()
	if _, err := c.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(delivery.submissions) != 2 || delivery.submissions[1].target != "orch-a" {
		t.Fatalf("submissions = %#v, want orphan delivered after orchestrator starts", delivery.submissions)
	}
}

func TestCoordinatorTransientFailureBacksOffWithoutBlockingOthers(t *testing.T) {
	now := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{
		{ID: "orch-a", ProjectID: "a", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat},
		{ID: "orch-b", ProjectID: "b", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat},
	}
	bad := reportAt("bad", "worker-a", now.Add(-time.Hour), now.Add(-time.Hour), "first")
	bad.ProjectID = "a"
	good := reportAt("good", "worker-b", now, now, "second")
	good.ProjectID = "b"
	store.add(bad, good)
	delivery := &coordinatorDelivery{submitErrFor: map[domain.SessionID]error{"orch-a": fmt.Errorf("boom")}}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }, RetryDelay: time.Second})

	delay, err := c.RunDue(context.Background())
	if err == nil {
		t.Fatal("expected the transient failure to be reported")
	}
	if len(delivery.submissions) != 1 || delivery.submissions[0].target != "orch-b" {
		t.Fatalf("submissions = %#v, want project b delivered despite a failing", delivery.submissions)
	}
	if delay != time.Second {
		t.Fatalf("delay = %v, want 1s backoff", delay)
	}
	var due time.Time
	for _, r := range store.reports {
		if r.ID == "bad" {
			due = r.AvailableAt
		}
	}
	if !due.After(now) {
		t.Fatalf("failed batch available_at = %v, want after now (backoff)", due)
	}
}

func TestCoordinatorBackoffCountsFailuresNotBusyDeferrals(t *testing.T) {
	now := time.Date(2026, 10, 25, 11, 0, 0, 0, time.UTC)
	store := newCoordinatorStore(now)
	store.sessions = []domain.SessionRecord{{ID: "orch", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat}}
	rep := reportAt("need", "worker", now, now, "decision")
	rep.State = domain.ReportNeedsInput
	store.add(rep)
	delivery := &coordinatorDelivery{submitErr: ErrOrchestratorBusy}
	c := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, Now: func() time.Time { return now }, RetryDelay: time.Second})
	for i := 0; i < 12; i++ {
		now = now.Add(OrchestratorBusyRetry)
		if _, err := c.RunDue(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	delivery.submitErr = fmt.Errorf("hiccup")
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, 64 * time.Second, 128 * time.Second, 256 * time.Second, ExhaustedDeliveryRetry, ExhaustedDeliveryRetry}
	for i, w := range want {
		now = now.Add(2 * time.Hour)
		before := now
		if _, err := c.RunDue(context.Background()); err == nil {
			t.Fatalf("failure %d: expected error", i+1)
		}
		if got := store.reports[0].AvailableAt.Sub(before); got != w {
			t.Fatalf("failure %d delay = %v, want %v", i+1, got, w)
		}
	}
	if got := c.backoffDelay(8); got != 128*time.Second {
		t.Fatalf("delay(8) = %v", got)
	}
	big := NewCoordinator(CoordinatorDeps{Store: store, Delivery: delivery, RetryDelay: 5 * time.Second})
	if got := big.backoffDelay(9); got != MaxDeliveryBackoff {
		t.Fatalf("capped delay = %v, want %v", got, MaxDeliveryBackoff)
	}
}
