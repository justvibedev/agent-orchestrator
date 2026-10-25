import {
	type QueryClient,
	useMutation,
	useMutationState,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { components } from "../../api/schema";
import { apiErrorMessage, hasTrustedApiBaseUrl } from "../lib/api-client";
import { clientForSessionHost } from "../lib/host-clients";
import { conversationQueryKey } from "./useConversation";
import { workspaceQueryKeyForHost } from "./useWorkspaceQuery";

export type SessionInterfaceTransition = components["schemas"]["SessionInterfaceTransition"];
export type SessionInterfaceTransitionStatus =
	components["schemas"]["SessionInterfaceTransitionStatusResponse"];
export type SessionInterfaceTransitionPolicy = "drain" | "interrupt";
export type SessionInterfaceTransitionHistoryPolicy = "strict" | "provider_history";
export type SessionInterfaceMode = "chat" | "tui";

type StartInterfaceTransitionInput = {
	targetMode: SessionInterfaceMode;
	policy: SessionInterfaceTransitionPolicy;
	historyPolicy?: SessionInterfaceTransitionHistoryPolicy;
	model?: string;
	reasoningEffort?: string;
};

type InterfaceTransitionMutationTarget = {
	targetSessionId: string;
	targetHostId?: string;
};

export type SessionInterfaceContext = string | null;

function mutationContext(target: InterfaceTransitionMutationTarget): SessionInterfaceContext {
	return target.targetHostId ?? null;
}

type StartInterfaceTransitionMutationInput = StartInterfaceTransitionInput & InterfaceTransitionMutationTarget;

type AcknowledgeInterfaceTransitionNoticeMutationInput =
	InterfaceTransitionMutationTarget & {
		transitionId: string;
	};

const startInterfaceTransitionMutationKey = ["start-session-interface-transition"] as const;
const cancelInterfaceTransitionMutationKey = ["cancel-session-interface-transition"] as const;
const acknowledgeInterfaceTransitionNoticeMutationKey = [
	"acknowledge-session-interface-transition-notice",
] as const;

type InterfaceTransitionMutationState<TInput> = {
	error: unknown;
	input?: TInput;
	status: "error" | "idle" | "pending" | "success";
	submittedAt: number;
};

function useInterfaceTransitionMutations<TInput>(mutationKey: readonly unknown[]) {
	return useMutationState<InterfaceTransitionMutationState<TInput>>({
		filters: { mutationKey },
		select: (mutation) => ({
			error: mutation.state.error,
			input: mutation.state.variables as TInput | undefined,
			status: mutation.state.status,
			submittedAt: mutation.state.submittedAt,
		}),
	});
}

function summarizeInterfaceTransitionMutations<
	TInput extends InterfaceTransitionMutationTarget,
>(mutations: InterfaceTransitionMutationState<TInput>[], sessionId: string | undefined, hostId?: string) {
	let latest: InterfaceTransitionMutationState<TInput> | undefined;
	let pending: InterfaceTransitionMutationState<TInput> | undefined;
	for (const mutation of mutations) {
		const input = mutation.input;
		if (!input || input.targetSessionId !== sessionId || input.targetHostId !== hostId) continue;
		if (!latest || mutation.submittedAt >= latest.submittedAt) latest = mutation;
		if (
			mutation.status === "pending" &&
			(!pending || mutation.submittedAt >= pending.submittedAt)
		) {
			pending = mutation;
		}
	}
	const errored = !pending && latest?.status === "error" ? latest : undefined;
	return {
		error: errored ? apiErrorMessage(errored.error) : undefined,
		errorAt: errored?.submittedAt,
		isPending: Boolean(pending),
		pendingInput: pending?.input,
	};
}

function clearInterfaceTransitionMutationState(
	queryClient: QueryClient,
	mutationKey: readonly unknown[],
	sessionId: string | undefined,
	hostId?: string,
) {
	if (!sessionId) return;
	const mutationCache = queryClient.getMutationCache();
	for (const mutation of mutationCache.findAll({ mutationKey })) {
		const input = mutation.state.variables as InterfaceTransitionMutationTarget | undefined;
		if (input?.targetSessionId === sessionId && input.targetHostId === hostId && mutation.state.status !== "pending") {
			mutationCache.remove(mutation);
		}
	}
}

const activePhases = new Set<SessionInterfaceTransition["phase"]>([
	"requested",
	"preflighting",
	"draining",
	"source_stopping",
	"source_stopped",
	"target_starting",
	"activating",
]);

const cancellablePhases = new Set<SessionInterfaceTransition["phase"]>([
	"requested",
	"preflighting",
	"draining",
]);

const nativeSessionReadinessPoll = 1_000;

export function interfaceTransitionIsActive(transition?: SessionInterfaceTransition): boolean {
	return Boolean(transition && activePhases.has(transition.phase));
}

export function interfaceTransitionIsCancellable(transition?: SessionInterfaceTransition): boolean {
	return Boolean(transition && cancellablePhases.has(transition.phase));
}

export function interfaceTransitionNeedsRestart(transition?: SessionInterfaceTransition): boolean {
	// The daemon retains the active fence until target shutdown is proven;
	// this is an actionable recovery state, not ongoing progress.
	return Boolean(
		transition &&
			interfaceTransitionIsActive(transition) &&
			transition.errorCode === "TARGET_STOP_UNCONFIRMED",
	);
}

export function interfaceTransitionHasUnacknowledgedNotice(
	transition?: SessionInterfaceTransition,
): boolean {
	return Boolean(
		interfaceTransitionNeedsRestart(transition) ||
			(transition &&
				!transition.noticeAcknowledgedAt &&
				(transition.phase === "failed" || transition.phase === "recovery_required")),
	);
}

export function sessionInterfaceTransitionQueryKey(sessionId: string, context?: SessionInterfaceContext) {
	if (typeof context === "string") return ["session-interface-transition", context, sessionId] as const;
	return ["session-interface-transition", sessionId] as const;
}

function useSessionInterfaceTransitionStatusQuery(
	sessionId: string | undefined,
	context?: SessionInterfaceContext,
	hasSessionContext = false,
) {
	const hostId = typeof context === "string" ? context : undefined;
	const isLocal = context === null || !hasSessionContext;
	return useQuery({
		queryKey: sessionInterfaceTransitionQueryKey(sessionId ?? "", context),
		enabled: Boolean(sessionId && (hostId || (isLocal && hasTrustedApiBaseUrl()))),
		queryFn: async () => {
			const { data, error } = await clientForSessionHost(hostId).GET(
				"/api/v1/sessions/{sessionId}/interface-transition",
				{ params: { path: { sessionId: sessionId as string } } },
			);
			if (error) throw error;
			return data as SessionInterfaceTransitionStatus;
		},
		refetchInterval: (state) => {
			const status = state.state.data;
			if (interfaceTransitionNeedsRestart(status?.transition)) return false;
			if (interfaceTransitionIsActive(status?.transition)) return 250;
			// A missing or not-yet-current native identity is transient while the
			// terminal's session-start hook is arriving, and a missing workspace
			// clears once Retry start sets it up. Recheck only those readiness
			// states so supported switches enable without polling permanently
			// unsupported harnesses or ordinary idle sessions.
			return status?.reasonCode === "NATIVE_SESSION_MISSING" ||
				status?.reasonCode === "NATIVE_SESSION_UNVERIFIED" ||
				status?.reasonCode === "WORKSPACE_UNAVAILABLE"
				? nativeSessionReadinessPoll
				: false;
		},
		retry: 1,
	});
}

export function useSessionInterfaceTransitionStatus(sessionId: string | undefined, context?: SessionInterfaceContext) {
	const query = useSessionInterfaceTransitionStatusQuery(sessionId, context, context !== undefined);
	return {
		status: query.data,
		transition: query.data?.transition,
		isLoading: query.isLoading,
		statusError: query.error ? apiErrorMessage(query.error) : undefined,
	};
}

/**
 * One bounded durable row drives every client. Polling is intentionally only
 * eager while a handoff is active; idle sessions do not create background
 * traffic and the existing session CDC stream still refreshes the committed
 * mode in the workspace model.
 */
export function useSessionInterfaceTransition(
	sessionId: string | undefined,
	// undefined: session row is still resolving; null: resolved local session.
	// This prevents unresolved tabs from probing the local daemon.
	context?: SessionInterfaceContext,
) {
	const queryClient = useQueryClient();
	const hostId = typeof context === "string" ? context : undefined;
	// Keep the two-argument call site backwards-compatible for local sessions.
	// SessionView deliberately passes `undefined` while a tab is unresolved, so
	// distinguish an omitted context from that explicit unresolved value.
	const hasSessionContext = arguments.length >= 2;
	const settledRef = useRef<string>("");
	const refreshAttemptRef = useRef(0);
	const [refreshingTransition, setRefreshingTransition] = useState<{
		attempt: number;
		key: string;
	}>();
	const query = useSessionInterfaceTransitionStatusQuery(
		sessionId,
		context,
		hasSessionContext,
	);

	const start = useMutation({
		mutationKey: startInterfaceTransitionMutationKey,
		mutationFn: async ({
			targetSessionId,
			targetHostId,
			...input
		}: StartInterfaceTransitionMutationInput) => {
			const { data, error } = await clientForSessionHost(targetHostId).POST(
				"/api/v1/sessions/{sessionId}/interface-transition",
				{
					params: { path: { sessionId: targetSessionId } },
					body: input,
				},
			);
			if (error) throw error;
			return data;
		},
		onSuccess: (response, variables) => {
			// The POST response is the durable acceptance boundary. Refreshing may
			// be a no-op for an inactive query or fail transiently, but neither case
			// may turn an accepted handoff back into an available Chat composer.
			if (response?.transition) {
				queryClient.setQueryData<SessionInterfaceTransitionStatus>(
					sessionInterfaceTransitionQueryKey(variables.targetSessionId, mutationContext(variables)),
					{
						supported: true,
						targetMode: response.transition.targetMode,
						transition: response.transition,
					},
				);
			}
			const refreshes = [
				queryClient.invalidateQueries({
					queryKey: sessionInterfaceTransitionQueryKey(variables.targetSessionId, mutationContext(variables)),
				}),
			];
			return Promise.all(refreshes).catch(() => undefined);
		},
	});

	const cancel = useMutation({
		mutationKey: cancelInterfaceTransitionMutationKey,
		mutationFn: async ({ targetSessionId, targetHostId }: InterfaceTransitionMutationTarget) => {
			const { error } = await clientForSessionHost(targetHostId).DELETE(
				"/api/v1/sessions/{sessionId}/interface-transition",
				{ params: { path: { sessionId: targetSessionId } } },
			);
			if (error) throw error;
			return undefined;
		},
		onSuccess: (_data, variables) => {
			void queryClient.invalidateQueries({
				queryKey: sessionInterfaceTransitionQueryKey(variables.targetSessionId, mutationContext(variables)),
			});
		},
	});

	const acknowledgeNotice = useMutation({
		mutationKey: acknowledgeInterfaceTransitionNoticeMutationKey,
		mutationFn: async ({
			targetSessionId,
			targetHostId,
			transitionId,
		}: AcknowledgeInterfaceTransitionNoticeMutationInput) => {
			const { data, error } = await clientForSessionHost(targetHostId).PUT(
				"/api/v1/sessions/{sessionId}/interface-transition/{transitionId}/notice-acknowledgement",
				{
					params: {
						path: { sessionId: targetSessionId, transitionId },
					},
				},
			);
			if (error) throw error;
			return data;
		},
		onSuccess: (response, variables) => {
			if (!response) return;
			const localResponse = response as unknown as { transition: SessionInterfaceTransition };
			queryClient.setQueryData<SessionInterfaceTransitionStatus>(
				sessionInterfaceTransitionQueryKey(variables.targetSessionId, mutationContext(variables)),
				(current) =>
					current?.transition?.id === localResponse.transition.id
						? { ...current, transition: localResponse.transition }
						: current,
			);
		},
		onSettled: (_data, _error, variables) => {
			void queryClient.invalidateQueries({
				queryKey: sessionInterfaceTransitionQueryKey(variables.targetSessionId, mutationContext(variables)),
			});
		},
	});
	const startState = summarizeInterfaceTransitionMutations(
		useInterfaceTransitionMutations<StartInterfaceTransitionMutationInput>(
			startInterfaceTransitionMutationKey,
		),
		sessionId,
		hostId,
	);
	const cancelState = summarizeInterfaceTransitionMutations(
		useInterfaceTransitionMutations<InterfaceTransitionMutationTarget>(
			cancelInterfaceTransitionMutationKey,
		),
		sessionId,
		hostId,
	);
	const acknowledgeNoticeState = summarizeInterfaceTransitionMutations(
		useInterfaceTransitionMutations<AcknowledgeInterfaceTransitionNoticeMutationInput>(
			acknowledgeInterfaceTransitionNoticeMutationKey,
		),
		sessionId,
		hostId,
	);

	const transition = query.data?.transition;
	const transitionActive = interfaceTransitionIsActive(transition);
	const transitionID = transition?.id;
	const transitionKey =
		sessionId && transitionID ? JSON.stringify([hostId, sessionId, transitionID]) : "";
	// A completed handoff is not visually settled until the queries invalidated by
	// it have returned. In particular, switching TUI -> Chat necessarily has a
	// small interval after mode=chat commits and before the Chat controller is in
	// the registry. A snapshot fetched in that interval truthfully says "stopped",
	// but rendering it as a controller failure is a lie: the transition worker is
	// still starting the target. Keep that state distinct through the final refetch.
	const settling = Boolean(
		transitionKey &&
			!transitionActive &&
			(settledRef.current !== transitionKey ||
				refreshingTransition?.key === transitionKey),
	);
	useEffect(() => {
		if (!sessionId || !transitionKey || transitionActive) return;
		if (settledRef.current === transitionKey) return;
		settledRef.current = transitionKey;
		const attempt = ++refreshAttemptRef.current;
		setRefreshingTransition({ attempt, key: transitionKey });
		const refreshes = [
			queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(hostId) }),
			queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId, hostId) }),
		];
		void Promise.all(refreshes).finally(() => {
			setRefreshingTransition((refreshing) =>
				refreshing?.key === transitionKey && refreshing.attempt === attempt
					? undefined
					: refreshing,
			);
		});
	}, [queryClient, sessionId, hostId, transitionActive, transitionKey]);
	// A local start refusal records a durable-free error. If any client then opens
	// a real transition, that newer durable row supersedes the stale refusal: the
	// switch is running or done, so the "could not switch" notice must not linger.
	const transitionCreatedAt = transition ? Date.parse(transition.createdAt) : NaN;
	const startErrorSuperseded = Boolean(
		startState.errorAt !== undefined &&
			Number.isFinite(transitionCreatedAt) &&
			transitionCreatedAt > startState.errorAt,
	);
	useEffect(() => {
		if (!startErrorSuperseded) return;
		clearInterfaceTransitionMutationState(
			queryClient,
			startInterfaceTransitionMutationKey,
			sessionId,
			hostId,
		);
	}, [queryClient, sessionId, hostId, startErrorSuperseded]);

	const refreshStatus = useCallback(
		async (): Promise<SessionInterfaceTransitionStatus | undefined> => {
			const refreshed = await query.refetch();
			if (refreshed.error) throw refreshed.error;
			return refreshed.data;
		},
		[query.refetch],
	);

	return {
		status: query.data,
		transition,
		refreshStatus,
		settling,
		isLoading: query.isLoading,
		statusError: query.error ? apiErrorMessage(query.error) : undefined,
		start: (input: StartInterfaceTransitionInput) => {
			if (!sessionId) return Promise.reject(new Error("No session is selected."));
			return start.mutateAsync({ ...input, targetSessionId: sessionId, targetHostId: hostId });
		},
		starting: startState.isPending,
		startingPolicy: startState.pendingInput?.policy,
		startingTarget: startState.pendingInput?.targetMode,
		startError: startErrorSuperseded ? undefined : startState.error,
		resetStartError: () => {
			clearInterfaceTransitionMutationState(
				queryClient,
				startInterfaceTransitionMutationKey,
				sessionId,
				hostId,
			);
		},
		cancel: () => {
			if (!sessionId) return Promise.reject(new Error("No session is selected."));
			return cancel.mutateAsync({ targetSessionId: sessionId, targetHostId: hostId });
		},
		cancelling: cancelState.isPending,
		cancelError: cancelState.error,
		acknowledgeNotice: (transitionId: string) => {
			if (!sessionId) return Promise.reject(new Error("No session is selected."));
			return acknowledgeNotice.mutateAsync({ targetSessionId: sessionId, targetHostId: hostId, transitionId });
		},
		acknowledgingNotice: acknowledgeNoticeState.isPending,
		acknowledgeNoticeError: acknowledgeNoticeState.error,
	};
}
