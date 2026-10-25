package report

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ReportInterruptWindow is the durable per-worker urgent interruption limit.
const ReportInterruptWindow = 3 * time.Minute

// OrchestratorBusyRetry is how long a batch refused with ErrOrchestratorBusy
// waits before its next delivery attempt.
const OrchestratorBusyRetry = 30 * time.Second

// Delivery retry policy. Transient failures back off exponentially per batch
// (the deferred available_at keeps the batch from being re-picked hot) up to
// MaxDeliveryBackoff; after MaxDeliveryAttempts a batch only retries every
// ExhaustedDeliveryRetry.
const (
	MaxDeliveryBackoff     = 10 * time.Minute
	MaxDeliveryAttempts    = 10
	ExhaustedDeliveryRetry = time.Hour
	// UndeliverableRecheck is how often a project parked for lacking an
	// orchestrator is re-examined (Wake also re-examines it immediately).
	UndeliverableRecheck = time.Minute
	// errorLogInterval rate-limits repeated identical delivery error logs.
	errorLogInterval = 5 * time.Minute
	scheduleLimit    = 1000
)

// errNoOrchestrator marks a project whose reports cannot be delivered because
// it has no live orchestrator. It is not retried hot.
var errNoOrchestrator = errors.New("project has no active orchestrator")

// ErrReportDeliveryModeUnsupported reports a target without semantic delivery.
var ErrReportDeliveryModeUnsupported = errors.New("report delivery requires a semantic conversation")

// ErrOrchestratorBusy marks a Submit refused because the orchestrator cannot
// take the batch right now — its composer holds the operator's unsent draft —
// and should be retried later rather than immediately.
var ErrOrchestratorBusy = errors.New("orchestrator cannot take reports right now")

// DeliveryStore is the durable report scheduling and routing boundary.
type DeliveryStore interface {
	ListSessions(context.Context, domain.ProjectID) ([]domain.SessionRecord, error)
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListPendingReportSchedule(context.Context, int64) ([]domain.ReportRecord, error)
	ClaimPendingReportBatch(context.Context, domain.ProjectID, string, time.Time) ([]domain.ReportRecord, error)
	AcknowledgeReportBatch(context.Context, domain.ProjectID, string, time.Time) (int, error)
	ReleaseReportBatch(context.Context, domain.ProjectID, string, time.Time, string) (int, error)
	DeferReportBatch(context.Context, domain.ProjectID, string, time.Time, string) (int, error)
	AcquireReportInterrupt(context.Context, domain.SessionID, time.Time, time.Duration) (bool, time.Time, error)
}

// Delivery submits accepted semantic context and interrupts active work.
type Delivery interface {
	Submit(context.Context, domain.SessionID, string, string) error
	Interrupt(context.Context, domain.SessionID) error
}

// Coordinator delivers durable report batches to active orchestrators.
type Coordinator struct {
	store      DeliveryStore
	delivery   Delivery
	now        func() time.Time
	newToken   func() string
	retryDelay time.Duration
	wake       chan struct{}
	rewake     atomic.Bool
	mu         sync.Mutex
	log        *slog.Logger
	// holds delays projects in memory: parked ones lack an orchestrator,
	// others failed before a batch could be claimed (so no durable backoff).
	holds   map[domain.ProjectID]hold
	logged  map[string]time.Time
	statusM sync.Mutex
	parked  map[domain.ProjectID]time.Time
}

type hold struct {
	until  time.Time
	parked bool
}

// CoordinatorDeps configures durable scheduling and delivery.
type CoordinatorDeps struct {
	Store      DeliveryStore
	Delivery   Delivery
	Now        func() time.Time
	NewToken   func() string
	RetryDelay time.Duration
	Logger     *slog.Logger
}

// NewCoordinator constructs an idle report delivery coordinator.
func NewCoordinator(d CoordinatorDeps) *Coordinator {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewToken == nil {
		d.NewToken = uuid.NewString
	}
	if d.RetryDelay <= 0 {
		d.RetryDelay = 5 * time.Second
	}
	if d.Logger == nil {
		d.Logger = slog.New(slog.DiscardHandler)
	}
	return &Coordinator{
		store: d.Store, delivery: d.Delivery, now: d.Now, newToken: d.NewToken, retryDelay: d.RetryDelay,
		wake: make(chan struct{}, 1), log: d.Logger,
		holds: map[domain.ProjectID]hold{}, logged: map[string]time.Time{}, parked: map[domain.ProjectID]time.Time{},
	}
}

// UndeliverableProjects lists projects whose pending reports are parked because
// no orchestrator is running, with the time each was first parked.
func (c *Coordinator) UndeliverableProjects() map[domain.ProjectID]time.Time {
	out := map[domain.ProjectID]time.Time{}
	if c == nil {
		return out
	}
	c.statusM.Lock()
	defer c.statusM.Unlock()
	for id, since := range c.parked {
		out[id] = since
	}
	return out
}

