import { beforeEach, describe, expect, it, vi } from "vitest";
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
