import { create } from "zustand";

// Per-session terminal relaunch nonce.
//
// A terminal is otherwise keyed only on its (unchanged) session id and handle,
// so a relaunch behind the same handle (the controller generation moving between
// two known values) needs an explicit signal or the pane keeps its cached entry
// and clings to the dead attachment. `advanceEpoch` bumps the nonce, which is
// part of the terminal cache key, so the pane rebuilds from scratch.
//
// Not persisted: it only matters while a terminal is mounted.
type TerminalResetState = {
	nonces: Record<string, number>;
	advanceEpoch: (sessionId: string) => void;
};

export const useTerminalResetStore = create<TerminalResetState>((set) => ({
	nonces: {},
	advanceEpoch: (sessionId) =>
		set((state) => ({
			nonces: { ...state.nonces, [sessionId]: (state.nonces[sessionId] ?? 0) + 1 },
		})),
}));

/**
 * Reads a session's current relaunch nonce without a React subscription, for
 * hook-free callers (e.g. deriving a cache key inside a memo). Returns 0 when
 * the session has never been relaunched.
 */
export function terminalResetNonce(sessionId?: string): number {
	if (!sessionId) return 0;
	return useTerminalResetStore.getState().nonces[sessionId] ?? 0;
}
