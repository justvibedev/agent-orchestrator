package review

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
)

type fakeStore struct {
	run                     domain.ReviewRun
	ok                      bool
	review                  domain.Review
	reviewOK                bool
	batchRuns               []domain.ReviewRun
	prs                     []domain.PullRequest
	prReviews               map[string][]domain.PullRequestReview
	prComments              map[string][]domain.PullRequestComment
	sessionAutoInjectReview *bool
	autoInjectSets          []bool

	updateCalls        int
	activityUpdates    int
	resolvedCommentIDs []string
}

type fakeNotificationSink struct {
	intents []ports.NotificationIntent
}

func (f *fakeNotificationSink) Notify(_ context.Context, intent ports.NotificationIntent) error {
	f.intents = append(f.intents, intent)
	return nil
}

func (f *fakeStore) GetReviewByID(_ context.Context, id string) (domain.Review, bool, error) {
	if f.reviewOK && f.review.ID == id {
		return f.review, true, nil
	}
	return domain.Review{}, false, nil
}

func (f *fakeStore) UpdateReviewActivity(_ context.Context, id string, state domain.ActivityState, agentSessionID, launchID string) (bool, error) {
	if !f.reviewOK || f.review.ID != id {
		return false, nil
	}
	switch {
	case f.review.ReviewerLaunchID != "" && launchID != f.review.ReviewerLaunchID:
		return false, nil
	case f.review.ReviewerLaunchID == "" && launchID != "":
		return false, nil
	}
	f.activityUpdates++
	if agentSessionID != "" {
		f.review.AgentSessionID = agentSessionID
	}
	if state != "" {
		f.review.ReviewerActivityState = state
	}
	if launchID != "" {
		f.review.ReviewerLaunchID = launchID
	}
	return true, nil
}

func (f *fakeStore) GetReviewRun(_ context.Context, id string) (domain.ReviewRun, bool, error) {
	for _, run := range f.batchRuns {
		if run.ID == id {
			return run, true, nil
		}
	}
	if f.ok && f.run.ID == id {
		return f.run, true, nil
	}
	return domain.ReviewRun{}, false, nil
}

func (f *fakeStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	enabled := true
	if f.sessionAutoInjectReview != nil {
		enabled = *f.sessionAutoInjectReview
	}
	return domain.SessionRecord{ID: id, AutoInjectReview: enabled}, true, nil
}

func (f *fakeStore) SetSessionAutoInjectReview(_ context.Context, _ domain.SessionID, autoInject bool, _ time.Time) (bool, error) {
	f.autoInjectSets = append(f.autoInjectSets, autoInject)
	f.sessionAutoInjectReview = &autoInject
	return true, nil
}

func (f *fakeStore) UpdateReviewRunResult(_ context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string, autoInjectReview bool) (bool, error) {
	for i := range f.batchRuns {
		if f.batchRuns[i].ID == id {
			if f.batchRuns[i].Status != domain.ReviewRunRunning {
				return false, nil
			}
			f.updateCalls++
			f.batchRuns[i].Status = status
			f.batchRuns[i].Verdict = verdict
			f.batchRuns[i].Body = body
			f.batchRuns[i].GithubReviewID = githubReviewID
			f.batchRuns[i].AutoInjectReview = autoInjectReview
			if f.run.ID == id {
				f.run = f.batchRuns[i]
			}
			return true, nil
		}
	}
	if f.run.Status != domain.ReviewRunRunning {
		return false, nil
	}
	f.updateCalls++
	f.run.Status = status
	f.run.Verdict = verdict
	f.run.Body = body
	f.run.GithubReviewID = githubReviewID
	f.run.AutoInjectReview = autoInjectReview
	return true, nil
}

func (f *fakeStore) ListReviewRunsByBatch(context.Context, domain.SessionID, string) ([]domain.ReviewRun, error) {
	out := append([]domain.ReviewRun(nil), f.batchRuns...)
	return out, nil
}

