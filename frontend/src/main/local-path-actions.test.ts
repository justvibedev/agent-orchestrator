import { describe, expect, it, vi } from "vitest";
import { createLocalPathActions, resolveLocalPath } from "./local-path-actions";

type Entry = { kind: "file" | "directory" | "other"; mode?: number };

function setup(entries: Record<string, Entry>, platform: NodeJS.Platform = "darwin") {
	const deps = {
		platform,
		homeDir: "/Users/me",
		stat: vi.fn(async (target: string) => {
			const entry = entries[target];
			if (!entry) throw new Error("ENOENT");
			return { isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory", mode: (entry.kind === "file" ? 0o100000 : 0) | (entry.mode ?? 0o644) };
		}),
		realPath: vi.fn(async (target: string) => target),
		revealPath: vi.fn(),
		openPath: vi.fn(async () => ""),
		copyText: vi.fn(),
	};
	return { deps, actions: createLocalPathActions(deps) };
}

describe("resolveLocalPath", () => {
	it("expands ~ and normalizes", () => {
		expect(resolveLocalPath("~/a/../b", "/Users/me", "darwin")).toBe("/Users/me/b");
		expect(resolveLocalPath("/a//b/./c", "/Users/me", "linux")).toBe("/a/b/c");
	});
	it("rejects relative paths, URLs, NUL and non-strings", () => {
		for (const v of ["a/b", "./a", "file:///etc/passwd", "https://x/y", "ao-app://x", "/a\0b", "", "//host/share", 42, null, "~other/x"]) {
			expect(resolveLocalPath(v, "/Users/me", "darwin"), String(v)).toBeUndefined();
		}
	});
	it("accepts Windows drive paths only on win32", () => {
		expect(resolveLocalPath("C:\\Users\\me\\a.txt", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\a.txt");
		expect(resolveLocalPath("C:\\a", "/Users/me", "darwin")).toBeUndefined();
	});
});

describe("local path actions", () => {
	it("opens regular files and reveals/copies existing paths", async () => {
		const { actions, deps } = setup({ "/tmp/a.txt": { kind: "file" } });
		expect(await actions.perform("/tmp/a.txt", "open")).toEqual({ ok: true, performed: "open" });
		expect(deps.openPath).toHaveBeenCalledWith("/tmp/a.txt");
		expect(await actions.perform("/tmp/a.txt", "reveal")).toEqual({ ok: true, performed: "reveal" });
		expect(deps.revealPath).toHaveBeenCalledWith("/tmp/a.txt");
		expect(await actions.perform("/tmp/a.txt", "copy")).toEqual({ ok: true, performed: "copy" });
		expect(deps.copyText).toHaveBeenCalledWith("/tmp/a.txt");
	});
	it("copies the expanded path", async () => {
		const { actions, deps } = setup({ "/Users/me/x": { kind: "directory" } });
		await actions.perform("~/x", "copy");
		expect(deps.copyText).toHaveBeenCalledWith("/Users/me/x");
	});
	it("never opens executables; falls back to reveal", async () => {
		const { actions, deps } = setup({
			"/Applications/X.app": { kind: "directory" },
			"/tmp/run.command": { kind: "file" },
			"/tmp/run.sh": { kind: "file" },
			"/tmp/tool": { kind: "file", mode: 0o755 },
			"/tmp/setup.py": { kind: "file" },
			"/tmp/a.jnlp": { kind: "file" },
			"/tmp/a.hta": { kind: "file" },
			"/tmp/noext": { kind: "file" },
			"/tmp/script.txt": { kind: "file", mode: 0o755 },
		});
		for (const target of ["/Applications/X.app", "/tmp/run.command", "/tmp/run.sh", "/tmp/tool", "/tmp/setup.py", "/tmp/a.jnlp", "/tmp/a.hta", "/tmp/noext", "/tmp/script.txt"]) {
			expect(await actions.perform(target, "open")).toEqual({ ok: true, performed: "reveal" });
		}
		expect(deps.openPath).not.toHaveBeenCalled();
	});
	it("does not open a symlink whose target is an executable", async () => {
		const { actions, deps } = setup({ "/tmp/link.txt": { kind: "file" } });
		deps.realPath.mockResolvedValue("/tmp/evil.command");
		expect(await actions.perform("/tmp/link.txt", "open")).toEqual({ ok: true, performed: "reveal" });
	});
	it("does not open special files", async () => {
		const { actions } = setup({ "/tmp/sock": { kind: "other" } });
		expect(await actions.perform("/tmp/sock", "open")).toEqual({ ok: true, performed: "reveal" });
	});
	it("rejects missing, invalid paths and unknown actions", async () => {
		const { actions, deps } = setup({ "/tmp/a": { kind: "file" } });
		expect(await actions.perform("/tmp/missing", "reveal")).toEqual({ ok: false, reason: "not_found" });
		expect(await actions.perform("file:///tmp/a", "reveal")).toEqual({ ok: false, reason: "invalid" });
		expect(await actions.perform("/tmp/a", "exec")).toEqual({ ok: false, reason: "invalid" });
		expect(deps.revealPath).not.toHaveBeenCalled();
	});
	it("reports a failed open", async () => {
		const { actions, deps } = setup({ "/tmp/a.txt": { kind: "file" } });
		deps.openPath.mockResolvedValue("no app");
		expect(await actions.perform("/tmp/a.txt", "open")).toEqual({ ok: false, reason: "failed" });
	});
});
