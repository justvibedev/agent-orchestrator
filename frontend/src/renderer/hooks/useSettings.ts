/**
 * Daemon-owned user preferences.
 *
 * Read from and written to the daemon rather than held in the renderer, because
 * `ao spawn`, mobile, and headless spawns resolve the same value. A preference
 * kept in one client would look correct in Settings and disagree with the others.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { clientForHost } from "../lib/host-clients";
import type { SessionMode } from "../types/workspace";

/** `disabledModels` lists the models pickers leave out; empty or unset means every catalog model. */
export type HarnessDefault = Pick<components["schemas"]["HarnessDefault"], "disabledModels">;

export const settingsQueryKey = ["settings"] as const;

export interface Settings {
	harnessDefaults?: Record<string, HarnessDefault>;
	/** Applies to sessions created from now on; never to an existing one. */
	defaultSessionMode: SessionMode;
	/** Agents that can run in chat mode today. Empty means chat is unavailable. */
	chatHarnesses: string[];
	/** Deployment client identity (AO_CLIENT); empty when unset. */
	client: string;
	/** Whether the local offering is available on this daemon. */
	localEnabled: boolean;
	/** Whether the daemon's AO_TRACKER_INTAKE gate is on. Off hides intake controls. */
	trackerIntakeEnabled: boolean;
	/** Idle open sessions move to a harness release installed while they ran. */
	versionRefresh?: boolean;
}

export function useSettings(hostId?: string, enabled = true) {
	const query = useQuery({
		queryKey: hostId ? ["settings", hostId] : settingsQueryKey,
		enabled,
		// This query must recover from a transient startup failure: the daemon
		// can still be booting on first fetch ("AO daemon is starting"). Poll
		// like the workspace query so it self-heals once the daemon is ready.
		refetchInterval: 15_000,
		retry: 5,
		queryFn: async (): Promise<Settings> => {
			const { data, error } = await (hostId ? clientForHost(hostId) : apiClient).GET("/api/v1/settings");
			if (error) throw error;
			return {
				defaultSessionMode: (data?.defaultSessionMode ?? "tui") as SessionMode,
				harnessDefaults: data?.harnessDefaults ?? {},
				chatHarnesses: data?.chatHarnesses ?? [],
				client: data?.client ?? "",
				// A daemon that predates the gate behaves like a plain local install.
				localEnabled: data?.localEnabled ?? true,
				trackerIntakeEnabled: data?.trackerIntakeEnabled ?? false,
				// A daemon that predates the setting never moves sessions.
				versionRefresh: data?.versionRefresh ?? false,
			};
		},
	});

	return {
		settings: query.data,
		isLoading: query.isLoading,
		error: query.error ? apiErrorMessage(query.error) : undefined,
	};
}

export function useUpdateSessionInterface() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: async (mode: SessionMode) => {
			const { data, error } = await apiClient.PATCH("/api/v1/settings/session-interface", {
				body: { defaultSessionMode: mode },
			});
			if (error) throw error;
			return data;
		},
		// Refetch rather than writing the value in locally: the daemon is the source
		// of truth, and the control must not claim a change it did not persist.
		onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
	});

	return {
		update: (mode: SessionMode) => mutation.mutate(mode),
		saving: mutation.isPending,
		error: mutation.error ? apiErrorMessage(mutation.error) : undefined,
	};
}

/** Saves which models one harness offers without replacing other harnesses' entries. */
export function useUpdateHarnessDefault(hostId?: string) {
	const queryClient = useQueryClient();
	const key = hostId ? ["settings", hostId] : settingsQueryKey;
	const mutation = useMutation({
		mutationFn: async ({ agentId, disabledModels }: { agentId: string; disabledModels: string[] }) => {
			const { data, error } = await (hostId ? clientForHost(hostId) : apiClient).PATCH("/api/v1/settings/harness-defaults/{agent}", {
				params: { path: { agent: agentId } }, body: { disabledModels },
			});
			if (error) throw error;
			return data;
		},
		onSuccess: async (data) => {
			queryClient.setQueryData<Settings>(key, (current) => current ? { ...current, harnessDefaults: data?.harnessDefaults ?? {} } : current);
			await queryClient.invalidateQueries({ queryKey: key, exact: true });
		},
	});
	return { update: mutation.mutateAsync, error: mutation.error ? apiErrorMessage(mutation.error) : undefined };
}

export function useUpdateVersionRefresh() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: async (enabled: boolean) => {
			const { data, error } = await apiClient.PATCH("/api/v1/settings/version-refresh", {
				body: { enabled },
			});
			if (error) throw error;
			return data;
		},
		// Refetch rather than writing the value in locally: the daemon is the source
		// of truth, and the control must not claim a change it did not persist.
		onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
	});

	return {
		update: (enabled: boolean) => mutation.mutate(enabled),
		saving: mutation.isPending,
		error: mutation.error ? apiErrorMessage(mutation.error) : undefined,
	};
}