func (f *fakeStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	out := append([]domain.PullRequest(nil), f.prs...)
	return out, nil
}

func (f *fakeStore) ListPRReviews(_ context.Context, prURL string) ([]domain.PullRequestReview, error) {
	out := append([]domain.PullRequestReview(nil), f.prReviews[prURL]...)
	return out, nil
}

func (f *fakeStore) ListPRComments(_ context.Context, prURL string) ([]domain.PullRequestComment, error) {
	out := append([]domain.PullRequestComment(nil), f.prComments[prURL]...)
	return out, nil
}

func (f *fakeStore) MarkPRCommentResolved(_ context.Context, prURL, commentID string) (bool, error) {
	f.resolvedCommentIDs = append(f.resolvedCommentIDs, commentID)
	comments := f.prComments[prURL]
	for i := range comments {
		if comments[i].ID == commentID {
			comments[i].Resolved = true
			f.prComments[prURL] = comments
			return true, nil
		}
	}
	return false, nil
}

type fakeReviewResolver struct {
	request ports.SCMReviewResolveRequest
	err     error
}

func (f *fakeReviewResolver) ResolveReviewThread(_ context.Context, request ports.SCMReviewResolveRequest) error {
	f.request = request
	return f.err
}

type fakeReviewRequester struct {
	request ports.SCMReviewRequest
	err     error
}

func (f *fakeReviewRequester) RequestReview(_ context.Context, request ports.SCMReviewRequest) error {
	f.request = request
	return f.err
}

func TestResolveReviewCommentResolvesTrackedThread(t *testing.T) {
	prURL := "https://github.com/acme/widget/pull/7"
	commentURL := "https://github.com/acme/widget/pull/7#discussion_r1"
	store := &fakeStore{
		prs: []domain.PullRequest{{URL: prURL, Number: 7, Provider: "github", Repo: "acme/widget"}},
		prComments: map[string][]domain.PullRequestComment{
			prURL: {{ThreadID: "thread-1", ID: "comment-1", URL: commentURL}},
		},
	}
	resolver := &fakeReviewResolver{}
	svc := New(nil, store, WithReviewResolver(resolver))

	if err := svc.ResolveReviewComment(context.Background(), "mer-1", prURL, commentURL); err != nil {
		t.Fatal(err)
	}
	if resolver.request.ThreadID != "thread-1" || resolver.request.PR.Number != 7 {
		t.Fatalf("request = %#v", resolver.request)
	}
	if got := store.resolvedCommentIDs; len(got) != 1 || got[0] != "comment-1" {
		t.Fatalf("resolved comment ids = %#v", got)
	}
	if !store.prComments[prURL][0].Resolved {
		t.Fatalf("comment was not marked resolved: %#v", store.prComments[prURL][0])
	}
}

func TestResolveReviewCommentDoesNotPersistWhenProviderFails(t *testing.T) {
	prURL := "https://github.com/acme/widget/pull/7"
	commentURL := "https://github.com/acme/widget/pull/7#discussion_r1"
	store := &fakeStore{
		prs: []domain.PullRequest{{URL: prURL, Number: 7, Provider: "github", Repo: "acme/widget"}},
		prComments: map[string][]domain.PullRequestComment{
			prURL: {{ThreadID: "thread-1", ID: "comment-1", URL: commentURL}},
		},
	}
	resolver := &fakeReviewResolver{err: errors.New("provider down")}
	svc := New(nil, store, WithReviewResolver(resolver))

	if err := svc.ResolveReviewComment(context.Background(), "mer-1", prURL, commentURL); err == nil {
		t.Fatal("ResolveReviewComment error = nil, want provider failure")
	}
	if len(store.resolvedCommentIDs) != 0 {
		t.Fatalf("resolved comment ids = %#v, want none", store.resolvedCommentIDs)
	}
	if store.prComments[prURL][0].Resolved {
		t.Fatalf("comment was marked resolved after provider failure")
	}
}

