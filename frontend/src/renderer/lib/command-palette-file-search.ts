import { sessionWorkspaceSearchQueryOptions } from "../hooks/useSessionWorkspaceFiles";
import type { WorkspaceFileSearchItem, WorkspaceFileSearchTarget } from "./command-palette";

export const COMMAND_PALETTE_FILE_SEARCH_LIMIT = 20;

export type CommandPaletteFileSearchResponse = {
	results: WorkspaceFileSearchItem[];
	truncated: boolean;
};

type CommandPaletteFileSearchArgs = {
	target: WorkspaceFileSearchTarget;
	query: string;
	errorMessage: string;
};

type CommandPaletteFileSearchQueryOptions = {
	queryKey: readonly unknown[];
	queryFn: (context?: { signal?: AbortSignal }) => Promise<CommandPaletteFileSearchResponse>;
	retry?: (failureCount: number, error: Error) => boolean;
};

function normalizeSearchResponse(response: {
	results: Array<{ path: string; status?: string; binary?: boolean }>;
	truncated: boolean;
}): CommandPaletteFileSearchResponse {
	return {
		results: response.results.map((result) => ({
			path: result.path,
			...(result.status ? { status: result.status } : {}),
			...(result.binary !== undefined ? { binary: result.binary } : {}),
		})),
		truncated: response.truncated,
	};
}

export function commandPaletteFileSearchQueryOptions(
	args: CommandPaletteFileSearchArgs,
): CommandPaletteFileSearchQueryOptions {
	const { target } = args;
	const options = sessionWorkspaceSearchQueryOptions(
		target.sessionId,
		args.query,
		args.errorMessage,
		target.hostId,
		COMMAND_PALETTE_FILE_SEARCH_LIMIT,
	);
	return {
		...options,
		queryFn: async (context: { signal?: AbortSignal } = {}) =>
			normalizeSearchResponse(await options.queryFn(context)),
	};
}
