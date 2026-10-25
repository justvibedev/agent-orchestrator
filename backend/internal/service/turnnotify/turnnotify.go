// Package turnnotify synthesizes worker-to-orchestrator reports from agent
// hook facts the daemon already receives. A worker that ends its turn and then
// goes quiet without running `ao report`, or whose agent session ends, would
// otherwise never tell its orchestrator anything.
package turnnotify

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
)

const (
	// DefaultIdleDelay is how long a worker must stay idle after a turn ends,
	// without a new prompt or an ao report, before the orchestrator is told.
	DefaultIdleDelay = 60 * time.Second
	// MaxExcerptCharacters bounds the quoted last assistant message.
	MaxExcerptCharacters = 500

	// Kind labels lead the report message so the orchestrator can tell
	// synthesized notifications from worker-authored ones.
	KindTurnEnded = "turn_ended"
	KindExited    = "exited"
)

// Applier is the activity pipeline being observed.
type Applier interface {
	ApplyActivitySignal(ctx context.Context, id domain.SessionID, s ports.ActivitySignal) error
}

// Sessions resolves the worker's identity.
type Sessions interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
}

// Reports is the report service's create boundary.
type Reports interface {
	Create(context.Context, reportsvc.CreateInput) (domain.ReportRecord, error)
}

type stopper interface{ Stop() bool }

// Deps configures an Observer. Next, Sessions and Reports are required.
type Deps struct {
	Next      Applier
	Sessions  Sessions
	Reports   Reports
	IdleDelay time.Duration
	Log       *slog.Logger
	// AfterFunc schedules f after d; tests inject a fake clock.
	AfterFunc func(d time.Duration, f func()) stopper
}

type turn struct {
	gen      uint64
	reported bool
	notified bool
	timer    stopper
	last     string
}

// Observer wraps an Applier and turns Stop/SessionEnd facts into reports.
type Observer struct {
	Deps
	mu    sync.Mutex
	turns map[domain.SessionID]*turn
}

// New constructs an Observer.
func New(d Deps) *Observer {
	if d.IdleDelay <= 0 {
		d.IdleDelay = DefaultIdleDelay
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.AfterFunc == nil {
		d.AfterFunc = func(dur time.Duration, f func()) stopper { return time.AfterFunc(dur, f) }
	}
	return &Observer{Deps: d, turns: map[domain.SessionID]*turn{}}
}

// ApplyActivitySignal forwards to the wrapped pipeline and, if it accepted the
// signal, updates the per-turn notification state.
func (o *Observer) ApplyActivitySignal(ctx context.Context, id domain.SessionID, s ports.ActivitySignal) error {
	if err := o.Next.ApplyActivitySignal(ctx, id, s); err != nil {
		return err
	}
	if s.SubagentID != "" || nonInteractive(s.NativeEntrypoint) {
		return nil
	}
	switch {
	case s.Event == "session-end" || (s.Valid && s.State == domain.ActivityExited):
		o.sessionEnded(ctx, id, s.FinalAssistantMessage)
	case s.Event == "user-prompt-submit":
		o.turnStarted(ctx, id)
	case s.Event == "stop":
		if s.RunningSubagentIDs != nil && len(*s.RunningSubagentIDs) > 0 {
			return nil // a later Stop ends the turn for real
		}
		o.turnEnded(ctx, id, s.FinalAssistantMessage)
	}
	return nil
}

// ReportFiled records that the worker filed its own report, which suppresses
// the synthesized notification for the current turn.
func (o *Observer) ReportFiled(r domain.ReportRecord) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if t, ok := o.turns[r.SessionID]; ok {
		t.reported = true
		o.cancel(t)
	}
}

func nonInteractive(entrypoint string) bool {
	switch strings.TrimSpace(entrypoint) {
	case "sdk-cli", "sdk-ts", "sdk-py":
		return true
	}
	return false
}

// worker returns the session only when it is a worker; orchestrators and
// reviewers never produce synthesized reports.
func (o *Observer) worker(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool) {
	rec, ok, err := o.Sessions.GetSession(ctx, id)
	if err != nil || !ok || rec.Kind != domain.KindWorker {
		return domain.SessionRecord{}, false
	}
	return rec, true
}

// cancel must be called with o.mu held.
func (o *Observer) cancel(t *turn) {
	t.gen++
	if t.timer != nil {
		t.timer.Stop()
		t.timer = nil
	}
}

func (o *Observer) turnStarted(ctx context.Context, id domain.SessionID) {
	if _, ok := o.worker(ctx, id); !ok {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	t := o.turns[id]
	if t == nil {
		t = &turn{}
		o.turns[id] = t
	}
	o.cancel(t)
	t.reported, t.notified, t.last = false, false, ""
}

func (o *Observer) turnEnded(ctx context.Context, id domain.SessionID, last string) {
	if _, ok := o.worker(ctx, id); !ok {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	t := o.turns[id]
	if t == nil {
		t = &turn{}
		o.turns[id] = t
	}
	if t.reported || t.notified {
		return
	}
	o.cancel(t)
	t.last = strings.TrimSpace(last)
	gen := t.gen
	t.timer = o.AfterFunc(o.IdleDelay, func() { o.idleElapsed(id, gen) })
}

func (o *Observer) idleElapsed(id domain.SessionID, gen uint64) {
	o.mu.Lock()
	t := o.turns[id]
	if t == nil || t.gen != gen || t.reported || t.notified {
		o.mu.Unlock()
		return
	}
	t.notified, t.timer = true, nil
	last := t.last
	o.mu.Unlock()
	o.send(id, KindTurnEnded, last)
}

func (o *Observer) sessionEnded(ctx context.Context, id domain.SessionID, last string) {
	if _, ok := o.worker(ctx, id); !ok {
		return
	}
	o.mu.Lock()
	t := o.turns[id]
	skip := t != nil && (t.reported || t.notified)
	if t != nil {
		o.cancel(t)
		delete(o.turns, id)
	}
	if !skip && t != nil && last == "" {
		last = t.last
	}
	o.mu.Unlock()
	if !skip {
		o.send(id, KindExited, last)
	}
}

func (o *Observer) send(id domain.SessionID, kind, last string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rec, ok, err := o.Sessions.GetSession(ctx, id)
	if err != nil || !ok {
		return
	}
	_, err = o.Reports.Create(ctx, reportsvc.CreateInput{
		SessionID: id, Message: Message(kind, rec, last), Immediate: true,
	})
	if err != nil {
		o.Log.Warn("turn notification failed", "session", id, "kind", kind, "err", err)
	}
}

// Message renders the synthesized report text within the report size limit.
func Message(kind string, rec domain.SessionRecord, last string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[auto] %s: ", kind)
	if kind == KindExited {
		b.WriteString("the worker's agent session ended")
	} else {
		b.WriteString("the worker's turn ended and it went idle without filing an ao report")
	}
	if rec.Metadata.Branch != "" {
		fmt.Fprintf(&b, " (branch %s)", rec.Metadata.Branch)
	}
	b.WriteString(".")
	if last = strings.TrimSpace(last); last != "" {
		b.WriteString("\nLast message: ")
		b.WriteString(truncate(last, MaxExcerptCharacters))
	}
	return truncate(b.String(), domain.MaxReportTextCharacters)
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}