func TestRequestRereviewRequestsReviewerForTrackedPR(t *testing.T) {
	prURL := "https://github.com/acme/widget/pull/7"
	store := &fakeStore{
		prs: []domain.PullRequest{{
			URL:      prURL,
			Number:   7,
			Provider: "github",
			Host:     "github.com",
			Repo:     "acme/widget",
		}},
		prReviews: map[string][]domain.PullRequestReview{
			prURL: {{Author: "prateek"}},
		},
	}
	requester := &fakeReviewRequester{}
	svc := New(nil, store, WithReviewRequester(requester))

	if err := svc.RequestRereview(context.Background(), "mer-1", prURL, "@prateek"); err != nil {
		t.Fatal(err)
	}
	if requester.request.Reviewer != "prateek" || requester.request.PR.Number != 7 || requester.request.PR.Repo.Owner != "acme" || requester.request.PR.Repo.Name != "widget" {
		t.Fatalf("request = %#v", requester.request)
	}
}

func TestRequestRereviewRejectsUnknownReviewer(t *testing.T) {
	prURL := "https://github.com/acme/widget/pull/7"
	store := &fakeStore{
		prs:       []domain.PullRequest{{URL: prURL, Number: 7, Provider: "github", Repo: "acme/widget"}},
		prReviews: map[string][]domain.PullRequestReview{prURL: {{Author: "someone-else"}}},
	}
	svc := New(nil, store, WithReviewRequester(&fakeReviewRequester{}))

	if err := svc.RequestRereview(context.Background(), "mer-1", prURL, "prateek"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("error = %v, want ErrInvalid", err)
	}
}

// AO never sends the worker a separate verdict message: the reviewer's posted
// review reaches the worker through the SCM observer like any other review. A
// submitted result is recorded and stays complete.
func TestSubmitRecordsTheResultWithoutASeparateDelivery(t *testing.T) {
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}},
	}
	svc := New(nil, st)

	for _, verdict := range []domain.ReviewVerdict{domain.VerdictChangesRequested, domain.VerdictApproved} {
		st.run.Status, st.run.Verdict, st.run.Body = domain.ReviewRunRunning, domain.VerdictNone, ""
		run, err := svc.Submit(context.Background(), "mer-1", "run-1", verdict, "body", "987")
		if err != nil {
			t.Fatalf("%s: Submit: %v", verdict, err)
		}
		if run.Status != domain.ReviewRunComplete || run.DeliveredAt != nil {
			t.Fatalf("%s: run = %+v, want complete and never stamped delivered", verdict, run)
		}
	}
}

func TestApplyReviewActivitySignalPersistsNativeReviewerSessionID(t *testing.T) {
	st := &fakeStore{
		reviewOK: true,
		review:   domain.Review{ID: "review-1", SessionID: "worker-1", Harness: domain.ReviewerOpenCode, AgentSessionID: "old-native"},
	}
	svc := New(nil, st)

	if err := svc.ApplyReviewActivitySignal(context.Background(), "review-1", ActivitySignal{
		Event:          "session-start",
		AgentSessionID: "opencode-native-2",
	}); err != nil {
		t.Fatalf("ApplyReviewActivitySignal: %v", err)
	}
	if st.activityUpdates != 1 || st.review.AgentSessionID != "opencode-native-2" {
		t.Fatalf("activity update calls=%d review=%+v", st.activityUpdates, st.review)
	}
	if st.review.SessionID != "worker-1" {
		t.Fatalf("worker session id changed: %+v", st.review)
	}
}

