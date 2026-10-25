import { useQueries, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import type { TraySessionEntry } from "../../shared/tray";
import { useEffect, useMemo
} from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, hasTrustedApiBaseUrl } from "../lib/api-client";
import { mockWorkspaces } from "../lib/mock-data";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { toReviewerHarnessId } from "../lib/reviewer-harnesses";
import { aoBridge } from "../lib/bridge";
import { clientForHost } from "../lib/host-clients";
import { useConnectedHosts } from "./useHostConnection";
import { requestRemoteHostsRefresh } from "./useRemoteHosts";
import { applyOptimisticSessionKills } from "./optimistic-session-kills";
import { appI18n } from "../i18n";
import {
	type PRState,
	type PullRequestFacts,
	type SessionArtifact,
	toAgentProvider,
	toKanbanColumn,
	toProjectKind,
	toSessionActivity,
	toSessionStatus,
	newestActiveOrchestrator,
	attentionZone,
	workerSessions,
	type WorkspaceSession,
	type WorkspaceSummary,
	STANDALONE_PROJECT_KIND,
	STANDALONE_WORKSPACE_ID,
} from "../types/workspace";

function standaloneWorkspaceName(): string {
	return appI18n.t("standalone.workspaceName");
}

function placeStandaloneWorkspaceLast(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
	const standalone = workspaces.find((workspace) => workspace.id === STANDALONE_WORKSPACE_ID);
	if (!standalone) return workspaces;
	return [...workspaces.filter((workspace) => workspace.id !== STANDALONE_WORKSPACE_ID), standalone];
}

function toPullRequestFacts(pr: components["schemas"]["SessionPRFacts"]): PullRequestFacts {
	return {
		url: pr.url,
		number: pr.number,
		state: pr.state as PRState,
		ci: pr.ci,
		review: pr.review,
		mergeability: pr.mergeability,
		reviewComments: pr.reviewComments,
		updatedAt: pr.updatedAt,
	};
}

function toSessionArtifact(artifact: components["schemas"]["SessionArtifact"]): SessionArtifact {
	return {
		kind: artifact.kind,
		name: artifact.name,
		path: artifact.path,
		previewUrl: artifact.previewUrl,
		rawUrl: artifact.rawUrl,
		inlineUrl: artifact.inlineUrl,
		size: artifact.size,
		updatedAt: artifact.updatedAt,
	};
}

export function toWorkspaceSession(
	session: components["schemas"]["ControllersSessionView"],
	project: Pick<WorkspaceSummary, "id" | "name">,
): WorkspaceSession {
	const statusReadiness = session.statusReadiness ?? "ready";
	const status = statusReadiness === "ready" ? toSessionStatus(session.status, session.isTerminated) : "unknown";
	const scmStatus = session.scmStatus ? toSessionStatus(session.scmStatus) : undefined;
	const kanbanColumn = toKanbanColumn(session.kanbanColumn, status);
	const activity = statusReadiness === "ready" ? toSessionActivity(session.activity) : undefined;
	if (statusReadiness === "ready" && status === "unknown") reportUnknownSessionField("status", session.status);
	if (statusReadiness === "ready" && (!activity || activity.state === "unknown")) {
		reportUnknownSessionField("activity", session.activity?.state);
	}
	return {
		id: session.id,
		terminalHandleId: session.terminalHandleId,
		terminalGeneration: session.terminalGeneration,
		workspaceId: project.id,
		workspaceName: project.name,
		title: session.displayName ?? session.issueId ?? session.id,
		issueId: session.issueId,
		provider: toAgentProvider(session.harness),
		reviewerHarness: toReviewerHarnessId(session.reviewerHarness),
		reviewerConfig: session.reviewerConfig
			? {
					model: session.reviewerConfig.model ?? undefined,
					mode: session.reviewerConfig.mode ?? undefined,
					permissions: session.reviewerConfig.permissions ?? undefined,
				}
			: undefined,
		autoReviewEnabled: session.autoReviewEnabled ?? false,
		kind: session.kind === "orchestrator" ? "orchestrator" : session.kind === "worker" ? "worker" : undefined,
		mode: session.mode === "chat" ? "chat" : "tui",
		branch: session.branch || undefined,
		status,
		scmStatus,
		kanbanColumn,
		displayStatus: session.displayStatus || undefined,
		statusReadiness,
		provisionState: session.provisionState,
		provisionError: session.provisionError || undefined,
		provisionSteps: session.provisionSteps?.map((step) => ({
			id: step.id,
			status: step.status,
			startedAt: step.startedAt ?? undefined,
			endedAt: step.endedAt ?? undefined,
		})),
		branchState: session.branchState,
		branchNaming: session.branchNaming,
		staleBinary: session.staleBinary ? { version: session.staleBinary.version, since: session.staleBinary.since, switchFailedAt: session.staleBinary.switchFailedAt ?? undefined } : undefined,
		isTerminated: session.isTerminated,
		workspaceCleanup: session.workspaceCleanup,
		chatProviderPreserved: session.chatProviderPreserved,
		terminateOnPrMerge: session.terminateOnPrMerge ?? false,
		autoInjectReview: session.autoInjectReview ?? true,
		autoInjectCI: session.autoInjectCI ?? true,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		lastUserMessageAt: session.lastUserMessageAt ?? undefined,
		lastInteractionAt: session.lastInteractionAt ?? undefined,
		activity,
		previewUrl: session.previewUrl,
		previewRevision: session.previewRevision,
		isPinned: session.isPinned ?? false,
		pinnedAt: session.pinnedAt ?? undefined,
		prs: (session.prs ?? []).map(toPullRequestFacts),
		outputType: session.outputType,
		...(session.requestedOutput ? { requestedOutput: session.requestedOutput } : {}),
		artifactFiles: session.artifactFiles?.map(toSessionArtifact),
	};
}

