import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IncompatibleRemoteVersionError, probeRemote, readRemoteIdentity, type RemoteHealth } from "./remote-request";
import { findRemote, removeSavedRemote, toHostViews, updateSavedRemote } from "./remotes-ipc";
import type { RemoteRegistry } from "./remote-registry";
import { addRemote, readRemotes, type RemoteChanges, type RemoteEntry } from "./remotes-store";

// An isolated desktop run must not read or write the real user's credentials.
// Without an override, keep the existing ~/.ao location.
export function remotesFilePath(): string {
	return path.join(process.env.AO_DATA_DIR?.trim() || path.join(os.homedir(), ".ao"), "remotes.json");
}

type RunFile = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

/** The name other devices list this machine under: macOS's Computer Name
 * ("Dhruv’s Mac mini"), else the host name without its mDNS suffix. */
export async function computerName(
	run: RunFile = promisify(execFile),
	platform: NodeJS.Platform = process.platform,
	hostname: () => string = os.hostname,
): Promise<string> {
	if (platform === "darwin") {
		try {
			const name = (await run("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 })).stdout.trim();
			if (name) return name;
		} catch {
			// No Computer Name set; the host name still identifies the machine.
		}
	}
	return hostname().replace(/\.local$/i, "");
}

// The slice of Electron's ipcMain these handlers need, so tests need no Electron.
type IpcMainLike = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the listener
	// args must unify Electron's IpcMain (any[]) with a test fake (unknown[]),
	// and `never[]` rejects both; `any[]` here leaks nowhere past registration.
	handle(channel: string, listener: (event: unknown, ...args: any[]) => Promise<unknown>): void;
};

export type RemotesIpcDeps = {
	file: string;
	registry: RemoteRegistry;
	localIdentity: () => Promise<string | null>;
	probe?: (entry: RemoteEntry) => Promise<RemoteHealth>;
	identity?: (entry: Pick<RemoteEntry, "url">) => Promise<string>;
};

class LocalIdentityUnavailableError extends Error {
	constructor() { super("Local AO identity is unavailable; remote connection is offline"); }
}

/**
 * Saved AO daemons, shared with the CLI's ~/.ao/remotes.json. Everything the
 * renderer receives back is password-free (see remotes-ipc.ts); the plaintext
 * password only travels renderer -> main when adding or editing a credential.
 */
export function registerRemotesIpc(
	ipcMain: IpcMainLike,
	{ file, registry, localIdentity, probe = probeRemote, identity = readRemoteIdentity }: RemotesIpcDeps,
): void {
	const disconnect = (url: string) => registry.disconnect(url);
	const refuseSelf = (hostId: string | undefined, localHostId: string | null) => {
		if (localHostId && hostId === localHostId) throw new Error("This AO installation is already available locally; a remote connection to itself is not allowed.");
	};
	const requireLocalIdentity = async () => {
		const hostId = await localIdentity();
		if (!hostId) throw new LocalIdentityUnavailableError();
		return hostId;
	};
	const checkConnectionContext = async (localHostId: string) => {
		const currentLocalHostId = await localIdentity();
		if (!currentLocalHostId) throw new LocalIdentityUnavailableError();
		if (currentLocalHostId !== localHostId) throw new Error("Local AO identity changed; remote connection is offline");
	};
	const checkedProbe = async (entry: RemoteEntry): Promise<RemoteHealth> => {
		if (!entry.hostId) throw new Error("remote host must be paired again to record its identity");
		const localHostId = await requireLocalIdentity();
		refuseSelf(entry.hostId, localHostId);
		let actual: string;
		try {
			actual = await identity(entry);
		} catch (error) {
			if (error instanceof IncompatibleRemoteVersionError) return "incompatible";
			return "offline";
		}
		refuseSelf(actual, localHostId);
		if (actual !== entry.hostId) throw new Error(`remote host identity changed for ${entry.url}; connection refused`);
		await checkConnectionContext(localHostId);
		const health = await probe(entry);
		await checkConnectionContext(localHostId);
		return health;
	};
	// Keep edits and connects ordered so an update cannot leave a stale proxy.
	// ponytail: one queue includes network probes; split by host if five-host setup is too slow.
	let pending: Promise<void> = Promise.resolve();
	const ordered = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = pending.then(operation, operation);
		pending = result.then(() => undefined, () => undefined);
		return result;
	};
	ipcMain.handle("remotes:list", () => ordered(async () => {
		const localHostId = await localIdentity();
		const entries = await readRemotes(file);
		return toHostViews(entries.filter((entry) => !localHostId || entry.hostId !== localHostId));
	}));
	ipcMain.handle("remotes:add", async (_event, input: RemoteEntry) => ordered(async () => {
		const localHostId = await requireLocalIdentity();
		refuseSelf(input.hostId, localHostId);
		// Probe before saving: a host that never answered is worse than no host,
		// because it looks configured.
		let hostId: string;
		try {
			hostId = await identity(input);
		} catch (error) {
			if (error instanceof IncompatibleRemoteVersionError) return "incompatible" as RemoteHealth;
			return "offline" as RemoteHealth;
		}
		refuseSelf(hostId, localHostId);
		const entry = { label: input.label, url: input.url, password: input.password, hostId };
		const health = await checkedProbe(entry);
		if (health === "online") {
			const previous = (await readRemotes(file)).find((saved) => saved.hostId === hostId);
			await addRemote(file, entry);
			if (previous && previous.url !== entry.url) await disconnect(previous.url);
			await disconnect(entry.url);
		}
		return health;
	}));
	ipcMain.handle("remotes:update", async (_event, url: string, changes: RemoteChanges) => ordered(async () => {
		return updateSavedRemote(file, url, changes, disconnect, checkedProbe);
	}));
	ipcMain.handle("remotes:remove", async (_event, url: string) => ordered(async () => {
		return removeSavedRemote(file, url, disconnect);
	}));
	ipcMain.handle("remotes:connect", async (_event, url: string, hostId?: string) => ordered(async () => {
		const entry = await findRemote(file, url, hostId);
		const localHostId = await localIdentity();
		refuseSelf(entry.hostId, localHostId);
		// A local restart must not retire an already verified, unchanged remote proxy.
		if (!localHostId) {
			const connected = registry.connected(entry);
			if (connected) return connected;
			throw new LocalIdentityUnavailableError();
		}
		let health: RemoteHealth;
		try { health = await checkedProbe(entry); }
		catch (error) {
			const connected = registry.connected(entry);
			if (error instanceof LocalIdentityUnavailableError && connected) return connected;
			throw error;
		}
		if (health !== "online") throw new Error(`host ${url} is ${health}`);
		return registry.connect(entry);
	}));
	ipcMain.handle("remotes:disconnect", async (_event, url: string) => ordered(() => disconnect(url)));
	ipcMain.handle("remotes:computerName", () => computerName());
	ipcMain.handle("remotes:previewUrl", async (_event, hostId: string, sessionId: string, sourceUrl: string) => {
		refuseSelf(hostId, await localIdentity());
		return registry.previewUrl(hostId, sessionId, sourceUrl);
	});
	ipcMain.handle("remotes:agentBrowserUrl", async (_event, hostId: string, sessionId: string) => {
		return registry.agentBrowserUrl(hostId, sessionId);
	});
	ipcMain.handle("remotes:resolvePreviewUrl", async (_event, hostId: string, sessionId: string, viewedUrl: string) => {
		refuseSelf(hostId, await localIdentity());
		return registry.resolvePreviewUrl(hostId, sessionId, viewedUrl);
	});
	ipcMain.handle("remotes:externalUrl", async (_event, hostId: string, url: string) => {
		refuseSelf(hostId, await localIdentity());
		return registry.externalUrl(hostId, url);
	});
}