// Wake asks the coordinator to inspect durable scheduling state.
func (c *Coordinator) Wake() {
	if c == nil {
		return
	}
	c.rewake.Store(true)
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// Start runs delivery until ctx is cancelled and returns its completion signal.
func (c *Coordinator) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() { defer close(done); c.run(ctx) }()
	return done
}

func (c *Coordinator) run(ctx context.Context) {
	for {
		delay, err := c.RunDue(ctx)
		if err != nil {
			c.logRateLimited("run-due", "report delivery failed", err)
		}
		if delay < 0 && err != nil {
			delay = c.retryDelay
		}
		if delay < 0 {
			delay = time.Hour
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-c.wake:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
}

// RunDue performs bounded due delivery and returns the delay until the next
// durable deadline. Tests call it directly with fake time.
func (c *Coordinator) RunDue(ctx context.Context) (time.Duration, error) {
	if c == nil || c.store == nil || c.delivery == nil {
		return -1, errors.New("report coordinator dependencies are required")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// A Wake means something changed (new report, new orchestrator): give
	// every parked or held project another look.
	if c.rewake.Swap(false) {
		c.holds = map[domain.ProjectID]hold{}
	}
	var errs []error
	for {
		pending, err := c.store.ListPendingReportSchedule(ctx, scheduleLimit)
		if err != nil {
			return c.retryDelay, errors.Join(append(errs, err)...)
		}
		now := c.now().UTC()
		next := time.Duration(-1)
		note := func(d time.Duration) {
			if d < 0 {
				d = 0
			}
			if next < 0 || d < next {
				next = d
			}
		}
		live := map[domain.ProjectID]bool{}
		delivered := false
		// pending holds one row per project, earliest first.
		for _, rec := range pending {
			project := rec.ProjectID
			live[project] = true
			if h, ok := c.holds[project]; ok && h.until.After(now) {
				note(h.until.Sub(now))
				continue
			}
			if rec.AvailableAt.After(now) {
				note(rec.AvailableAt.Sub(now))
				continue
			}
			err := c.deliverProject(ctx, project)
			switch {
			case err == nil:
				delete(c.holds, project)
				c.unpark(project)
				delivered = true
			case errors.Is(err, errNoOrchestrator):
				c.park(project, now)
				c.holds[project] = hold{until: now.Add(UndeliverableRecheck), parked: true}
				note(UndeliverableRecheck)
			default:
				errs = append(errs, fmt.Errorf("project %s: %w", project, err))
				c.holds[project] = hold{until: now.Add(c.retryDelay)}
				note(c.retryDelay)
			}
			if delivered {
				break
			}
		}
		if delivered {
			continue
		}
		for project := range c.holds {
			if !live[project] {
				delete(c.holds, project)
				c.unpark(project)
			}
		}
		return next, errors.Join(errs...)
	}
}

func (c *Coordinator) park(project domain.ProjectID, now time.Time) {
	c.statusM.Lock()
	_, already := c.parked[project]
	if !already {
		c.parked[project] = now
	}
	c.statusM.Unlock()
	if !already {
		c.log.Warn("worker reports are undeliverable: project has no active orchestrator; they are parked until one starts", "project", project)
	}
}

func (c *Coordinator) unpark(project domain.ProjectID) {
	c.statusM.Lock()
	_, was := c.parked[project]
	delete(c.parked, project)
	c.statusM.Unlock()
	if was {
		c.log.Info("parked worker reports are deliverable again", "project", project)
	}
}

// logRateLimited logs err at most once per errorLogInterval per key.
func (c *Coordinator) logRateLimited(key, msg string, err error) {
	now := c.now()
	c.statusM.Lock()
	last, ok := c.logged[key]
	if ok && now.Sub(last) < errorLogInterval {
		c.statusM.Unlock()
		return
	}
	c.logged[key] = now
	c.statusM.Unlock()
	c.log.Error(msg, "error", err)
}

// backoff defers a claimed batch with exponential delay based on its attempts
// so a failing batch never stays the earliest-due work.
func (c *Coordinator) backoff(ctx context.Context, batch PreparedBatch, cause error) error {
	attempts := int64(1)
	for _, r := range batch.Reports {
		if r.DeliveryAttempts > attempts {
			attempts = r.DeliveryAttempts
		}
	}
	delay := ExhaustedDeliveryRetry
	if attempts < int64(MaxDeliveryAttempts) {
		delay = c.retryDelay
		for i := int64(1); i < attempts && delay < MaxDeliveryBackoff; i++ {
			delay *= 2
		}
		if delay > MaxDeliveryBackoff {
			delay = MaxDeliveryBackoff
		}
	}
	_, deferErr := c.store.DeferReportBatch(ctx, batch.ProjectID, batch.Token, c.now().UTC().Add(delay), cause.Error())
	if deferErr != nil {
		return errors.Join(cause, deferErr)
	}
	return cause
}

func (c *Coordinator) deliverProject(ctx context.Context, projectID domain.ProjectID) error {
	target, ok, err := c.activeOrchestrator(ctx, projectID)
	if err != nil {
		return err
	}
	if !ok {
		return errNoOrchestrator
	}
	batch, err := c.claim(ctx, projectID)
	if err != nil || len(batch.Reports) == 0 {
		return err
	}
	if batch.hasState(domain.ReportStuck) {
		interrupted := false
		var nextInterrupt time.Time
		for _, worker := range batch.stuckWorkers() {
			acquired, next, acquireErr := c.store.AcquireReportInterrupt(ctx, worker, c.now().UTC(), ReportInterruptWindow)
			if acquireErr != nil {
				return c.backoff(ctx, batch, acquireErr)
			}
			if acquired {
				interrupted = true
				if interruptErr := c.delivery.Interrupt(ctx, target.ID); interruptErr != nil {
					return c.backoff(ctx, batch, interruptErr)
				}
			} else if nextInterrupt.IsZero() || next.Before(nextInterrupt) {
				nextInterrupt = next
			}
		}
		if !interrupted && !batch.hasState(domain.ReportNeedsInput) {
			_, deferErr := c.store.DeferReportBatch(ctx, batch.ProjectID, batch.Token, nextInterrupt, "repeated stuck report coalesced inside interrupt window")
			return deferErr
		}
	}
	if err := c.delivery.Submit(ctx, target.ID, batch.Render(), batch.IdempotencyKey()); err != nil {
		if errors.Is(err, ErrOrchestratorBusy) {
			_, deferErr := c.store.DeferReportBatch(ctx, batch.ProjectID, batch.Token, c.now().UTC().Add(OrchestratorBusyRetry), err.Error())
			return deferErr
		}
		return c.backoff(ctx, batch, err)
	}
	_, err = c.store.AcknowledgeReportBatch(ctx, batch.ProjectID, batch.Token, c.now().UTC())
	return err
}

func (c *Coordinator) activeOrchestrator(ctx context.Context, projectID domain.ProjectID) (domain.SessionRecord, bool, error) {
	recs, err := c.store.ListSessions(ctx, projectID)
	if err != nil {
		return domain.SessionRecord{}, false, err
	}
	var selected domain.SessionRecord
	for _, rec := range recs {
		if rec.Kind != domain.KindOrchestrator || rec.IsTerminated || rec.Activity.State == domain.ActivityExited {
			continue
		}
		if selected.ID == "" || rec.CreatedAt.After(selected.CreatedAt) {
			selected = rec
		}
	}
	return selected, selected.ID != "", nil
}

// PreparedBatch is a token-fenced durable batch awaiting acceptance.
type PreparedBatch struct {
	ProjectID domain.ProjectID
	Token     string
	ID        string
	Reports   []domain.ReportRecord
}

func (c *Coordinator) claim(ctx context.Context, projectID domain.ProjectID) (PreparedBatch, error) {
	token := c.newToken()
	reports, err := c.store.ClaimPendingReportBatch(ctx, projectID, token, c.now().UTC())
	for i := range reports {
		session, found, lookupErr := c.store.GetSession(ctx, reports[i].SessionID)
		if lookupErr == nil && found {
			reports[i].SessionDisplayName = strings.TrimSpace(session.DisplayName)
		}
	}
	batchID := ""
	if len(reports) > 0 {
		batchID = reports[0].DeliveryBatchID
	}
	return PreparedBatch{ProjectID: projectID, Token: token, ID: batchID, Reports: reports}, err
}

// PreparePiggyback claims pending reports for the active Chat orchestrator.
// The caller must acknowledge only after its user message is durably accepted.
func (c *Coordinator) PreparePiggyback(ctx context.Context, target domain.SessionID) (PreparedBatch, error) {
	if c == nil || c.store == nil {
		return PreparedBatch{}, nil
	}
	rec, ok, err := c.store.GetSession(ctx, target)
	if err != nil || !ok {
		return PreparedBatch{}, err
	}
	if rec.Kind != domain.KindOrchestrator || rec.IsTerminated || domain.NormalizeSessionMode(rec.Mode) != domain.SessionModeChat {
		return PreparedBatch{}, nil
	}
	return c.claim(ctx, rec.ProjectID)
}

// AcceptPiggyback acknowledges reports after the combined user turn is accepted.
func (c *Coordinator) AcceptPiggyback(ctx context.Context, batch PreparedBatch) error {
	if len(batch.Reports) == 0 {
		return nil
	}
	_, err := c.store.AcknowledgeReportBatch(ctx, batch.ProjectID, batch.Token, c.now().UTC())
	return err
}

// ReleasePiggyback makes a batch retryable when the combined turn was refused.
func (c *Coordinator) ReleasePiggyback(ctx context.Context, batch PreparedBatch, cause error) error {
	if len(batch.Reports) == 0 {
		return nil
	}
	return c.release(ctx, batch, cause)
}

func (c *Coordinator) release(ctx context.Context, batch PreparedBatch, cause error) error {
	_, releaseErr := c.store.ReleaseReportBatch(ctx, batch.ProjectID, batch.Token, c.now().UTC(), cause.Error())
	if releaseErr != nil {
		return errors.Join(cause, releaseErr)
	}
	return cause
}

const (
	chatReportOpen  = "<ao-worker-reports>"
	chatReportClose = "</ao-worker-reports>"
)

// AppendToUserMessage places reports after the user's text in one semantic turn.
// The envelope lets AO's Chat UI hide daemon-authored context while preserving
// the exact prompt accepted by the provider for retry and recovery.
func (b PreparedBatch) AppendToUserMessage(message string) string {
	if len(b.Reports) == 0 {
		return message
	}
	return message + "\n\n" + chatReportOpen + "\n" + b.Render() + "\n" + chatReportClose
}

// IdempotencyKey returns the stable durable delivery identity.
func (b PreparedBatch) IdempotencyKey() string {
	if b.ID != "" {
		return b.ID
	}
	ids := make([]string, len(b.Reports))
	for i := range b.Reports {
		ids[i] = b.Reports[i].ID
	}
	sort.Strings(ids)
	sum := sha256.Sum256([]byte(strings.Join(ids, "\x00")))
	return "report-batch:" + hex.EncodeToString(sum[:16])
}

// Render formats compact attributed report context for an orchestrator.
func (b PreparedBatch) Render() string {
	var out strings.Builder
	out.WriteString("Reports since your previous turn:")
	for _, report := range coalesceReports(b.Reports) {
		state := string(report.State)
		if state == "" {
			state = "information"
		}
		fmt.Fprintf(&out, "\n\n[%s] %s", state, reportSessionLink(report))
		if report.RepeatCount > 1 {
			fmt.Fprintf(&out, " (repeated %d times)", report.RepeatCount)
		}
		text := report.Note
		if text == "" {
			text = report.Message
		}
		if text != "" {
			out.WriteString("\n")
			out.WriteString(text)
		}
		for _, output := range report.Outputs {
			fmt.Fprintf(&out, "\n%s: %s", output.Kind, output.Reference)
		}
	}
	return out.String()
}

func reportDisplayNameOrID(r domain.ReportRecord) string {
	if name := strings.TrimSpace(r.SessionDisplayName); name != "" {
		return name
	}
	return string(r.SessionID)
}

// reportSessionLink is the markdown attribution a standalone report shows.
// Piggybacked copies stay inside the hidden user-message envelope.
func reportSessionLink(r domain.ReportRecord) string {
	label := strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "\n", " ").Replace(reportDisplayNameOrID(r))
	href := "ao://sessions/" + url.PathEscape(string(r.ProjectID)) + "/" + url.PathEscape(string(r.SessionID))
	return "[" + label + "](" + href + ")"
}

func (b PreparedBatch) hasState(state domain.ReportState) bool {
	for _, report := range b.Reports {
		if report.State == state {
			return true
		}
	}
	return false
}

func (b PreparedBatch) stuckWorkers() []domain.SessionID {
	seen := map[domain.SessionID]bool{}
	var out []domain.SessionID
	for _, report := range b.Reports {
		if report.State == domain.ReportStuck && !seen[report.SessionID] {
			seen[report.SessionID] = true
			out = append(out, report.SessionID)
		}
	}
	return out
}

func coalesceReports(in []domain.ReportRecord) []domain.ReportRecord {
	out := make([]domain.ReportRecord, 0, len(in))
	indexes := map[string]int{}
	for _, report := range in {
		key := reportKey(report)
		if report.State == domain.ReportStuck {
			if i, ok := indexes[key]; ok {
				out[i].RepeatCount += report.RepeatCount
				continue
			}
			indexes[key] = len(out)
		}
		out = append(out, report)
	}
	return out
}

func reportKey(report domain.ReportRecord) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\x00%s\x00%s\x00%s", report.SessionID, report.State, report.Note, report.Message)
	for _, output := range report.Outputs {
		fmt.Fprintf(&b, "\x00%s\x00%s\x00%s", output.Kind, output.Reference, output.Label)
	}
	return b.String()
}