export const workspaceQueryKey = ["workspaces"] as const;
export const remoteWorkspaceQueryKey = (hostId: string) => ["remote-workspaces", hostId] as const;
export const workspaceQueryKeyForHost = (hostId?: string) => hostId ? remoteWorkspaceQueryKey(hostId) : workspaceQueryKey;
const remoteProjectsQueryKey = (hostId: string) => [...remoteWorkspaceQueryKey(hostId), "projects"] as const;
const remoteSessionsQueryKey = (hostId: string) => [...remoteWorkspaceQueryKey(hostId), "sessions"] as const;
const lastRemoteHealthRecheck = new Map<string, number>();

function recheckRemoteHost(hostId: string, status: number): void {
	if (![401, 403, 426, 502, 503].includes(status)) return;
	const now = Date.now();
	const last = lastRemoteHealthRecheck.get(hostId);
	if (last !== undefined && now >= last && now - last < 15_000) return;
	lastRemoteHealthRecheck.set(hostId, now);
	requestRemoteHostsRefresh();
}
export function workspaceStatusesChecking(workspaces: WorkspaceSummary[] | undefined): boolean {
	return (
		workspaces?.some((workspace) => workspace.sessions.some((session) => session.statusReadiness === "checking")) ??
		false
	);
}
const reportedUnknownSessionFields = new Set<string>();

function reportUnknownSessionField(field: "status" | "activity", value?: string): void {
	const reason = value ? "unrecognized" : "missing";
	const key = `${field}:${reason}`;
	if (reportedUnknownSessionFields.has(key)) return;
	reportedUnknownSessionFields.add(key);
}

