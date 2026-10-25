import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_SHELL_TERMINAL_SHORTCUT_CHANNEL, APP_SHORTCUT_CHANNEL, KEYBOARD_SHORTCUTS_HELP_CHANNEL, NEXT_SESSION_SHORTCUT_CHANNEL, NEXT_TAB_SHORTCUT_CHANNEL, NEW_SESSION_SHORTCUT_CHANNEL, NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, OPEN_SETTINGS_SHORTCUT_CHANNEL, PREVIOUS_SESSION_SHORTCUT_CHANNEL, PREVIOUS_TAB_SHORTCUT_CHANNEL, SET_CLOSE_SHELL_TERMINAL_SHORTCUT_ENABLED_CHANNEL } from "./shared/shortcuts";
import { SET_CHAT_DRAFT_RISK_CHANNEL } from "./shared/chat-draft-risk";
import type { AoBridge } from "./preload";

const electronMocks = vi.hoisted(() => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		exposeInMainWorld: vi.fn(),
		getPathForFile: vi.fn(),
		invoke: vi.fn(),
		listeners,
		off: vi.fn(),
		on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
			listeners.set(channel, listener);
		}),
		send: vi.fn(),
	};
});

vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
	ipcRenderer: {
		invoke: electronMocks.invoke,
		off: electronMocks.off,
		on: electronMocks.on,
		send: electronMocks.send,
	},
	webUtils: { getPathForFile: electronMocks.getPathForFile },
}));

await import("./preload");

// Captured once, before any test's beforeEach clears the listeners map: this
// is the always-on buffering listener preload.ts registers at module load,
// not the per-call listener onOpenFolderPath registers when invoked.
const openFolderPathBufferListener = electronMocks.listeners.get("app:openFolderPath");

function exposedBridge(): AoBridge {
	const call = electronMocks.exposeInMainWorld.mock.calls.find(([key]) => key === "ao");
	if (!call) throw new Error("preload bridge was not exposed");
	return call[1] as AoBridge;
}

beforeEach(() => {
	electronMocks.listeners.clear();
	electronMocks.getPathForFile.mockClear();
	electronMocks.invoke.mockClear();
	electronMocks.off.mockClear();
	electronMocks.on.mockClear();
	electronMocks.send.mockClear();
});

describe("preload getPathForFile bridge", () => {
	it("forwards the File to webUtils.getPathForFile without going through IPC", () => {
		electronMocks.getPathForFile.mockReturnValue("/Users/x/dropped-folder");
		const file = new File([], "dropped-folder");

		const path = exposedBridge().app.getPathForFile(file);

		expect(path).toBe("/Users/x/dropped-folder");
		expect(electronMocks.getPathForFile).toHaveBeenCalledWith(file);
		expect(electronMocks.invoke).not.toHaveBeenCalled();
	});
});

describe("preload repository branch bridge", () => {
	it("invokes the main-process branch probe over IPC", async () => {
		electronMocks.invoke.mockResolvedValueOnce("main");

		await expect(exposedBridge().app.getRepositoryBranch("/repo/project")).resolves.toBe("main");

		expect(electronMocks.invoke).toHaveBeenCalledWith("app:getRepositoryBranch", "/repo/project");
	});
});

describe("preload Developer Mode updater bridge", () => {
	it("sends only the updater eligibility boolean to the main process", async () => {
		await exposedBridge().updateSettings.setMacDifferentialUpdates(true);

		expect(electronMocks.invoke).toHaveBeenCalledWith(
			"updateSettings:setMacDifferentialUpdates",
			true,
		);
	});
});
