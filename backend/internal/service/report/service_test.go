package report

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct {
	session domain.SessionRecord
	ok      bool
	created domain.ReportRecord
	reports []domain.ReportRecord
}

func (f *fakeStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return f.session, f.ok, nil
}
func (f *fakeStore) CreateReport(_ context.Context, r domain.ReportRecord) (domain.ReportRecord, error) {
	f.created = r
	return r, nil
}
func (f *fakeStore) ListReportsByProject(context.Context, domain.ProjectID) ([]domain.ReportRecord, error) {
	return append([]domain.ReportRecord(nil), f.reports...), nil
}

func TestListProjectIsReadOnlyAndOrdered(t *testing.T) {
	at := time.Date(2026, 9, 15, 1, 2, 3, 0, time.UTC)
	outputs := []domain.ReportOutput{
		{Kind: domain.ReportOutputArtifact, Reference: "first"},
		{Kind: domain.ReportOutputArtifact, Reference: "second"},
	}
	st := &fakeStore{reports: []domain.ReportRecord{
		{ID: "c", CreatedAt: at.Add(time.Second)},
		{ID: "b", CreatedAt: at, Outputs: outputs},
		{ID: "a", CreatedAt: at},
	}}
	got, err := New(Deps{Store: st}).ListProject(context.Background(), "ao")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != "a" || got[1].ID != "b" || got[2].ID != "c" {
		t.Fatalf("report order = %+v", got)
	}
	if len(got[1].Outputs) != 2 || got[1].Outputs[0].Reference != "first" || got[1].Outputs[1].Reference != "second" {
		t.Fatalf("output position order = %+v", got[1].Outputs)
	}
}

func TestCreateDerivesOwnershipAndFixedDeliveryDeadlines(t *testing.T) {
	now := time.Date(2026, 9, 7, 1, 2, 3, 0, time.UTC)
	tests := []struct {
		name      string
		input     CreateInput
		available time.Time
		settles   time.Time
	}{
		{name: "free form batches for one hour", input: CreateInput{Message: "status"}, available: now.Add(time.Hour)},
		{name: "output only batches for one hour", input: CreateInput{Outputs: []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "result"}}}, available: now.Add(time.Hour)},
		{name: "checkpoint batches for one hour", input: CreateInput{State: domain.ReportCheckpoint, Note: "checkpoint"}, available: now.Add(time.Hour)},
		{name: "needs input is immediate", input: CreateInput{State: domain.ReportNeedsInput, Note: "decision"}, available: now},
		{name: "stuck is immediate", input: CreateInput{State: domain.ReportStuck, Note: "blocked"}, available: now},
		{name: "done settles for five minutes", input: CreateInput{State: domain.ReportDone, Note: "finished"}, available: now.Add(5 * time.Minute), settles: now.Add(5 * time.Minute)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := &fakeStore{ok: true, session: domain.SessionRecord{ID: "ao-7", ProjectID: "ao", Kind: domain.KindWorker}}
			s := New(Deps{Store: st, Now: func() time.Time { return now }, NewID: func() string { return "rpt_1" }})
			tc.input.SessionID = "ao-7"
			r, err := s.Create(context.Background(), tc.input)
			if err != nil {
				t.Fatal(err)
			}
			if r.ID != "rpt_1" || r.ProjectID != "ao" || r.DeliveryState != domain.ReportPending || r.RepeatCount != 1 || !r.AvailableAt.Equal(tc.available) || !r.SettlementDeadline.Equal(tc.settles) {
				t.Fatalf("report=%+v", r)
			}
		})
	}
}