func TestApplyReviewActivitySignalPersistsReviewerActivityState(t *testing.T) {
	st := &fakeStore{
		reviewOK: true,
		review:   domain.Review{ID: "review-1", SessionID: "worker-1", Harness: domain.ReviewerOpenCode},
	}
	svc := New(nil, st)

	if err := svc.ApplyReviewActivitySignal(context.Background(), "review-1", ActivitySignal{
		Event: "stop",
		State: domain.ActivityIdle,
	}); err != nil {
		t.Fatalf("ApplyReviewActivitySignal: %v", err)
	}
	if st.activityUpdates != 1 || st.review.ReviewerActivityState != domain.ActivityIdle {
		t.Fatalf("activity update calls=%d review=%+v", st.activityUpdates, st.review)
	}
}

func TestApplyReviewActivitySignalIgnoresStaleLaunchGeneration(t *testing.T) {
	st := &fakeStore{
		reviewOK: true,
		review: domain.Review{
			ID:                    "review-1",
			SessionID:             "worker-1",
			Harness:               domain.ReviewerOpenCode,
			ReviewerLaunchID:      "launch-current",
			ReviewerActivityState: domain.ActivityActive,
		},
	}
	svc := New(nil, st)

	if err := svc.ApplyReviewActivitySignal(context.Background(), "review-1", ActivitySignal{
		Event:    "stop",
		State:    domain.ActivityIdle,
		LaunchID: "launch-stale",
	}); err != nil {
		t.Fatalf("ApplyReviewActivitySignal stale generation: %v", err)
	}
	if st.activityUpdates != 0 {
		t.Fatalf("stale generation performed update calls=%d review=%+v", st.activityUpdates, st.review)
	}
	if st.review.ReviewerActivityState != domain.ActivityActive || st.review.ReviewerLaunchID != "launch-current" {
		t.Fatalf("stale generation changed persisted review = %+v", st.review)
	}
}

func TestApplyReviewActivitySignalIgnoresMissingLaunchIDAfterGenerationClaimed(t *testing.T) {
	st := &fakeStore{
		reviewOK: true,
		review: domain.Review{
			ID:                    "review-1",
			SessionID:             "worker-1",
			Harness:               domain.ReviewerOpenCode,
			ReviewerLaunchID:      "launch-current",
			ReviewerActivityState: domain.ActivityActive,
			AgentSessionID:        "native-current",
		},
	}
	svc := New(nil, st)

	if err := svc.ApplyReviewActivitySignal(context.Background(), "review-1", ActivitySignal{
		Event:          "session-start",
		AgentSessionID: "legacy-native",
	}); err != nil {
		t.Fatalf("ApplyReviewActivitySignal missing launch id: %v", err)
	}
	if st.activityUpdates != 0 {
		t.Fatalf("missing launch id performed update calls=%d review=%+v", st.activityUpdates, st.review)
	}
	if st.review.ReviewerActivityState != domain.ActivityActive || st.review.ReviewerLaunchID != "launch-current" || st.review.AgentSessionID != "native-current" {
		t.Fatalf("missing launch id changed persisted review = %+v", st.review)
	}
}

func TestApplyReviewActivitySignalRequiresExistingReviewSession(t *testing.T) {
	svc := New(nil, &fakeStore{})

	err := svc.ApplyReviewActivitySignal(context.Background(), "missing-review", ActivitySignal{AgentSessionID: "native-1"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestSubmitSnapshotsDisabledPolicyAndNeverDeliversOnRetry(t *testing.T) {
	disabled := false
	st := &fakeStore{
		ok:                      true,
		sessionAutoInjectReview: &disabled,
		run: domain.ReviewRun{
			ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning,
		},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}},
	}
	svc := New(nil, st)

	run, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != domain.ReviewRunComplete || run.AutoInjectReview {
		t.Fatalf("disabled review = %+v", run)
	}

	enabled := true
	st.sessionAutoInjectReview = &enabled
	run, err = svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != domain.ReviewRunComplete || run.AutoInjectReview {
		t.Fatalf("retry rewrote disabled review = %+v", run)
	}
}

func TestSubmitEmitsIdempotentReviewResultNotification(t *testing.T) {
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "https://github.com/acme/app/pull/42", Status: domain.ReviewRunRunning},
		prs: []domain.PullRequest{{URL: "https://github.com/acme/app/pull/42", Number: 42, Title: "Fix checkout"}},
	}
	sink := &fakeNotificationSink{}
	svc := New(nil, st, WithNotificationSink(sink))

	for range 2 {
		if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictApproved, "looks good", "987"); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if len(sink.intents) != 2 {
		t.Fatalf("notification attempts = %d, want 2 so durable source-key dedupe can recover retries", len(sink.intents))
	}
	for _, intent := range sink.intents {
		if intent.Type != domain.NotificationReviewCompleted || intent.SourceKey != "review_run:run-1" || intent.PRNumber != 42 || intent.PRTitle != "Fix checkout" {
			t.Fatalf("notification intent = %+v", intent)
		}
	}
}

