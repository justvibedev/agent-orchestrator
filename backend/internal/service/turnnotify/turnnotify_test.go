package turnnotify

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
)

type nopApplier struct{}

func (nopApplier) ApplyActivitySignal(context.Context, domain.SessionID, ports.ActivitySignal) error {
	return nil
}

type fakeSessions map[domain.SessionID]domain.SessionRecord

func (f fakeSessions) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	r, ok := f[id]
	return r, ok, nil
}

type fakeReports struct{ got []reportsvc.CreateInput }

func (f *fakeReports) Create(_ context.Context, in reportsvc.CreateInput) (domain.ReportRecord, error) {
	f.got = append(f.got, in)
	return domain.ReportRecord{SessionID: in.SessionID}, nil
}

type fakeTimer struct{ stopped bool }

func (t *fakeTimer) Stop() bool { t.stopped = true; return true }

type harness struct {
	o       *Observer
	reports *fakeReports
	pending []func()
	delay   time.Duration
}

func newHarness(kind domain.SessionKind) *harness {
	h := &harness{reports: &fakeReports{}}
	sessions := fakeSessions{"w1": {ID: "w1", ProjectID: "p", Kind: kind, Metadata: domain.SessionMetadata{Branch: "feat/x"}}}
	h.o = New(Deps{Next: nopApplier{}, Sessions: sessions, Reports: h.reports,
		AfterFunc: func(d time.Duration, f func()) stopper {
			h.delay = d
			t := &fakeTimer{}
			h.pending = append(h.pending, func() {
				if !t.stopped {
					f()
				}
			})
			return t
		}})
	return h
}

func (h *harness) signal(event, final string) {
	_ = h.o.ApplyActivitySignal(context.Background(), "w1", ports.ActivitySignal{Event: event, FinalAssistantMessage: final})
}

func (h *harness) fire() {
	for _, f := range h.pending {
		f()
	}
	h.pending = nil
}

func TestTurnEndedThenIdleNotifiesOnce(t *testing.T) {
	h := newHarness(domain.KindWorker)
	h.signal("user-prompt-submit", "")
	h.signal("stop", strings.Repeat("x", 2000))
	if len(h.reports.got) != 0 {
		t.Fatal("notified before idle delay")
	}
	if h.delay != DefaultIdleDelay {
		t.Fatalf("delay = %v", h.delay)
	}
	h.fire()
	h.signal("stop", "again") // same turn: deduped
	h.fire()
	if len(h.reports.got) != 1 {
		t.Fatalf("reports = %d, want 1", len(h.reports.got))
	}
	in := h.reports.got[0]
	if !in.Immediate || !strings.HasPrefix(in.Message, "[auto] turn_ended") || !strings.Contains(in.Message, "feat/x") {
		t.Fatalf("message = %q", in.Message)
	}
	if err := domain.ValidateReportContent("", "", in.Message, nil); err != nil {
		t.Fatalf("message invalid: %v", err)
	}
}

func TestNewPromptCancelsPendingNotification(t *testing.T) {
	h := newHarness(domain.KindWorker)
	h.signal("stop", "done?")
	h.signal("user-prompt-submit", "")
	h.fire()
	if len(h.reports.got) != 0 {
		t.Fatalf("reports = %d, want 0", len(h.reports.got))
	}
}

func TestReportFiledSuppressesNotification(t *testing.T) {
	h := newHarness(domain.KindWorker)
	h.signal("user-prompt-submit", "")
	h.signal("stop", "done")
	h.o.ReportFiled(domain.ReportRecord{SessionID: "w1"})
	h.fire()
	h.signal("session-end", "")
	if len(h.reports.got) != 0 {
		t.Fatalf("reports = %d, want 0", len(h.reports.got))
	}
}

func TestSessionEndNotifiesOnce(t *testing.T) {
	h := newHarness(domain.KindWorker)
	h.signal("user-prompt-submit", "")
	h.signal("session-end", "bye")
	h.signal("session-end", "bye")
	if len(h.reports.got) != 2 {
		// A second end with no live turn is a distinct episode; the first must be exactly one.
		t.Fatalf("reports = %d", len(h.reports.got))
	}
	if !strings.HasPrefix(h.reports.got[0].Message, "[auto] exited") || !strings.Contains(h.reports.got[0].Message, "bye") {
		t.Fatalf("message = %q", h.reports.got[0].Message)
	}
}

func TestExitAfterTurnEndedNotificationIsDeduped(t *testing.T) {
	h := newHarness(domain.KindWorker)
	h.signal("stop", "")
	h.fire()
	h.signal("session-end", "")
	if len(h.reports.got) != 1 {
		t.Fatalf("reports = %d, want 1", len(h.reports.got))
	}
}

func TestOrchestratorAndReviewerSessionsAreIgnored(t *testing.T) {
	for _, kind := range []domain.SessionKind{domain.KindOrchestrator} {
		h := newHarness(kind)
		h.signal("user-prompt-submit", "")
		h.signal("stop", "x")
		h.fire()
		h.signal("session-end", "")
		if len(h.reports.got) != 0 {
			t.Fatalf("%s: reports = %d, want 0", kind, len(h.reports.got))
		}
	}
}
