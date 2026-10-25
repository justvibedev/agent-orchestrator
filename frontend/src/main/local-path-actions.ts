import path from "node:path";
import type { Stats } from "node:fs";
import type { LocalPathAction, LocalPathInspection, LocalPathResult } from "../shared/local-path";

const MAX_PATH_LENGTH = 4096;
// Runnable or installable on a double click: Open falls back to Reveal for these.
const EXECUTABLE_EXTENSIONS = new Set([
	".app", ".command", ".sh", ".bash", ".zsh", ".fish", ".tool", ".workflow", ".action", ".scpt", ".scptd",
	".pkg", ".mpkg", ".dmg", ".exe", ".msi", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".lnk",
	".jar", ".desktop", ".appimage", ".terminal", ".webloc", ".url", ".inetloc", ".prefpane", ".saver",
]);

export type LocalPathActionsDeps = {
	platform: NodeJS.Platform;
	homeDir: string;
	stat: (target: string) => Promise<Pick<Stats, "isFile" | "isDirectory" | "mode">>;
	realPath: (target: string) => Promise<string>;
	revealPath: (target: string) => void;
	openPath: (target: string) => Promise<string>;
	copyText: (text: string) => void;
};

/** Absolute, normalized path for renderer-supplied text, or undefined when it is not a plain local path. */
export function resolveLocalPath(input: unknown, homeDir: string, platform: NodeJS.Platform): string | undefined {
	if (typeof input !== "string" || input.length === 0 || input.length > MAX_PATH_LENGTH) return undefined;
	if (/[\0\r\n]/.test(input)) return undefined;
	// Two or more letters before ":" is a URL scheme; a single letter is a Windows drive.
	if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(input)) return undefined;
	const api = platform === "win32" ? path.win32 : path.posix;
	let expanded = input;
	if (input === "~" || input.startsWith("~/") || (platform === "win32" && input.startsWith("~\\"))) {
		expanded = api.join(homeDir, input.slice(1));
	}
	if (!api.isAbsolute(expanded)) return undefined;
	if (platform !== "win32" && expanded.startsWith("//")) return undefined;
	return api.normalize(expanded);
}

export function isExecutableLocalPath(target: string, mode: number, platform: NodeJS.Platform): boolean {
	const api = platform === "win32" ? path.win32 : path.posix;
	if (EXECUTABLE_EXTENSIONS.has(api.extname(target).toLowerCase())) return true;
	return platform !== "win32" && (mode & 0o111) !== 0 && (mode & 0o170000) === 0o100000;
}

export function createLocalPathActions(deps: LocalPathActionsDeps) {
	async function inspect(input: unknown): Promise<LocalPathInspection> {
		const resolved = resolveLocalPath(input, deps.homeDir, deps.platform);
		if (!resolved) return { ok: false, reason: "invalid" };
		const info = await deps.stat(resolved).catch(() => undefined);
		if (!info) return { ok: false, reason: "not_found" };
		const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
		// Sockets, devices and FIFOs can be revealed and copied but never opened.
		const real = kind ? await deps.realPath(resolved).catch(() => undefined) : undefined;
		const canOpen = Boolean(kind && real && !isExecutableLocalPath(resolved, info.mode, deps.platform) && !isExecutableLocalPath(real, info.mode, deps.platform));
		return { ok: true, path: resolved, kind: kind ?? "file", canOpen };
	}

	async function perform(input: unknown, action: unknown): Promise<LocalPathResult> {
		if (action !== "reveal" && action !== "open" && action !== "copy") return { ok: false, reason: "invalid" };
		const target = await inspect(typeof input === "object" && input !== null ? (input as { path?: unknown }).path : input);
		if (!target.ok) return target;
		try {
			if (action === "copy") {
				deps.copyText(target.path);
				return { ok: true, performed: "copy" };
			}
			if (action === "open" && target.canOpen) {
				const error = await deps.openPath(target.path);
				if (error) return { ok: false, reason: "failed" };
				return { ok: true, performed: "open" };
			}
			deps.revealPath(target.path);
			return { ok: true, performed: "reveal" };
		} catch {
			return { ok: false, reason: "failed" };
		}
	}

	return { inspect, perform };
}