func TestSubmitEmitsChangesRequestedNotification(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{
		ID: "run-2", SessionID: "mer-1", PRURL: "https://github.com/acme/app/pull/43", Status: domain.ReviewRunRunning,
	}}
	sink := &fakeNotificationSink{}
	svc := New(nil, st, WithNotificationSink(sink))

	if _, err := svc.Submit(context.Background(), "mer-1", "run-2", domain.VerdictChangesRequested, "fix it", ""); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(sink.intents) != 1 || sink.intents[0].Type != domain.NotificationReviewChangesRequested {
		t.Fatalf("notification intents = %+v", sink.intents)
	}
}

func TestSubmitManySkipsSupersededRunAndRecordsSiblings(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{
		ok: true,
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			// A newer-commit trigger superseded run-2 while the reviewer was still
			// working on the original batch.
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunFailed},
		},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}, {URL: "pr2", HeadSHA: "sha2-new"}},
	}
	svc := New(nil, st, WithClock(func() time.Time { return now }))

	runs, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{
		{RunID: "run-1", Verdict: domain.VerdictChangesRequested, Body: "fix pr1"},
		{RunID: "run-2", Verdict: domain.VerdictChangesRequested, Body: "fix pr2"},
	})
	if err != nil {
		t.Fatalf("SubmitMany must record valid siblings when one run was superseded: %v", err)
	}
	if len(runs) != 1 || runs[0].ID != "run-1" || runs[0].Status != domain.ReviewRunComplete {
		t.Fatalf("want only run-1 recorded, got %+v", runs)
	}
}

func TestSubmitManyRejectsOnlySupersededRuns(t *testing.T) {
	st := &fakeStore{
		ok: true,
		batchRuns: []domain.ReviewRun{{
			ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunCancelled,
		}},
	}
	svc := New(nil, st)

	if _, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{{
		RunID: "run-1", Verdict: domain.VerdictApproved,
	}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	} else if !strings.Contains(err.Error(), "superseded: run-1") {
		t.Fatalf("err = %v, want rejected run id", err)
	}
}

func TestSubmitCompletedRetryRejectsDifferentRecordedFields(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		githubReviewID string
	}{
		{name: "different body", body: "different", githubReviewID: "987"},
		{name: "different review id", body: "fix it", githubReviewID: "654"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := &fakeStore{ok: true, run: domain.ReviewRun{
				ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1",
				Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested,
				Body: "fix it", GithubReviewID: "987",
			}}
			svc := New(nil, st)

			if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, tt.body, tt.githubReviewID); !errors.Is(err, ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
			if st.updateCalls != 0 {
				t.Fatalf("mismatched retry should not rewrite: update=%d", st.updateCalls)
			}
		})
	}
}

