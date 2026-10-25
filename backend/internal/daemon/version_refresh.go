package daemon

import (
	"context"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/systeminstall"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

// versionRefreshSweepTick paces moves to a newly installed harness release.
// Sessions must already have been quiet for VersionRefreshIdle, so a tick
// only bounds how long after that they wait.
const versionRefreshSweepTick = time.Minute

type versionRefreshSettings interface {
	VersionRefreshEnabled(ctx context.Context) bool
}

// runVersionRefreshSweep moves idle Chat sessions, and with
// AO_TUI_VERSION_REFRESH idle terminal sessions, still on a replaced harness
// release to the installed one, and removes Homebrew kegs kept for sessions
// that have all moved. It runs whether or not idle hibernation is on, and a
// moved chat is always started again right away on the new release.
func runVersionRefreshSweep(ctx context.Context, cfg config.Config, settings versionRefreshSettings, sessions sessionLifecycle, installs *systeminstall.Service, log *slog.Logger) {
	ticker := time.NewTicker(versionRefreshSweepTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		policy := versionRefreshPolicy(ctx, cfg, settings)
		if policy.Chats {
			if err := sessions.RefreshStaleChats(ctx, policy.MinIdle); err != nil && ctx.Err() == nil {
				log.Warn("moving idle chats to the installed harness release failed", "err", err)
			}
		}
		if policy.Terminals {
			if err := sessions.RefreshStaleTerminals(ctx, policy.MinIdle); err != nil && ctx.Err() == nil {
				log.Warn("restarting idle terminals on the installed harness release failed", "err", err)
			}
		}
		if err := sessions.RetryVersionMoves(ctx); err != nil && ctx.Err() == nil {
			log.Warn("resuming sessions after a failed version move failed", "err", err)
		}
		if installs != nil {
			installs.RunDeferredCleanups(ctx)
			installs.RemoveUnusedManagedReleases(ctx)
		}
	}
}

// versionRefreshPolicy combines the kill switches with the user's setting.
func versionRefreshPolicy(ctx context.Context, cfg config.Config, settings versionRefreshSettings) sessionmanager.VersionRefreshPolicy {
	enabled := cfg.VersionRefresh && settings.VersionRefreshEnabled(ctx)
	return sessionmanager.VersionRefreshPolicy{
		Chats:     enabled,
		Terminals: enabled && cfg.TUIVersionRefresh,
		MinIdle:   cfg.VersionRefreshIdle,
	}
}

// managedHarnessRoot is where AO keeps versioned harness installs: under the
// AO data dir, like every other piece of AO state.
func managedHarnessRoot(cfg config.Config) string {
	if !cfg.ManagedHarnessInstalls || cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(cfg.DataDir, "harnesses")
}
