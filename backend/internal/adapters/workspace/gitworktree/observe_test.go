package gitworktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestParseObservedWorkspaceChanges(t *testing.T) {
	changes, staged, untracked := parseObservedWorkspaceChanges(" M tracked.go\nA  staged.go\n?? new file.md\n", 2)
	if !staged || !untracked {
		t.Fatalf("flags = staged %v, untracked %v; want both true", staged, untracked)
	}
	want := []ports.WorkspaceChange{
		{Path: "tracked.go", Status: " M"},
		{Path: "staged.go", Status: "A "},
	}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes = %#v, want %#v", changes, want)
	}
}

func TestObserveWorkspaceReturnsBoundedGitFacts(t *testing.T) {
	root := t.TempDir()
	workspacePath := filepath.Join(root, "project", "session-1")
	if err := os.MkdirAll(workspacePath, 0o750); err != nil {
		t.Fatal(err)
	}
	physicalRoot, err := physicalAbs(root)
	if err != nil {
		t.Fatal(err)
	}
	physicalWorkspace, err := physicalAbs(workspacePath)
	if err != nil {
		t.Fatal(err)
	}
	w := &Workspace{
		binary:      "git",
		managedRoot: physicalRoot,
		run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			switch args[2] {
			case "rev-parse":
				return []byte("abc123\n"), nil
			case "branch":
				return []byte("feature/switch\n"), nil
			case "status":
				return []byte(" M manager.go\n?? notes.md\n"), nil
			case "log":
				return []byte("abc123\x1fimplement switch\x1f2026-08-04T10:00:00Z\x1e"), nil
			default:
				t.Fatalf("unexpected git args: %#v", args)
				return nil, nil
			}
		},
	}

	got, err := w.ObserveWorkspace(context.Background(), ports.WorkspaceInfo{Path: physicalWorkspace})
	if err != nil {
		t.Fatal(err)
	}
	if got.HeadSHA != "abc123" || got.Branch != "feature/switch" || !got.Dirty || !got.Untracked || got.Staged {
		t.Fatalf("observation = %#v", got)
	}
	if len(got.Commits) != 1 || got.Commits[0].Subject != "implement switch" {
		t.Fatalf("commits = %#v", got.Commits)
	}
}

func TestObserveWorkspaceLanded(t *testing.T) {
	root := t.TempDir()
	workspacePath := filepath.Join(root, "project", "session-1")
	if err := os.MkdirAll(workspacePath, 0o750); err != nil {
		t.Fatal(err)
	}
	physicalRoot, err := physicalAbs(root)
	if err != nil {
		t.Fatal(err)
	}
	physicalWorkspace, err := physicalAbs(workspacePath)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name      string
		info      ports.WorkspaceInfo
		revList   string
		revErr    error
		want      bool
		wantProbe bool
	}{
		{name: "contained in base", info: ports.WorkspaceInfo{BaseRef: "origin/main", BaseSHA: "old"}, want: true, wantProbe: true},
		{name: "unmerged commits", info: ports.WorkspaceInfo{BaseRef: "origin/main", BaseSHA: "old"}, revList: "abc123\n", wantProbe: true},
		{name: "base ref missing locally", info: ports.WorkspaceInfo{BaseRef: "origin/gone", BaseSHA: "old"}, revErr: errors.New("bad revision"), wantProbe: true},
		{name: "HEAD fallback base", info: ports.WorkspaceInfo{BaseRef: "HEAD", BaseSHA: "old"}},
		{name: "no base ref", info: ports.WorkspaceInfo{BaseSHA: "old"}},
		{name: "head still at creation commit", info: ports.WorkspaceInfo{BaseRef: "origin/main", BaseSHA: "abc123"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probed := false
			w := &Workspace{
				binary:      "git",
				managedRoot: physicalRoot,
				run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
					switch args[2] {
					case "rev-parse":
						return []byte("abc123\n"), nil
					case "branch", "status", "log":
						return nil, nil
					case "rev-list":
						probed = true
						want := []string{"-C", physicalWorkspace, "rev-list", "-n", "1", "HEAD", "--not", tt.info.BaseRef, "--"}
						if !reflect.DeepEqual(args, want) {
							t.Fatalf("rev-list args = %#v, want %#v", args, want)
						}
						return []byte(tt.revList), tt.revErr
					default:
						t.Fatalf("unexpected git args: %#v", args)
						return nil, nil
					}
				},
			}
			tt.info.Path = physicalWorkspace
			got, err := w.ObserveWorkspace(context.Background(), tt.info)
			if err != nil {
				t.Fatal(err)
			}
			if got.Landed != tt.want || probed != tt.wantProbe {
				t.Fatalf("Landed = %v (probed %v), want %v (probed %v)", got.Landed, probed, tt.want, tt.wantProbe)
			}
		})
	}
}