function toLocalWorkspaceSession(
	session: components["schemas"]["ControllersSessionView"],
	workspaceId: string,
	workspaceName: string,
): WorkspaceSession {
	const status = toSessionStatus(session.status, session.isTerminated);
	const scmStatus = session.scmStatus ? toSessionStatus(session.scmStatus) : undefined;
	const kanbanColumn = toKanbanColumn(session.kanbanColumn, status);
	const activity = toSessionActivity(session.activity);
	if (status === "unknown") reportUnknownSessionField("status", session.status);
	if (!activity || activity.state === "unknown") reportUnknownSessionField("activity", session.activity?.state);
	return {
		id: session.id,
		terminalHandleId: session.terminalHandleId,
		terminalGeneration: session.terminalGeneration,
		workspaceId,
		workspaceName,
		title: session.displayName ?? session.issueId ?? session.id,
		issueId: session.issueId,
		provider: toAgentProvider(session.harness),
		reviewerHarness: toReviewerHarnessId(session.reviewerHarness),
		reviewerConfig: session.reviewerConfig
			? {
					model: session.reviewerConfig.model ?? undefined,
					mode: session.reviewerConfig.mode ?? undefined,
					permissions: session.reviewerConfig.permissions ?? undefined,
				}
			: undefined,
		autoReviewEnabled: session.autoReviewEnabled ?? false,
		kind: session.kind === "orchestrator" ? "orchestrator" : session.kind === "worker" ? "worker" : undefined,
		// Carried through verbatim: the session surface must render from
		// the mode this session was created with, not from the current default.
		mode: session.mode === "chat" ? "chat" : "tui",
		branch: session.branch || undefined,
		status,
		scmStatus,
		kanbanColumn,
		displayStatus: session.displayStatus || undefined,
		provisionState: session.provisionState,
		provisionError: session.provisionError || undefined,
		provisionSteps: session.provisionSteps?.map((step) => ({
			id: step.id,
			status: step.status,
			startedAt: step.startedAt ?? undefined,
			endedAt: step.endedAt ?? undefined,
		})),
		branchState: session.branchState,
		branchNaming: session.branchNaming,
		staleBinary: session.staleBinary ? { version: session.staleBinary.version, since: session.staleBinary.since, switchFailedAt: session.staleBinary.switchFailedAt ?? undefined } : undefined,
		isTerminated: session.isTerminated,
		workspaceCleanup: session.workspaceCleanup,
		terminateOnPrMerge: session.terminateOnPrMerge ?? false,
		autoInjectReview: session.autoInjectReview ?? true,
		autoInjectCI: session.autoInjectCI ?? true,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		lastUserMessageAt: session.lastUserMessageAt ?? undefined,
		lastInteractionAt: session.lastInteractionAt ?? undefined,
		activity,
		previewUrl: session.previewUrl,
		previewRevision: session.previewRevision,
		isPinned: session.isPinned ?? false,
		pinnedAt: session.pinnedAt ?? undefined,
		prs: (session.prs ?? []).map(toPullRequestFacts),
		outputType: session.outputType,
		...(session.requestedOutput ? { requestedOutput: session.requestedOutput } : {}),
		artifactFiles: session.artifactFiles?.map(toSessionArtifact),
	};
}

// e2e seam (dev:web only): the Playwright fake-agent harness injects
// `window.__aoFakeAgent` (see e2e/support/fake-bridge.ts) to drive a
// deterministic, mutable session timeline off the SSE refetch path. Compiled
// out of the packaged build — the packaged renderer never sets VITE_NO_ELECTRON
// and always hits the real daemon.
type FakeAgentSeam = { snapshot: () => WorkspaceSummary[] };

class DaemonNotReadyError extends Error {
	constructor() {
		super("AO daemon API is not ready");
	}
}

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	if (usesPreviewWorkspaceData) {
		const fake =
			typeof window !== "undefined"
				? (window as unknown as { __aoFakeAgent?: FakeAgentSeam }).__aoFakeAgent
				: undefined;
		const snapshot = fake ? fake.snapshot() : mockWorkspaces;
		return applyOptimisticSessionKills(snapshot) ?? snapshot;
	}
	if (!hasTrustedApiBaseUrl()) {
		throw new DaemonNotReadyError();
	}

	const [{ data: projectsData, error: projectsError }, { data: sessionsData, error: sessionsError }] =
		await Promise.all([apiClient.GET("/api/v1/projects"), apiClient.GET("/api/v1/sessions")]);

	if (projectsError || sessionsError) {
		throw projectsError ?? sessionsError;
	}

	const sessions = sessionsData?.sessions ?? [];
	const standaloneName = standaloneWorkspaceName();
	const projects = (projectsData?.projects ?? []).map((project) => {
		const kind = toProjectKind(project.kind);
		return {
			id: project.id,
			name: project.name,
			kind,
			path: project.path,
			folderMissing: project.folderMissing,
			orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
			sessions: sessions
				.filter((session) => session.projectId === project.id)
				.map((session) => toWorkspaceSession(session, project)),
		};
	});
	const standalone: WorkspaceSummary = {
		id: STANDALONE_WORKSPACE_ID,
		name: standaloneName,
		kind: STANDALONE_PROJECT_KIND,
		path: "Not attached to a project",
		sessions: sessions
			.filter((session) => !session.projectId)
			.map((session) => toLocalWorkspaceSession(session, STANDALONE_WORKSPACE_ID, standaloneName)),
	};
	const workspaces =
		standalone.sessions.length > 0 ? placeStandaloneWorkspaceLast([...projects, standalone]) : projects;
	// Pending optimistic kills must survive CDC/refetch while the daemon kill is in flight.
	return applyOptimisticSessionKills(workspaces) ?? workspaces;
}

async function fetchRemoteProjects(hostId: string) {
	const { data, error, response } = await clientForHost(hostId).GET("/api/v1/projects");
	if (error) {
		recheckRemoteHost(hostId, response.status);
		throw error;
	}
	return data?.projects ?? [];
}