func TestCreateDefendsValidationAndOwnership(t *testing.T) {
	worker := &fakeStore{ok: true, session: domain.SessionRecord{ID: "ao-2", ProjectID: "ao", Kind: domain.KindWorker}}
	for _, tc := range []struct {
		name  string
		store *fakeStore
		input CreateInput
	}{
		{"missing session", worker, CreateInput{Message: "message"}},
		{"unknown session", &fakeStore{}, CreateInput{SessionID: "ao-2", State: domain.ReportDone, Note: "done"}},
		{"orchestrator", &fakeStore{ok: true, session: domain.SessionRecord{ID: "ao-1", ProjectID: "ao", Kind: domain.KindOrchestrator}}, CreateInput{SessionID: "ao-1", State: domain.ReportDone, Note: "done"}},
		{"bad state", worker, CreateInput{SessionID: "ao-2", State: "bad", Note: "note"}},
		{"bad PR", worker, CreateInput{SessionID: "ao-2", Outputs: []domain.ReportOutput{{Kind: domain.ReportOutputPRCreated, Reference: "https://example.com/x"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(Deps{Store: tc.store}).Create(context.Background(), tc.input)
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

type artifactCalls []string

func (a *artifactCalls) RecordReportedArtifact(_ context.Context, id domain.SessionID, reference string) {
	*a = append(*a, string(id)+" "+reference)
}

func TestCreateShowsEachReportedArtifactAfterTheReportIsStored(t *testing.T) {
	st := &fakeStore{ok: true, session: domain.SessionRecord{ID: "ao-7", ProjectID: "ao", Kind: domain.KindWorker}}
	var calls artifactCalls
	r, err := New(Deps{Store: st, Artifacts: &calls}).Create(context.Background(), CreateInput{
		SessionID: "ao-7", State: domain.ReportDone, Note: "done",
		Outputs: []domain.ReportOutput{
			{Kind: domain.ReportOutputArtifact, Reference: "report.html"},
			{Kind: domain.ReportOutputPRCreated, Reference: "https://github.com/o/r/pull/1"},
			{Kind: domain.ReportOutputArtifact, Reference: "/abs/notes.md"},
		},
	})
	if err != nil || r.ID == "" || st.created.ID != r.ID {
		t.Fatalf("report = %+v, %v", r, err)
	}
	if len(calls) != 2 || calls[0] != "ao-7 report.html" || calls[1] != "ao-7 /abs/notes.md" {
		t.Fatalf("recorded = %q, want the two artifacts in order", calls)
	}

	// A refused report shows nothing.
	calls = nil
	if _, err := New(Deps{Store: &fakeStore{}, Artifacts: &calls}).Create(context.Background(), CreateInput{
		SessionID: "ao-7", Outputs: []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "report.html"}},
	}); err == nil || len(calls) != 0 {
		t.Fatalf("unknown session: err = %v, recorded %q", err, calls)
	}
}

type verifyStore struct {
	fakeStore
	project   domain.ProjectRecord
	projectOK bool
	prs       []domain.PullRequest
	prErr     error
}

func (v *verifyStore) GetProject(context.Context, string) (domain.ProjectRecord, bool, error) {
	return v.project, v.projectOK, nil
}
func (v *verifyStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	return v.prs, v.prErr
}

func TestCreateDoneAnnotatesUnverified(t *testing.T) {
	pr := []domain.PullRequest{{URL: "https://github.com/o/r/pull/1"}}
	tests := []struct {
		name    string
		mutate  func(*verifyStore)
		state   domain.ReportState
		outputs []domain.ReportOutput
		want    string
	}{
		{name: "no PR", want: "x\n\ndone (unverified: no pull request recorded for this session)"},
		{name: "PR with pushed head", mutate: func(v *verifyStore) { v.prs = pr }, want: "x"},
		{name: "PR with unpushed head", mutate: func(v *verifyStore) {
			v.prs = pr
			v.session.BranchState = &domain.SessionBranchState{Commits: 3, Unpushed: 2, RemoteBranch: "origin/b"}
		}, want: "x\n\ndone (unverified: 2 unpushed commit(s))"},
		{name: "unpushed without PR", mutate: func(v *verifyStore) {
			v.session.BranchState = &domain.SessionBranchState{Commits: 1, Unpushed: 1}
		}, want: "x\n\ndone (unverified: 1 unpushed commit(s))"},
		{name: "no commits needs no PR", mutate: func(v *verifyStore) { v.session.BranchState = &domain.SessionBranchState{} }, want: "x"},
		{name: "needs-input is never annotated", state: domain.ReportNeedsInput, want: "x"},
		{name: "review-only (reviewed PR output)", outputs: []domain.ReportOutput{{Kind: domain.ReportOutputPRReviewed, Reference: "https://github.com/o/r/pull/9"}}, want: "x"},
		{name: "created PR output", outputs: []domain.ReportOutput{{Kind: domain.ReportOutputPRCreated, Reference: "https://github.com/o/r/pull/9"}}, want: "x"},
		{name: "artifact output reported", outputs: []domain.ReportOutput{{Kind: domain.ReportOutputArtifact, Reference: "r"}}, want: "x"},
		{name: "artifact requested", mutate: func(v *verifyStore) { v.session.RequestedOutput = domain.RequestedOutputArtifact }, want: "x"},
		{name: "artifact output type", mutate: func(v *verifyStore) { v.session.OutputType = domain.SessionOutputArtifact }, want: "x"},
		{name: "projectless", mutate: func(v *verifyStore) { v.session.ProjectID = "" }, want: "x"},
		{name: "project missing", mutate: func(v *verifyStore) { v.projectOK = false }, want: "x"},
		{name: "no remote", mutate: func(v *verifyStore) { v.project.RepoOriginURL = "" }, want: "x"},
		{name: "PR lookup error never rejects", mutate: func(v *verifyStore) { v.prErr = errors.New("db down") }, want: "x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := &verifyStore{
				fakeStore: fakeStore{ok: true, session: domain.SessionRecord{ID: "s1", ProjectID: "p", Kind: domain.KindWorker}},
				project:   domain.ProjectRecord{ID: "p", RepoOriginURL: "git@github.com:o/r.git"},
				projectOK: true,
			}
			if tt.mutate != nil {
				tt.mutate(v)
			}
			state := tt.state
			if state == "" {
				state = domain.ReportDone
			}
			got, err := New(Deps{Store: v}).Create(context.Background(), CreateInput{SessionID: "s1", State: state, Note: "x", Outputs: tt.outputs})
			if err != nil {
				t.Fatal(err)
			}
			if got.Note != tt.want {
				t.Fatalf("note = %q, want %q", got.Note, tt.want)
			}
		})
	}
}

func TestCreateDoneAnnotationStaysWithinTextLimit(t *testing.T) {
	v := &verifyStore{
		fakeStore: fakeStore{ok: true, session: domain.SessionRecord{ID: "s1", ProjectID: "p", Kind: domain.KindWorker}},
		project:   domain.ProjectRecord{ID: "p", RepoOriginURL: "u"},
		projectOK: true,
	}
	long := strings.Repeat("a", domain.MaxReportTextCharacters)
	got, err := New(Deps{Store: v}).Create(context.Background(), CreateInput{SessionID: "s1", State: domain.ReportDone, Note: long})
	if err != nil {
		t.Fatal(err)
	}
	if n := utf8.RuneCountInString(got.Note); n > domain.MaxReportTextCharacters || !strings.HasSuffix(got.Note, "recorded for this session)") {
		t.Fatalf("note length %d, tail %q", n, got.Note[len(got.Note)-40:])
	}
}

func TestCreateDoneSkipsVerificationWithoutStoreCapabilities(t *testing.T) {
	st := &fakeStore{ok: true, session: domain.SessionRecord{ID: "s1", ProjectID: "p", Kind: domain.KindWorker}}
	got, err := New(Deps{Store: st}).Create(context.Background(), CreateInput{SessionID: "s1", State: domain.ReportDone, Note: "x"})
	if err != nil || got.Note != "x" {
		t.Fatalf("note = %q err = %v", got.Note, err)
	}
}
