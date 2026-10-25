package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// worktreeIncludeFile is the optional project-root manifest (gitignore syntax)
// naming ignored or untracked files and directories to seed into each new
// session worktree from the main checkout.
const worktreeIncludeFile = ".worktreeinclude"

// seedWorktreeInclude copies untracked paths matching the source checkout's
// .worktreeinclude into destinationRoot. Tracked files are never listed (the
// worktree already has them). Missing sources and entries that fail path
// confinement (managed dirs, symlink escapes) are skipped.
func (w *Workspace) seedWorktreeInclude(ctx context.Context, sourceRoot, destinationRoot string) error {
	manifest := filepath.Join(sourceRoot, worktreeIncludeFile)
	info, err := os.Lstat(manifest)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("gitworktree: stat %s: %w", worktreeIncludeFile, err)
	}
	if !info.Mode().IsRegular() {
		return nil // a symlinked or non-file manifest could point outside the repo
	}
	out, err := w.run(ctx, w.binary, "-C", sourceRoot, "ls-files", "-z", "--others", "--ignored", "--directory", "--exclude-from="+manifest)
	if err != nil {
		return fmt.Errorf("gitworktree: list %s matches: %w", worktreeIncludeFile, err)
	}
	// Seed only paths that the standard excludes also ignore: an untracked but
	// not-ignored copy would show as `??` and leave the worktree permanently dirty.
	ignoredOut, err := w.run(ctx, w.binary, "-C", sourceRoot, "ls-files", "-z", "--others", "--ignored", "--directory", "--exclude-standard")
	if err != nil {
		return fmt.Errorf("gitworktree: list ignored paths: %w", err)
	}
	ignored := strings.Split(string(ignoredOut), "\x00")
	for _, entry := range strings.Split(string(out), "\x00") {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry == "" || !coveredByIgnored(entry, ignored) {
			continue
		}
		rel, err := cleanRelativePath(strings.TrimSuffix(entry, "/"))
		if err != nil || hasWorkspaceManagedComponent(rel) {
			continue
		}
		source := filepath.Join(sourceRoot, filepath.FromSlash(rel))
		destination := filepath.Join(destinationRoot, filepath.FromSlash(rel))
		if !assetPathWithin(sourceRoot, source) || !assetPathWithin(destinationRoot, destination) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return err
		}
		if err := seedWorktreeIncludeEntry(ctx, sourceRoot, source, destination); err != nil {
			return fmt.Errorf("gitworktree: seed %s entry %q: %w", worktreeIncludeFile, rel, err)
		}
	}
	return nil
}

// seedWorktreeIncludeEntry copies one manifest match. Directories are walked
// here so a single unsafe or vanished child is skipped without discarding its
// siblings; each leaf goes through copyWorkspaceAssetTree for confinement.
func seedWorktreeIncludeEntry(ctx context.Context, sourceRoot, source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.IsDir() {
		if err := os.MkdirAll(destination, info.Mode().Perm()|0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if hasWorkspaceManagedComponent(entry.Name()) {
				continue
			}
			if err := seedWorktreeIncludeEntry(ctx, sourceRoot, filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	err = copyWorkspaceAssetTree(sourceRoot, source, destination)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrUnsafePath) {
		return nil
	}
	return err
}

// copyPath copies the regular file at src to dst, preserving permission bits.
// It is the single seam for file duplication so a platform-specific
// copy-on-write clone can replace it without touching manifest logic.
func copyPath(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if err := out.Chmod(info.Mode().Perm()); err != nil {
		_ = out.Close()
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

// coveredByIgnored reports whether entry is itself ignored or sits inside an
// ignored directory (ls-files --directory collapses ignored directories).
func coveredByIgnored(entry string, ignored []string) bool {
	for _, ig := range ignored {
		if ig == "" {
			continue
		}
		if entry == ig || (strings.HasSuffix(ig, "/") && strings.HasPrefix(entry, ig)) {
			return true
		}
	}
	return false
}