async function fetchRemoteSessions(hostId: string) {
	const { data, error, response } = await clientForHost(hostId).GET("/api/v1/sessions");
	if (error) {
		recheckRemoteHost(hostId, response.status);
		throw error;
	}
	return Promise.all((data?.sessions ?? []).map(async (session) => ({
		...session,
		artifactFiles: await Promise.all((session.artifactFiles ?? []).map(async (artifact) => ({
			...artifact,
			rawUrl: artifact.rawUrl ? await aoBridge.remotes.previewUrl(hostId, session.id, artifact.rawUrl) : undefined,
			// The remote daemon's inline origin is a localhost name, which here
			// would mean this computer; a remote chat shows no frame anyway.
			inlineUrl: undefined,
		}))),
	})));
}

function toRemoteWorkspaces(
	hostId: string,
	remoteProjects: Awaited<ReturnType<typeof fetchRemoteProjects>>,
	sessions: Awaited<ReturnType<typeof fetchRemoteSessions>>,
): WorkspaceSummary[] {
	const projects: WorkspaceSummary[] = remoteProjects.map((project) => ({
		hostId,
		id: project.id,
		name: project.name,
		kind: toProjectKind(project.kind),
		path: project.path,
		folderMissing: project.folderMissing,
		orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
		sessions: sessions.filter((session) => session.projectId === project.id).map((session) => ({
			...toWorkspaceSession(session, project),
			hostId,
		})),
	}));
	const standalone = sessions.filter((session) => !session.projectId).map((session) => ({
		...toWorkspaceSession(session, { id: STANDALONE_WORKSPACE_ID, name: standaloneWorkspaceName() }),
		hostId,
	}));
	if (standalone.length > 0) projects.push({
		hostId,
		id: STANDALONE_WORKSPACE_ID,
		name: standaloneWorkspaceName(),
		kind: STANDALONE_PROJECT_KIND,
		path: "Not attached to a project",
		sessions: standalone,
	});
	return applyOptimisticSessionKills(projects) ?? projects;
}

async function fetchRemoteWorkspaces(hostId: string): Promise<WorkspaceSummary[]> {
	const [projects, sessions] = await Promise.all([fetchRemoteProjects(hostId), fetchRemoteSessions(hostId)]);
	return toRemoteWorkspaces(hostId, projects, sessions);
}

// Shared so route loaders can prefetch via queryClient.ensureQueryData (paired
// with the router's defaultPreload: "intent") and the hook reads the same cache.
// No refetchInterval here: every observer that carries one runs its own timer,
// and timers started at different mount times do not dedupe. With ~18
// subscribers that meant several /projects + /sessions fetches per tick.
// useWorkspacePolling() is the single owner of the interval.
export const workspaceQueryOptions = {
	queryKey: workspaceQueryKey,
	queryFn: fetchWorkspaces,
	// Retrying before the daemon is up only parks the query in a 1s backoff.
	// Fetches started meanwhile (the ready-time invalidation, the shell's startup
	// fetch) join that backoff instead of running, which held the first
	// /projects + /sessions about 0.75s past "daemon listening" on cold launch.
	// Fail fast instead; the daemon status change refetches.
	retry: (failureCount: number, error: Error) => !(error instanceof DaemonNotReadyError) && failureCount < 1,
	staleTime: 10_000,
};

export const workspaceRefetchInterval = (query: Query<WorkspaceSummary[]>) =>
	workspaceStatusesChecking(query.state.data) ? 300 : 15_000;

/**
 * Drives the workspace poll from one place. Mounted once by the shell; it never
 * re-renders its host (notifyOnChangeProps: []), it only keeps the timer.
 */
export function useWorkspacePolling(enabled = true) {
	useQuery({ ...workspaceQueryOptions, refetchInterval: workspaceRefetchInterval, notifyOnChangeProps: [], enabled });
}

type WorkspaceSubscriptionOptions = {
	subscribed?: boolean;
	enabled?: boolean;
};

