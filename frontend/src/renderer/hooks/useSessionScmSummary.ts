import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient } from "../lib/api-client";
import { clientForHost } from "../lib/host-clients";
import { LOCAL_HOST } from "../lib/hosts";

export type SessionPRSummary = components["schemas"]["SessionPRSummary"];
export type SessionPRReference = components["schemas"]["SessionPRReference"];

export const sessionScmSummaryQueryKey = (sessionId?: string, hostId?: string) =>
	sessionId ? (["session-scm-summary", hostId ?? LOCAL_HOST, sessionId] as const) : (["session-scm-summary"] as const);

export async function fetchSessionScmSummary(sessionId: string, hostId?: string) {
	const { data, error } = await (hostId ? clientForHost(hostId) : apiClient).GET("/api/v1/sessions/{sessionId}/pr", {
		params: { path: { sessionId } },
	});
	if (error) throw error;
	return { prs: data?.prs ?? [], linkedPrs: data?.linkedPrs ?? [] };
}

export function sessionScmSummaryQueryOptions(sessionId: string, hostId?: string) {
	return {
		queryKey: sessionScmSummaryQueryKey(sessionId, hostId),
		enabled: Boolean(sessionId),
		queryFn: () => fetchSessionScmSummary(sessionId, hostId),
		retry: 1,
		...(hostId ? { refetchInterval: 15_000 } : {}),
	};
}

export function useSessionScmSummary(sessionId?: string, enabled = true, hostId?: string) {
	return useQuery({
		queryKey: sessionScmSummaryQueryKey(sessionId, hostId),
		enabled: enabled && Boolean(sessionId),
		queryFn: () => fetchSessionScmSummary(sessionId!, hostId),
		retry: 1,
		...(hostId ? { refetchInterval: 15_000 } : {}),
	});
}
