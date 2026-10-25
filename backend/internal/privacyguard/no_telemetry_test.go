// Package privacyguard holds a repo-wide check that third-party telemetry,
// analytics, and crash-reporting SDKs never come back. AO ships no remote
// telemetry; see the "No telemetry" hard rule in AGENTS.md.
package privacyguard

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var (
	// A dependency manifest or lockfile may not name a banned SDK at all.
	bannedInManifest = regexp.MustCompile(`(?i)posthog|getsentry|@sentry/|sentry-go|sentry-expo|sentry-react-native|sentry\.io`)
	// Source files may not import one. Matches Go import specs and JS/TS
	// import/require/dynamic-import specifiers.
	bannedImport = regexp.MustCompile(`(?i)(?:^\s*(?:[\w.]+\s+)?"|\bfrom\s+["']|\bimport\s*\(?\s*["']|\brequire\(\s*["'])[^"']*(?:posthog|getsentry|@sentry/|sentry-go|sentry-expo|sentry-react-native)`)
)

var manifestNames = map[string]bool{
	"go.mod": true, "go.sum": true, "go.work.sum": true,
	"package.json": true, "package-lock.json": true, "npm-shrinkwrap.json": true,
	"yarn.lock": true, "pnpm-lock.yaml": true,
}

var sourceExts = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "out": true, ".vite": true,
	// The hosted control plane is a separate service with its own review.
	"cloud": true,
	// Private submodules are not checked out in CI.
	"private": true,
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("repository root (go.work) not found")
		}
		dir = parent
	}
}

func TestNoTelemetrySDKsInRepo(t *testing.T) {
	root := repoRoot(t)
	self, _ := filepath.Abs("no_telemetry_test.go")
	var violations []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if abs, _ := filepath.Abs(path); abs == self {
			return nil
		}
		isManifest := manifestNames[d.Name()]
		if !isManifest && !sourceExts[filepath.Ext(d.Name())] {
			return nil
		}
		data, err := os.ReadFile(path) //nolint:gosec // walking our own checkout
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		for i, line := range strings.Split(string(data), "\n") {
			re := bannedImport
			if isManifest {
				re = bannedInManifest
			}
			if re.MatchString(line) {
				violations = append(violations, rel+":"+strconv.Itoa(i+1))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("telemetry/crash-reporting SDKs must not be reintroduced (AGENTS.md, \"No telemetry\"):\n  %s", strings.Join(violations, "\n  "))
	}
}