export function useRemoteWorkspaces(options: WorkspaceSubscriptionOptions = {}) {
	const connected = useConnectedHosts();
	const projects = useQueries({
		queries: connected.map((hostId) => ({
			queryKey: remoteProjectsQueryKey(hostId),
			queryFn: () => fetchRemoteProjects(hostId),
			retry: 1,
			refetchInterval: 15_000,
			subscribed: options.subscribed,
		})),
	});
	const sessions = useQueries({
		queries: connected.map((hostId) => ({
			queryKey: remoteSessionsQueryKey(hostId),
			queryFn: () => fetchRemoteSessions(hostId),
			retry: 1,
			refetchInterval: 15_000,
			subscribed: options.subscribed,
		})),
	});
	return {
		data: connected.flatMap((hostId, index) => projects[index]?.data
			? toRemoteWorkspaces(hostId, projects[index].data, sessions[index]?.data ?? [])
			: []),
		loadedProjectHostIds: connected.filter((_, index) => projects[index]?.data !== undefined),
		loadedSessionHostIds: connected.filter((_, index) => sessions[index]?.data !== undefined),
		failedHostIds: connected.filter((_, index) => projects[index]?.isError || sessions[index]?.isError),
		refetch: () => Promise.all([...projects, ...sessions].map((query) => query.refetch())),
	};
}

/** A host-qualified project detail query for the board. It shares the remote
 * session query's key, so session mutations refresh both detail surfaces. */
export function useRemoteProjectQuery(hostId: string, projectId: string) {
	return useQuery({
		queryKey: remoteWorkspaceQueryKey(hostId),
		queryFn: () => fetchRemoteWorkspaces(hostId),
		select: (workspaces) => workspaces.find((workspace) => workspace.id === projectId),
		enabled: Boolean(hostId && projectId),
		retry: 1,
	});
}


export function useWorkspaceQuery(options: WorkspaceSubscriptionOptions = {}) {
	return useQuery({ ...workspaceQueryOptions, subscribed: options.subscribed, enabled: options.enabled });
}

/**
 * Subscribe a detail surface to one session instead of the complete workspace
 * tree. TanStack Query applies structural sharing to the selected value, so an
 * activity update elsewhere no longer redraws the open session workspace.
 */
export function useWorkspaceSession(sessionId: string, hostId?: string, localLookupEnabled = true) {
	const queryClient = useQueryClient();
	const selectRemoteSession = useMemo(
		() => (workspaces: WorkspaceSummary[]) => workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.id === sessionId),
		[sessionId],
	);
	const remote = useQuery({
		queryKey: remoteWorkspaceQueryKey(hostId ?? ""),
		queryFn: () => fetchRemoteWorkspaces(hostId ?? ""),
		select: selectRemoteSession,
		enabled: Boolean(hostId && sessionId),
	});
	const selectLocalSession = useMemo(
		() => (workspaces: WorkspaceSummary[]) =>
			workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.id === sessionId),
		[sessionId],
	);
	const local = useQuery({ ...workspaceQueryOptions, select: selectLocalSession, enabled: localLookupEnabled && !hostId });
	const localWorkspaces = useQuery({ ...workspaceQueryOptions, subscribed: false, enabled: localLookupEnabled && Boolean(sessionId) && !hostId });
	const direct = useQuery({
		queryKey: ["session", sessionId],
		enabled: localLookupEnabled && Boolean(sessionId) && !hostId && local.data === undefined,
		retry: (attempt, error) => apiErrorCode(error) === "SESSION_NOT_FOUND" && attempt < 4,
		retryDelay: 250,
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}", {
				params: { path: { sessionId } },
			});
			if (error) throw error;
			const session = data?.session;
			if (!session) return undefined;
			const project = session.projectId
				? (localWorkspaces.data?.find((workspace) => workspace.id === session.projectId) ??
					({ id: session.projectId, name: "" } satisfies Pick<WorkspaceSummary, "id" | "name">))
				: ({
						id: STANDALONE_WORKSPACE_ID,
						name: standaloneWorkspaceName(),
					} satisfies Pick<WorkspaceSummary, "id" | "name">);
			return toWorkspaceSession(session, project);
		},
	});
	const resolvedDirectSession = useMemo(() => {
		if (!direct.data) return undefined;
		const workspace = localWorkspaces.data?.find((candidate) => candidate.id === direct.data?.workspaceId);
		if (!workspace || direct.data.workspaceName === workspace.name) return direct.data;
		return { ...direct.data, workspaceName: workspace.name };
	}, [direct.data, localWorkspaces.data]);
	useEffect(() => {
		if (hostId || !localLookupEnabled) return;
		if (!resolvedDirectSession) return;
		queryClient.setQueryData<WorkspaceSummary[]>(workspaceQueryKey, (current) => {
			if (!current) return current;
			let changed = false;
			const next = current.map((workspace) => {
				if (workspace.id !== resolvedDirectSession.workspaceId) return workspace;
				if (workspace.sessions.some((session) => session.id === resolvedDirectSession.id)) return workspace;
				changed = true;
				return {
					...workspace,
					sessions: [...workspace.sessions, resolvedDirectSession],
				};
			});
			return changed ? next : current;
		});
	}, [queryClient, resolvedDirectSession, hostId, localLookupEnabled]);
	if (hostId) return remote;
	return {
		...local,
		data: local.data ?? resolvedDirectSession,
		isLoading: local.isLoading || direct.isLoading,
	};
}