func TestTriggerRejectsInvalidReviewerConfigBeforeEngine(t *testing.T) {
	svc := New(nil, &fakeStore{})
	called := false
	svc.engineTrigger = func(
		_ context.Context, _ domain.SessionID, _ reviewcore.TriggerOptions,
	) (reviewcore.TriggerResult, error) {
		called = true
		return reviewcore.TriggerResult{}, nil
	}

	if _, err := svc.TriggerRequested(context.Background(), "worker-1", TriggerRequest{Config: domain.AgentConfig{Mode: "turbo"}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if called {
		t.Fatal("engineTrigger should not run for invalid config")
	}
}

func TestTriggerRequestedEnablesAutoInjectOnlyAfterAPassStarts(t *testing.T) {
	off := false
	st := &fakeStore{sessionAutoInjectReview: &off}
	svc := New(nil, st)
	var gotOpts reviewcore.TriggerOptions
	svc.engineTrigger = func(_ context.Context, _ domain.SessionID, opts reviewcore.TriggerOptions) (reviewcore.TriggerResult, error) {
		gotOpts = opts
		return reviewcore.TriggerResult{Created: true, CreatedRuns: []domain.ReviewRun{{ID: "run-1"}}}, nil
	}

	out, err := svc.TriggerRequested(context.Background(), "worker-1", TriggerRequest{
		Harness: domain.ReviewerCodex, Source: domain.ReviewTriggerAgent, RejectReviewedHead: true, EnableAutoInject: true,
	})
	if err != nil {
		t.Fatalf("TriggerRequested: %v", err)
	}
	if !out.AutoInjectEnabled || len(st.autoInjectSets) != 1 || !st.autoInjectSets[0] {
		t.Fatalf("outcome=%+v sets=%v, want auto-inject turned on once", out, st.autoInjectSets)
	}
	if gotOpts.Source != domain.ReviewTriggerAgent || !gotOpts.RejectReviewedHead || gotOpts.Harness != domain.ReviewerCodex {
		t.Fatalf("engine opts = %+v, want the request forwarded", gotOpts)
	}

	// Already on: nothing to change and nothing to report.
	out, err = svc.TriggerRequested(context.Background(), "worker-1", TriggerRequest{Source: domain.ReviewTriggerAgent, EnableAutoInject: true})
	if err != nil {
		t.Fatalf("second TriggerRequested: %v", err)
	}
	if out.AutoInjectEnabled || len(st.autoInjectSets) != 1 {
		t.Fatalf("outcome=%+v sets=%v, want no second write", out, st.autoInjectSets)
	}
}

func TestTriggerRequestedLeavesAutoInjectWhenTheTriggerIsRejected(t *testing.T) {
	off := false
	st := &fakeStore{sessionAutoInjectReview: &off}
	svc := New(nil, st)
	svc.engineTrigger = func(_ context.Context, _ domain.SessionID, _ reviewcore.TriggerOptions) (reviewcore.TriggerResult, error) {
		return reviewcore.TriggerResult{}, fmt.Errorf("%w: PR #1 head abc was already reviewed", reviewcore.ErrHeadAlreadyReviewed)
	}

	_, err := svc.TriggerRequested(context.Background(), "worker-1", TriggerRequest{Source: domain.ReviewTriggerAgent, RejectReviewedHead: true, EnableAutoInject: true})
	if !errors.Is(err, ErrHeadAlreadyReviewed) || !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrHeadAlreadyReviewed", err)
	}
	if len(st.autoInjectSets) != 0 {
		t.Fatalf("a rejected trigger changed auto-inject: %v", st.autoInjectSets)
	}
}

func TestTriggerRequestedRejectsDaemonOnlySourceAndContradictoryPolicy(t *testing.T) {
	svc := New(nil, &fakeStore{})
	svc.engineTrigger = func(_ context.Context, _ domain.SessionID, _ reviewcore.TriggerOptions) (reviewcore.TriggerResult, error) {
		t.Fatal("engine must not run")
		return reviewcore.TriggerResult{}, nil
	}
	for _, req := range []TriggerRequest{
		{Source: domain.ReviewTriggerAuto},
		{Source: "robot"},
		{Rerun: true, RejectReviewedHead: true},
	} {
		if _, err := svc.TriggerRequested(context.Background(), "worker-1", req); !errors.Is(err, ErrInvalid) {
			t.Fatalf("req %+v: err = %v, want ErrInvalid", req, err)
		}
	}
}

type fakePRRefresher struct {
	calls []string
	err   map[string]error
	// order records refreshes relative to the engine trigger.
	order *[]string
}

func (f *fakePRRefresher) RefreshPR(_ context.Context, _ domain.SessionID, prURL string) error {
	f.calls = append(f.calls, prURL)
	if f.order != nil {
		*f.order = append(*f.order, "refresh "+prURL)
	}
	return f.err[prURL]
}

// A requested review fetches the worker's open PRs fresh first, so it reviews
// the commit really on the PR, and only then plans the pass.
func TestTriggerRequestedRefreshesOpenPRsBeforePlanning(t *testing.T) {
	var order []string
	st := &fakeStore{prs: []domain.PullRequest{
		{URL: "https://api/pr/1", HTMLURL: "https://github.com/o/r/pull/1"},
		{URL: "https://api/pr/2", HTMLURL: "https://github.com/o/r/pull/2", Merged: true},
	}}
	refresher := &fakePRRefresher{order: &order, err: map[string]error{"https://github.com/o/r/pull/1": errors.New("provider down")}}
	svc := New(nil, st, WithPRRefresher(refresher))
	svc.engineTrigger = func(_ context.Context, _ domain.SessionID, _ reviewcore.TriggerOptions) (reviewcore.TriggerResult, error) {
		order = append(order, "trigger")
		return reviewcore.TriggerResult{Created: true}, nil
	}

	if _, err := svc.TriggerRequested(context.Background(), "mer-1", TriggerRequest{Source: domain.ReviewTriggerAgent, RejectReviewedHead: true}); err != nil {
		t.Fatalf("a failed best-effort refresh must fall back to stored facts: %v", err)
	}
	if strings.Join(order, ",") != "refresh https://github.com/o/r/pull/1,trigger" {
		t.Fatalf("order = %v, want the open PR refreshed (merged one skipped) before planning", order)
	}

	order = nil
	if _, err := svc.TriggerAuto(context.Background(), "mer-1", "claude-code"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "trigger" {
		t.Fatalf("auto-review must not refresh (the observer just ran): %v", order)
	}
}

// Naming a PR AO does not track yet attaches it and reviews only it. If it
// cannot be fetched there is nothing to review, so that is an error.
func TestTriggerRequestedNamedPRAttachesItAndTargetsIt(t *testing.T) {
	st := &fakeStore{}
	refresher := &fakePRRefresher{}
	svc := New(nil, st, WithPRRefresher(refresher))
	var got reviewcore.TriggerOptions
	svc.engineTrigger = func(_ context.Context, _ domain.SessionID, opts reviewcore.TriggerOptions) (reviewcore.TriggerResult, error) {
		got = opts
		return reviewcore.TriggerResult{Created: true}, nil
	}
	url := "https://github.com/o/r/pull/9"
	if _, err := svc.TriggerRequested(context.Background(), "mer-1", TriggerRequest{Source: domain.ReviewTriggerAgent, PRURL: " " + url + " "}); err != nil {
		t.Fatalf("TriggerRequested: %v", err)
	}
	if len(refresher.calls) != 1 || refresher.calls[0] != url || got.PRURL != url {
		t.Fatalf("refresh=%v target=%q, want the named PR attached then targeted", refresher.calls, got.PRURL)
	}

	refresher.err = map[string]error{url: fmt.Errorf("%w: owned", reviewcore.ErrPROwnedElsewhere)}
	if _, err := svc.TriggerRequested(context.Background(), "mer-1", TriggerRequest{PRURL: url}); !errors.Is(err, ErrPROwnedElsewhere) {
		t.Fatalf("err = %v, want the attach failure for an untracked PR", err)
	}
}