/**
 * The kind of project a remote session belongs to. It reads the same host list
 * as useWorkspaceSession, from the same moment, so it adds no request.
 */
export function useRemoteSessionProjectKind(sessionId: string, hostId?: string): WorkspaceSummary["kind"] {
	const selectKind = useMemo(
		() => (workspaces: WorkspaceSummary[]) => workspaces.find((workspace) => workspace.sessions.some((session) => session.id === sessionId))?.kind,
		[sessionId],
	);
	return useQuery({
		queryKey: remoteWorkspaceQueryKey(hostId ?? ""),
		queryFn: () => fetchRemoteWorkspaces(hostId ?? ""),
		select: selectKind,
		enabled: Boolean(hostId && sessionId),
	}).data;
}

export type WorkspaceScope = {
	project?: Pick<WorkspaceSummary, "id" | "kind" | "name" | "orchestratorAgent">;
	hasWorkerSessions: boolean;
	session?: WorkspaceSession;
	orchestrator?: WorkspaceSession;
};

function selectWorkspaceScope(
	workspaces: WorkspaceSummary[],
	projectId: string | undefined,
	sessionId: string | undefined,
): WorkspaceScope {
	const session = sessionId
		? workspaces.flatMap((workspace) => workspace.sessions).find((candidate) => candidate.id === sessionId)
		: undefined;
	const resolvedProjectId = session?.workspaceId ?? projectId;
	const workspace = resolvedProjectId ? workspaces.find((candidate) => candidate.id === resolvedProjectId) : undefined;
	// Do not carry the project's complete sessions array into shell chrome. With
	// React Query's structural sharing, this small metadata projection retains
	// its identity when another session in the same project streams an update.
	const project = workspace
		? {
				id: workspace.id,
				kind: workspace.kind,
				name: workspace.name,
				orchestratorAgent: workspace.orchestratorAgent,
			}
		: undefined;
	return {
		project,
		session,
		hasWorkerSessions: workspace ? workerSessions(workspace.sessions).length > 0 : false,
		orchestrator: workspace ? newestActiveOrchestrator(workspace.sessions) : undefined,
	};
}

/**
 * Subscribe shell chrome to just the routed project and session. This avoids
 * redrawing the topbar for streamed activity from every other project.
 */
export function useWorkspaceScope(projectId?: string, sessionId?: string, hostId?: string) {
	const selectLocalScope = useMemo(
		() => (workspaces: WorkspaceSummary[]) => selectWorkspaceScope(workspaces, projectId, sessionId),
		[projectId, sessionId],
	);
	const local = useQuery({ ...workspaceQueryOptions, select: selectLocalScope, enabled: !hostId });
	const remote = useQuery({ queryKey: remoteWorkspaceQueryKey(hostId ?? ""), queryFn: () => fetchRemoteWorkspaces(hostId ?? ""), select: selectLocalScope, enabled: Boolean(hostId) });
	return hostId ? remote : local;
}

function selectTraySessions(workspaces: WorkspaceSummary[]): TraySessionEntry[] {
	const entries: TraySessionEntry[] = [];
	for (const workspace of workspaces) {
		for (const session of workerSessions(workspace.sessions)) {
			const zone = attentionZone(session);
			if ((zone === "merge" && session.status === "merged") || (zone !== "action" && zone !== "merge")) continue;
			entries.push({
				projectId: session.workspaceId,
				projectName: workspace.name,
				sessionId: session.id,
				title: session.title,
				zone,
			});
		}
	}
	return entries;
}

/**
 * The tray lives for the whole app lifetime, but only attention-worthy worker
 * sessions affect its native payload. Select that compact projection at the
 * query boundary so ordinary streamed activity does not wake the runtime.
 */
export function useWorkspaceTraySessions() {
	const local = useQuery({
		...workspaceQueryOptions,
		select: selectTraySessions,
	});
	return local;
}
