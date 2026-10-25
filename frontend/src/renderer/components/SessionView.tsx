import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, PanelRight, Plus } from "lucide-react";
import { useBlocker } from "@tanstack/react-router";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
import { BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { CenterPane } from "./CenterPane";
import type { FileOpenOptions, FileViewMode } from "./FileContentPane";
import { SessionChatSurface } from "./chat/SessionChatSurface";
import { ReviewerChatSurface } from "./chat/ReviewerChatSurface";
import { NotificationCenter } from "./NotificationCenter";
import { SessionInspectorRail, initialInspectorSize, inspectorSizing, sizingGeometryEqual, INSPECTOR_SPRING_MS, INSPECTOR_SPRING_EASING, type InspectorSizing } from "./SessionInspectorRail";
import { SessionFileExplorer } from "./SessionFileExplorer";
import { FilesTopbarHostContext } from "./files-topbar-host";
import { SessionFileTab } from "./SessionFileTabs";
import { SessionFileWorkspace } from "./SessionFileWorkspace";
import { SessionFilesPopOut } from "./SessionFilesPopOut";
import { isArtifactPreviewUrl } from "../lib/artifact-preview";
import { SessionBrowserPopOut } from "./SessionBrowserPopOut";
import { SessionTabMenu } from "./TerminalAgentControls";
import { SessionInspector } from "./SessionInspector";
import type { ArtifactOpenRequest } from "./SessionArtifactsView";
import { ShellTopbar } from "./ShellTopbar";
import { SessionTopbarHost } from "./SessionTopbarPortal";
import { TopbarButton } from "./TopbarButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useAgentAccountLabel } from "../hooks/useAgentAccounts";
import { useBrowserView } from "../hooks/useBrowserView";
import { useFileAnnotation } from "../hooks/useFileAnnotation";
import { useOpenArtifactPreview } from "../hooks/useOpenArtifactPreview";
import {
	adoptedShellHandle,
	useCloseShellTerminal,
	useOpenShellTerminal,
	useRenameShellTerminal,
	useShellTerminals,
} from "../hooks/useShellTerminals";
import { useSessionInterfaceSwitch } from "../hooks/useSessionInterfaceSwitch";
import { canResumeAgent, resumeAgentOnOpen } from "../hooks/useCanResumeAgent";
import { useSessionInterfaceTransitionStatus } from "../hooks/useSessionInterfaceTransition";
import { conversationQueryKey } from "../hooks/useConversation";
import { discardCapturedPendingFileAttachments } from "../hooks/useFileAttachments";
import {
	useRemoteSessionProjectKind,
	useWorkspaceQuery,
	useWorkspaceSession,
	workspaceQueryKeyForHost,
} from "../hooks/useWorkspaceQuery";
import { subscribeChatReveal } from "../lib/chat-context-bus";
import { apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { clientForSessionHost } from "../lib/host-clients";
import { useHostConnection } from "../hooks/useHostConnection";
import { sessionReviewsQueryKey } from "../lib/session-reviews";
import { sessionUiKey } from "../lib/hosts";
import { resolveSessionWorkspacePath, sessionWorkspaceFilesQueryOptions } from "../hooks/useSessionWorkspaceFiles";
import { isAbsoluteFileReference, matchWorkspaceFilePath, normalizeWorkspaceFileReference } from "../lib/workspace-file-path";
import { markFileViewerPerformance } from "../lib/file-viewer-performance";
import { filesProjectKind } from "../lib/files-review-selection";
import { aoBridge } from "../lib/bridge";
import {
	chatDraftDialogCopy,
} from "../lib/chat-draft-boundary";
import {
	activateSessionFile,
	closeSessionFile,
	EMPTY_SESSION_FILE_TABS,
	openSessionFile,
 sessionFileTabKey,
	type SessionFileTabState,
} from "../lib/session-file-tabs";
import { isMacPlatform } from "../lib/platform";
import { useShell } from "../lib/shell-context";
import { cn } from "../lib/utils";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { isOrchestratorSession, sessionAgentExited, sessionIsActive, type SessionArtifact, type WorkspaceSummary } from "../types/workspace";
import { terminalTargetBelongsToSession, type TerminalTarget } from "../types/terminal";
import { focusAfterPaint, useSessionShortcut } from "../hooks/useAppShortcut";
import { inspectorIsOpen, useResolvedTheme, useUiStore, type InspectorView } from "../stores/ui-store";
import { useSideChatsAvailable } from "../lib/side-chats";
import {
	INSPECTOR_SEPARATOR_RESERVE_PX,
	inspectorMaxWidthCss,
} from "../lib/inspector-width";

type CenterFileOpenRequest = { path?: string; source?: FileOpenOptions["source"]; previousPath?: string; commitSha?: string; editing: boolean; key: number; line?: number; mode: FileViewMode; scope?: FileOpenOptions["scope"] };
const EMPTY_AUXILIARY_TAB_ORDER: string[] = [];
// Centre-file open requests take keys from this process-wide counter, not a
// per-mount one: the display mode remembered for a request (ui-store) outlives a
// SessionView remount, so a new request must never reuse a recorded key.
let lastCenterFileRequestKey = 0;
function nextCenterFileRequestKey(): number {
	lastCenterFileRequestKey += 1;
	return lastCenterFileRequestKey;
}
// The inspector tab labels respond to the tablist's remaining width. The
// 239px tablist breakpoint plus the 76px pinned-action reserve and 10px leading
// inset gives a 325px inspector breakpoint for the animation lock.
const INSPECTOR_COMPACT_MAX_PX = 325;
const TOPBAR_SECONDARY_COMPACT_MAX_PX = 759;
const isMac = isMacPlatform();
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;
const newTerminalShortcutLabel = shortcutBindingLabel(defaultShortcutBindings("new-shell-terminal", isMac)[0], isMac);

type ReviewsResponse = components["schemas"]["ListReviewsResponse"];
type ReviewerSurface = components["schemas"]["DomainReviewerSurface"];
type ReviewerTerminalTarget = { handleId: string; harness: string };
type ReviewerChatTarget = { reviewId: string; harness: string };

type BrowserPopOutPhase = "docked" | "mounting" | "open";
type BrowserPopOutState = {
	sessionId: string;
	phase: BrowserPopOutPhase;
};

function topbarSecondaryLabelMode(width: number): "compact" | "expanded" {
	return width <= TOPBAR_SECONDARY_COMPACT_MAX_PX ? "compact" : "expanded";
}

function previewRevealKey(previewUrl?: string, previewRevision?: number): string {
	const target = previewUrl?.trim();
	if (!target) return "";
	if (typeof previewRevision === "number") return `revision:${previewRevision}`;
	return `url:${target}`;
}

const BROWSER_REVEAL_ACTIONS = new Set(["open", "tab-new"]);

function browserIsVisible(sessionId: string, browserPoppedOut: boolean): boolean {
	if (browserPoppedOut) return true;
	const { inspectorSessions } = useUiStore.getState();
	return inspectorIsOpen(inspectorSessions, sessionId) && (inspectorSessions[sessionId]?.view ?? "summary") === "browser";
}

// workingReviewerSurface is the live reviewer to show when the selected one is
// idle but another is working (an agent asked a different reviewer). The
// selected reviewer fields keep meaning the session's selected reviewer.
function workingReviewerSurface(data?: ReviewsResponse): ReviewerSurface | undefined {
	const active = data?.activeReviewers ?? [];
	if (active.some((surface) => surface.reviewId === data?.reviewerSurface?.reviewId)) return undefined;
	return active[0];
}

function reviewerTerminalFromReviews(data?: ReviewsResponse, selected?: TerminalTarget): ReviewerTerminalTarget | undefined {
	// Several reviewers can run on one worker at once. The reviewer tab follows
	// whichever live reviewer the user opened (from the inspector), and
	// otherwise shows the selected reviewer, or the working one when it is idle.
	if (selected?.kind === "reviewer") {
		const opened = data?.activeReviewers?.find((surface) => surface.mode !== "chat" && surface.handleId === selected.handleId);
		if (opened?.handleId) return { handleId: opened.handleId, harness: opened.harness || selected.harness };
	}
	const working = workingReviewerSurface(data);
	if (working) return working.mode !== "chat" && working.handleId ? { handleId: working.handleId, harness: working.harness || "codex" } : undefined;
	if (data?.reviewerSurface?.mode === "chat") return undefined;
	const handleId = data?.reviewerHandleId?.trim();
	if (!handleId) return undefined;
	const latest = data?.reviews?.find((review) => review.latestRun)?.latestRun;
	return { handleId, harness: data?.reviewerHarness || latest?.harness || "codex" };
}

function reviewerChatFromReviews(data?: ReviewsResponse): ReviewerChatTarget | undefined {
	const surface = workingReviewerSurface(data) ?? data?.reviewerSurface;
	if (surface?.mode !== "chat" || !surface.reviewId) return undefined;
	return { reviewId: surface.reviewId, harness: surface.harness || "codex" };
}

type SessionViewProps = {
	sessionId: string;
	projectId?: string;
	hostId?: string;
};

// The session detail screen: terminal + git rail. On Win/Linux the shell owns
// ShellTopbar above this view; when the platform hides the shell topbar
// (macOS), the same topbar mounts here so the outer panel stays full-height.
// Rendered by both the project-scoped and cross-project session routes.
// The persistent shell cache owns terminal lifetime by logical session + handle:
// route switches retain the xterm instance and latest output, while a replacement
// handle gets a clean xterm/mux binding.
//
// The inspector uses the same Motion spring as the left sidebar (gap width +
// x-transform). Summary/Reviews/Files share a utility width, while Browser
// automatically grows into a co-work canvas. Chat readability clamps either
// profile before the conversation can become unusably narrow.
export function SessionView({ sessionId, projectId, hostId }: SessionViewProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const uiSessionId = sessionUiKey(sessionId, hostId);
	const { baseUrl: remoteBase, label: hostLabel } = useHostConnection(hostId);
	const refreshWorkspaces = useCallback(
		() => queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(hostId) }),
		[hostId, queryClient],
	);
	const workspaceQuery = useWorkspaceQuery({ enabled: !hostId });
	const remoteSessionQuery = useWorkspaceSession(sessionId, hostId, false);
	const workspaces = hostId ? [] : workspaceQuery.data ?? [];
	const routedWorkspaces = projectId ? workspaces.filter((workspace) => workspace.id === projectId) : [];
	const listedMatches = (projectId ? routedWorkspaces : workspaces)
		.flatMap((workspace) => workspace.sessions.filter((candidate) => candidate.id === sessionId));
	const listedSession = listedMatches.length === 1 ? listedMatches[0] : undefined;
	const ambiguousRoute = listedMatches.length > 1 || Boolean(projectId && routedWorkspaces.length > 1 && !listedSession);
	const localLookupEnabled = !ambiguousRoute;
	const workspaceSessionQuery = useWorkspaceSession(sessionId, undefined, !hostId && localLookupEnabled);
	const fallbackSession = !projectId || workspaceSessionQuery.data?.workspaceId === projectId
		? workspaceSessionQuery.data : undefined;
	const session = hostId ? (remoteBase && !remoteSessionQuery.isError && remoteSessionQuery.data?.workspaceId === (projectId ?? remoteSessionQuery.data?.workspaceId) ? remoteSessionQuery.data : undefined)
		: ambiguousRoute ? undefined : listedSession ?? fallbackSession;
	// The Files review offers only what the session's kind of project has.
	const remoteWorkspaceKind = useRemoteSessionProjectKind(sessionId, hostId);
	const sessionWorkspaceKind = hostId ? remoteWorkspaceKind : workspaces.find((workspace) => workspace.id === session?.workspaceId)?.kind;
	const filesKind = session ? filesProjectKind(session, sessionWorkspaceKind) : undefined;
	const interfaceContext = hostId ?? (session ? null : undefined);
	const interfaceUi = useSessionInterfaceSwitch(sessionId, session, interfaceContext);
	const accountLabel = useAgentAccountLabel(Boolean(interfaceUi.accountMoveTarget));
	const accountSwitchingLabel = interfaceUi.accountMoveTarget
		? t("settings.agentAccounts.switching", { email: accountLabel(interfaceUi.accountMoveTarget) })
		: undefined;
	const { draftBoundaries: chatDraftBoundaries, confirmUnsafeDraftLeave } = interfaceUi;
	const developerMode = useUiStore((state) => state.developerMode);
	const remoteHostsEnabled = useUiStore((state) => state.remoteHosts);
	const setRemoteHosts = useUiStore((state) => state.setRemoteHosts);
	useBlocker({
		disabled: chatDraftBoundaries.length === 0,
		enableBeforeUnload: chatDraftBoundaries.length > 0,
		shouldBlockFn: async () => {
			const decision = await confirmUnsafeDraftLeave();
			if (decision.kind === "cancelled") {
				if (hostId && developerMode && !remoteHostsEnabled) setRemoteHosts(true);
				return true;
			}
			if (decision.kind === "confirmed") {
				// Route navigation is the boundary itself, so confirmed in-flight file
				// work can be invalidated now. Interface switches defer this until the
				// exact durable transition reports completed.
				discardCapturedPendingFileAttachments(decision.pendingAttachments);
			}
			return false;
		},
	});
	useEffect(() => {
		aoBridge.app.setChatDraftRisk?.(chatDraftBoundaries, chatDraftDialogCopy(chatDraftBoundaries));
	}, [chatDraftBoundaries, t]);
	useEffect(
		() => () => aoBridge.app.setChatDraftRisk?.([]),
		[sessionId],
	);
	const theme = useResolvedTheme();
	const browserOnly = Boolean(session && isOrchestratorSession(session));
	const isInspectorOpen = useUiStore((state) => inspectorIsOpen(state.inspectorSessions, uiSessionId));
	const [sideChatContainer, setSideChatContainer] = useState<HTMLDivElement | null>(null);
	const sideChatsAvailable = useSideChatsAvailable(session, hostId);
	const inspectorView = useUiStore((state) => browserOnly ? "browser" : state.inspectorSessions[uiSessionId]?.view ?? "summary");
	const browserUnseen = useUiStore((state) => Boolean(state.inspectorSessions[uiSessionId]?.browserUnseen));
	const setInspectorOpenForSession = useUiStore((state) => state.setInspectorOpen);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const setInspectorViewForSession = useUiStore((state) => state.setInspectorView);
	const showGlobalToast = useUiStore((state) => state.showGlobalToast);
	const setFilesChangedOnly = useUiStore((state) => state.setFilesChangedOnly);
	const resetFilesSelection = useUiStore((state) => state.resetFilesSelection);
	const workspaceFileOpenRequest = useUiStore((state) => state.workspaceFileOpenRequest);
	const clearWorkspaceFileOpenRequest = useUiStore((state) => state.clearWorkspaceFileOpenRequest);
	const initializeInspectorSession = useUiStore((state) => state.initializeInspectorSession);
	const setBrowserContentRevealed = useUiStore((state) => state.setBrowserContentRevealed);
	const setBrowserUnseen = useUiStore((state) => state.setBrowserUnseen);
	const { daemonStatus } = useShell();
	const resumeStatus = useSessionInterfaceTransitionStatus(canResumeAgent(session) ? session?.id : undefined, hostId);
	const canResume = canResumeAgent(session, resumeStatus.transition) && !resumeStatus.isLoading && !resumeStatus.statusError;
	const openedSession = useRef({ key: uiSessionId, checked: false });
	const autoResume = useMutation({
		mutationKey: ["resume-agent", "local", sessionId],
		mutationFn: resumeAgentOnOpen,
		onSettled: async (_data, _error, id) => {
			await Promise.all([
				refreshWorkspaces(),
				queryClient.invalidateQueries({ queryKey: conversationQueryKey(id) }),
			]);
		},
	});
	// True while a background resume owns the chat surface: hide the stopped
	// banner and disable sending, but keep history readable. Covers the initial
	// check (before the mutation fires) and the mutation in flight. Once checked
	// is set, only the in-flight mutation keeps it true — switching back to an
	// already-resumed session no longer flashes "Resuming agent…" while the
	// workspace query catches up with the new activity state.
	const quietResume = (autoResume.variables === sessionId && autoResume.isPending) ||
		(!usesPreviewWorkspaceData && !hostId && canResumeAgent(session, resumeStatus.transition) &&
		!resumeStatus.statusError && openedSession.current.key === uiSessionId && !openedSession.current.checked);
	const resumeOnOpen = autoResume.mutate;
	useEffect(() => {
		if (openedSession.current.key !== uiSessionId) openedSession.current = { key: uiSessionId, checked: false };
		if (usesPreviewWorkspaceData || hostId || !session || daemonStatus.state !== "ready" ||
			(session.statusReadiness && session.statusReadiness !== "ready") || openedSession.current.checked) return;
		if (!sessionAgentExited(session)) {
			openedSession.current.checked = true;
			return;
		}
		if (!canResume) return;
		// One attempt per route opening; a failed resume or a later agent exit
		// stays stopped rather than entering an automatic restart loop.
		openedSession.current.checked = true;
		resumeOnOpen(session.id);
	}, [canResume, daemonStatus.state, hostId, resumeOnOpen, session, uiSessionId]);
	const previewBaselineRef = useRef<{ sessionId: string; key: string } | null>(null);
	const revealedBrowserCommandsRef = useRef<{ sessionId: string; commands: Set<string> }>({ sessionId: uiSessionId, commands: new Set() });
	const sessionSplitRef = useRef<HTMLDivElement | null>(null);
	const terminalLiveResizeTimerRef = useRef<number | null>(null);
	const workspaceResizeTimerRef = useRef<number | null>(null);
	const [inspectorSettledClosed, setInspectorSettledClosed] = useState(!isInspectorOpen);
	const inspectorPanelVisible = isInspectorOpen || !inspectorSettledClosed;
	const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>({ kind: "worker" });
	const [reviewerChatId, setReviewerChatId] = useState<string | null>(null);
	const [browserPopOutState, setBrowserPopOutState] = useState<BrowserPopOutState>({
		sessionId,
		phase: "docked",
	});
	const [filesPoppedOut, setFilesPoppedOut] = useState(false);
	const [filesSplit, setFilesSplit] = useState(() => window.localStorage.getItem("ao.files.diffStyle") === "split");
	const [artifactRequestsBySession, setArtifactRequestsBySession] = useState<Record<string, ArtifactOpenRequest>>({});
	const [fileTabsBySession, setFileTabsBySession] = useState<Record<string, SessionFileTabState>>({});
	const fileTabs = fileTabsBySession[uiSessionId] ?? EMPTY_SESSION_FILE_TABS;
	const [dirtyFilesBySession, setDirtyFilesBySession] = useState<Record<string, Record<string, true>>>({});
	const dirtyFiles = dirtyFilesBySession[uiSessionId] ?? {};
	const [centerFileRequestsBySession, setCenterFileRequestsBySession] = useState<
		Record<string, Record<string, CenterFileOpenRequest>>
	>({});
	const consumedCenterEditingRequestsRef = useRef(new Set<string>());
	const consumedCenterLineRequestsRef = useRef(new Set<string>());
	const [auxiliaryTabOrderBySession, setAuxiliaryTabOrderBySession] = useState<Record<string, string[]>>({});
	const auxiliaryTabOrder = auxiliaryTabOrderBySession[uiSessionId] ?? EMPTY_AUXILIARY_TAB_ORDER;
	const setAuxiliaryTabOrder = useCallback(
		(nextOrder: string[]) => {
			setAuxiliaryTabOrderBySession((current) => {
				const currentOrder = current[uiSessionId] ?? [];
				const visibleKeys = new Set(nextOrder);
				let nextIndex = 0;
				const mergedOrder = currentOrder.map((key) =>
					visibleKeys.has(key) ? nextOrder[nextIndex++]! : key,
				);
				while (nextIndex < nextOrder.length) mergedOrder.push(nextOrder[nextIndex++]!);
				return { ...current, [uiSessionId]: mergedOrder };
			});
		},
		[uiSessionId],
	);
	const removeAuxiliaryTab = useCallback(
		(key: string) => {
			setAuxiliaryTabOrderBySession((current) => {
				const currentOrder = current[uiSessionId];
				if (!currentOrder?.includes(key)) return current;
				const nextOrder = currentOrder.filter((candidate) => candidate !== key);
				if (nextOrder.length === 0) {
					const { [uiSessionId]: _removed, ...rest } = current;
					return rest;
				}
				return { ...current, [uiSessionId]: nextOrder };
			});
		},
		[uiSessionId],
	);
	const browserPopOutPhase = browserPopOutState.sessionId === sessionId ? browserPopOutState.phase : "docked";
	const browserPopOutMounted = browserPopOutPhase !== "docked";
	const browserPoppedOut = browserPopOutPhase === "open";
	const [browserPopoutTopbarHost, setBrowserPopoutTopbarHost] = useState<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		if (browserPopOutPhase !== "mounting" || !browserPopoutTopbarHost) return;
		// Establish the portal destination before moving the browser. This layout
		// effect completes before paint, so the user sees one atomic geometry change
		// and the address/tabs never spend a frame underneath the native view.
		setBrowserPopOutState({ sessionId, phase: "open" });
	}, [browserPopOutPhase, browserPopoutTopbarHost, sessionId]);
	// One SessionView serves every local session, so session-scoped UI state must
	// reset on a switch. Reset during render, not in an effect: children must never
	// mount (or fetch) against the previous session's reviewer, popout, or dialog.
	const [stateSessionId, setStateSessionId] = useState(sessionId);
	if (stateSessionId !== sessionId) {
		setStateSessionId(sessionId);
		setTerminalTarget({ kind: "worker" });
		setReviewerChatId(null);
		setBrowserPopOutState({ sessionId, phase: "docked" });
		setFilesPoppedOut(false);
	}
	const stopTerminalLiveResize = useCallback(() => {
		if (terminalLiveResizeTimerRef.current !== null) {
			window.clearTimeout(terminalLiveResizeTimerRef.current);
			terminalLiveResizeTimerRef.current = null;
		}
		sessionSplitRef.current?.removeAttribute("data-terminal-live-resize");
		sessionSplitRef.current?.removeAttribute("data-inspector-label-mode");
		sessionSplitRef.current?.removeAttribute("data-topbar-secondary-label-mode");
	}, []);
	const startTerminalLiveResize = useCallback(
		(labelMode: "compact" | "expanded", topbarLabelMode: "compact" | "expanded") => {
			const split = sessionSplitRef.current;
			if (!split) return;
			if (terminalLiveResizeTimerRef.current !== null) {
				window.clearTimeout(terminalLiveResizeTimerRef.current);
			}
			split.setAttribute("data-terminal-live-resize", "true");
			split.setAttribute("data-inspector-label-mode", labelMode);
			split.setAttribute("data-topbar-secondary-label-mode", topbarLabelMode);
			terminalLiveResizeTimerRef.current = window.setTimeout(() => {
				split.removeAttribute("data-terminal-live-resize");
				split.removeAttribute("data-inspector-label-mode");
				split.removeAttribute("data-topbar-secondary-label-mode");
				terminalLiveResizeTimerRef.current = null;
			}, INSPECTOR_SPRING_MS);
		},
		[],
	);

	useEffect(() => stopTerminalLiveResize, [stopTerminalLiveResize]);

	useEffect(() => {
		if (session?.kind !== "orchestrator" || session.mode === "chat") return;
		if (session.provisionState === "failed") {
			useUiStore.getState().setProjectProvisioning(session.workspaceId, false, hostId);
		}
	}, [hostId, session?.kind, session?.mode, session?.provisionState, session?.workspaceId]);
	const reviewerQuery = useQuery({
		queryKey: sessionReviewsQueryKey(sessionId, hostId),
		enabled: Boolean(
			(hostId ? remoteBase : window.ao) && session && sessionIsActive(session) && !isOrchestratorSession(session) && session.prs.length > 0,
		),
		refetchInterval: (query) => {
			const data = query.state.data as ReviewsResponse | undefined;
			return data?.reviews?.some((review) => review.status === "running") ? 2500 : false;
		},
		queryFn: async () => {
			const { data, error } = await clientForSessionHost(hostId).GET("/api/v1/sessions/{sessionId}/reviews", {
				params: { path: { sessionId } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to load reviews"));
			return data ?? ({ reviewerHandleId: "", reviews: [], runs: [], activeReviewers: [] } satisfies ReviewsResponse);
		},
	});
	const reviewerSwitchPending = useIsMutating({
		mutationKey: [...sessionReviewsQueryKey(sessionId, hostId), "switch-reviewer"],
	}) > 0;
	const availableReviewerTerminal = reviewerTerminalFromReviews(reviewerQuery.data, terminalTarget);
	const reviewerTerminal = session && sessionIsActive(session) ? availableReviewerTerminal : undefined;
	const availableReviewerChat = reviewerChatFromReviews(reviewerQuery.data);
	const reviewerChat = session && sessionIsActive(session) ? availableReviewerChat : undefined;

	// Shell terminals opened inside a session live beside its pane as extra tabs,
	// scoped to the session on screen so each session has its own shell set.
	const shellTerminalsQuery = useShellTerminals(hostId);
	const allShellTerminals = shellTerminalsQuery.data ?? [];
	const shellTerminals = useMemo(
		() => allShellTerminals.filter((shell) => shell.sessionId === sessionId),
		[allShellTerminals, sessionId],
	);
	const resolvedAuxiliaryTabOrder = useMemo(() => {
		const openFileKeys = fileTabs.openPaths.map((path) => `file:${path}`);
		const openShellKeys = shellTerminals.map((shell) => shell.handleId);
		const available = [
			...(reviewerTerminal ? [`reviewer:${reviewerTerminal.handleId}`] : []),
			...(!reviewerTerminal && reviewerChat ? [`reviewer-chat:${reviewerChat.reviewId}`] : []),
			...openFileKeys,
			...openShellKeys,
		];
		const availableKeys = new Set(available);
		// A pending shell tab keeps its place once it becomes its shell.
		const resolved = [
			...new Set(auxiliaryTabOrder.map((key) => adoptedShellHandle(key) ?? key)),
		].filter((key) => availableKeys.has(key));
		for (const key of available) {
			if (!resolved.includes(key)) resolved.push(key);
		}
		return resolved;
	}, [auxiliaryTabOrder, fileTabs.openPaths, reviewerChat, reviewerTerminal, shellTerminals]);
	useEffect(() => {
		setAuxiliaryTabOrderBySession((current) => {
			const storedOrder = current[uiSessionId] ?? [];
			const currentOrder = [...new Set(storedOrder.map((key) => adoptedShellHandle(key) ?? key))];
			const newKeys = resolvedAuxiliaryTabOrder.filter((key) => !currentOrder.includes(key));
			if (newKeys.length === 0 && currentOrder.length === storedOrder.length
				&& currentOrder.every((key, index) => key === storedOrder[index])) {
				return current;
			}
			return { ...current, [uiSessionId]: [...currentOrder, ...newKeys] };
		});
	}, [resolvedAuxiliaryTabOrder, uiSessionId]);
	const openShellTerminal = useOpenShellTerminal(hostId);
	const closeShellTerminal = useCloseShellTerminal(hostId);
	const renameShellTerminal = useRenameShellTerminal(hostId);
	const activeShellTerminalHandleId = useUiStore((state) => state.activeShellTerminalHandleId);
	const setActiveShellTerminal = useUiStore((state) => state.setActiveShellTerminal);
	const setVisibleTerminalKind = useUiStore((state) => state.setVisibleTerminalKind);
	const clearVisibleTerminalKind = useUiStore((state) => state.clearVisibleTerminalKind);
	const renameShellTerminalByHandle = useCallback(
		(handleId: string, title: string) => renameShellTerminal.mutate({ handleId, title }),
		[renameShellTerminal],
	);

	// Scoped to the session on screen so the daemon roots the shell in that
	// session's worktree (the project id is only the fallback when the session's
	// workspace can no longer be resolved).
	const addShellTerminal = useCallback(() => {
		const shell = openShellTerminal.open({ projectId: session?.workspaceId, sessionId });
		if (!shell) return;
		setFileTabsBySession((current) => ({
			...current,
			[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
		}));
		setActiveShellTerminal(shell.handleId);
		setTerminalTarget({
			generation: shell.createdAt,
			kind: "shell",
			handleId: shell.handleId,
			sessionId,
			title: shell.title,
		});
	}, [
		openShellTerminal,
		sessionId,
		session?.workspaceId,
		setActiveShellTerminal,
		uiSessionId,
	]);

	const activateAuxiliaryTab = useCallback(
		(key?: string) => {
			if (key?.startsWith("file:")) {
				const path = key.slice("file:".length);
				setActiveShellTerminal(null);
				setTerminalTarget({ kind: "worker" });
				setFileTabsBySession((current) => ({
					...current,
					[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, path),
				}));
				return;
			}
			if (reviewerTerminal && key === `reviewer:${reviewerTerminal.handleId}`) {
				setActiveShellTerminal(null);
				setTerminalTarget({
					kind: "reviewer",
					handleId: reviewerTerminal.handleId,
					harness: reviewerTerminal.harness,
					sessionId,
				});
				setFileTabsBySession((current) => ({
					...current,
					[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
				}));
				return;
			}
			if (reviewerChat && key === `reviewer-chat:${reviewerChat.reviewId}`) {
				setActiveShellTerminal(null);
				setTerminalTarget({ kind: "worker" });
				setReviewerChatId(reviewerChat.reviewId);
				setFileTabsBySession((current) => ({
					...current,
					[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
				}));
				return;
			}
			const shell = shellTerminals.find((candidate) => candidate.handleId === key);
			if (shell) {
				setActiveShellTerminal(shell.handleId);
				setTerminalTarget({
					generation: shell.createdAt,
					kind: "shell",
					handleId: shell.handleId,
					sessionId,
					title: shell.title,
				});
				setFileTabsBySession((current) => ({
					...current,
					[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
				}));
				return;
			}
			setActiveShellTerminal(null);
			setTerminalTarget({ kind: "worker" });
			setFileTabsBySession((current) => ({
				...current,
				[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
			}));
		},
		[reviewerChat, reviewerTerminal, sessionId, shellTerminals, setActiveShellTerminal, uiSessionId],
	);
	const adjacentAuxiliaryTab = useCallback(
		(closingKey: string) => {
			const closingIndex = resolvedAuxiliaryTabOrder.indexOf(closingKey);
			if (closingIndex < 0) return undefined;
			return resolvedAuxiliaryTabOrder[closingIndex - 1] ?? resolvedAuxiliaryTabOrder[closingIndex + 1];
		},
		[resolvedAuxiliaryTabOrder],
	);

	const selectShellTerminal = useCallback(
		(handleId: string) => {
			const shell = shellTerminals.find((s) => s.handleId === handleId);
			if (!shell) return;
			setReviewerChatId(null);
			setActiveShellTerminal(shell.handleId);
			setFileTabsBySession((current) => ({
				...current,
				[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
			}));
			setTerminalTarget({
				generation: shell.createdAt,
				kind: "shell",
				handleId: shell.handleId,
				sessionId,
				title: shell.title,
			});
		},
		[sessionId, shellTerminals, setActiveShellTerminal, uiSessionId],
	);

	const closeShellTerminalByHandle = useCallback(
		(handleId: string) => {
			if (terminalTarget.kind === "shell" && terminalTarget.handleId === handleId) {
				// Match the visible mixed strip, not the shell-only creation order.
				activateAuxiliaryTab(adjacentAuxiliaryTab(handleId));
			} else if (activeShellTerminalHandleId === handleId) {
				setActiveShellTerminal(null);
			}
			closeShellTerminal.mutate(handleId, {
				onSuccess: () => removeAuxiliaryTab(handleId),
				onError: (error) => {
					if (apiErrorCode(error) === "SHELL_TERMINAL_NOT_FOUND") removeAuxiliaryTab(handleId);
				},
			});
		},
		[
			activeShellTerminalHandleId,
			activateAuxiliaryTab,
			adjacentAuxiliaryTab,
			closeShellTerminal,
			removeAuxiliaryTab,
			setActiveShellTerminal,
			terminalTarget,
		],
	);

	// Selecting the session's own pane also drops the active shell, so the effect
	// above does not immediately pull the view back to that shell.
	const selectSessionTerminal = useCallback(() => {
		setActiveShellTerminal(null);
		setTerminalTarget({ kind: "worker" });
		setReviewerChatId(null);
		setFileTabsBySession((current) => ({
			...current,
			[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
		}));
	}, [setActiveShellTerminal, uiSessionId]);
	// "Ask in chat" from a file tab brings the session's Chat surface forward.
	useEffect(() => subscribeChatReveal(uiSessionId, selectSessionTerminal), [selectSessionTerminal, uiSessionId]);
	const selectReviewerTerminal = useCallback((target: ReviewerTerminalTarget) => {
		setReviewerChatId(null);
		setActiveShellTerminal(null);
		setTerminalTarget({ kind: "reviewer", handleId: target.handleId, harness: target.harness, sessionId });
		setFileTabsBySession((current) => ({
			...current,
			[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
		}));
	}, [sessionId, setActiveShellTerminal, uiSessionId]);
	const selectReviewerChat = useCallback((reviewId: string) => {
		setActiveShellTerminal(null);
		setTerminalTarget({ kind: "worker" });
		setReviewerChatId(reviewId);
		setFileTabsBySession((current) => ({
			...current,
			[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, null),
		}));
	}, [setActiveShellTerminal, uiSessionId]);
	const openCenterFile = useCallback(
		(path: string, options?: FileOpenOptions) => {
			const filePath = path;
			// Live paths retain their existing identities; snapshots coexist with them.
			path = sessionFileTabKey(path, options?.source);
			setReviewerChatId(null);
			setActiveShellTerminal(null);
			setTerminalTarget({ kind: "worker" });
			const key = nextCenterFileRequestKey();
			setCenterFileRequestsBySession((current) => {
				const sessionRequests = current[uiSessionId] ?? {};
				if (dirtyFiles[path] && sessionRequests[path]) return current;
				return {
					...current,
					[uiSessionId]: {
						...sessionRequests,
						[path]: {
							path: filePath,
							source: options?.source,
							previousPath: options?.previousPath,
							commitSha: options?.commitSha,
							editing: options?.editing ?? false,
							key,
							line: options?.line,
							mode: options?.mode ?? "file",
							scope: options?.scope,
						},
					},
				};
			});
			setFileTabsBySession((current) => ({
				...current,
				[uiSessionId]: openSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, path),
			}));
		},
		[setActiveShellTerminal, uiSessionId, dirtyFiles],
	);

	const markCenterFileEditingConsumed = useCallback((path: string, requestKey: number) => {
		consumedCenterEditingRequestsRef.current.add(`${uiSessionId}:${path}:${requestKey}`);
	}, [uiSessionId]);
	const markCenterFileLineConsumed = useCallback((path: string, requestKey: number) => {
		consumedCenterLineRequestsRef.current.add(`${uiSessionId}:${path}:${requestKey}`);
	}, [uiSessionId]);
	const setCenterFileDirty = useCallback((path: string, dirty: boolean) => {
		setDirtyFilesBySession((current) => {
			const sessionFiles = current[uiSessionId] ?? {};
			if (dirty) {
				if (sessionFiles[path]) return current;
				return { ...current, [uiSessionId]: { ...sessionFiles, [path]: true } };
			}
			if (!sessionFiles[path]) return current;
			const nextSessionFiles = { ...sessionFiles };
			delete nextSessionFiles[path];
			return { ...current, [uiSessionId]: nextSessionFiles };
		});
	}, [uiSessionId]);
	const activateCenterFile = useCallback((path: string) => {
		setReviewerChatId(null);
		setActiveShellTerminal(null);
		setTerminalTarget({ kind: "worker" });
		setFileTabsBySession((current) => ({
			...current,
			[uiSessionId]: activateSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, path),
		}));
	}, [setActiveShellTerminal, uiSessionId]);
	// Closed file tabs, newest last, so ⌘⇧T can bring them back.
	const closedFilePathsRef = useRef<Record<string, string[]>>({});
	const closeCenterFile = useCallback((path: string) => {
		const closed = (closedFilePathsRef.current[uiSessionId] ??= []);
		closed.push(path);
		if (closed.length > 20) closed.shift();
		setFileTabsBySession((current) => ({
			...current,
			[uiSessionId]: closeSessionFile(current[uiSessionId] ?? EMPTY_SESSION_FILE_TABS, path),
		}));
		if (fileTabs.activePath === path) {
			activateAuxiliaryTab(adjacentAuxiliaryTab(`file:${path}`));
		}
		removeAuxiliaryTab(`file:${path}`);
	}, [activateAuxiliaryTab, adjacentAuxiliaryTab, fileTabs.activePath, removeAuxiliaryTab, uiSessionId]);
	// The shell layout owns opening (it is mounted on every route, so the button
	// and ⌘T / Ctrl+T work everywhere); this view only follows the result. When a new
	// shell becomes active while a session is on screen, switch the pane to it —
	// that is what makes the shortcut feel like it opened a terminal *here*.
	useEffect(() => {
		if (!activeShellTerminalHandleId) return;
		const shell = shellTerminals.find((s) => s.handleId === activeShellTerminalHandleId);
		if (!shell) return;
		if (terminalTarget.kind === "shell" && terminalTarget.handleId === shell.handleId &&
			terminalTarget.generation === shell.createdAt && terminalTarget.title === shell.title &&
			!fileTabs.activePath && !reviewerChatId) return;
		selectShellTerminal(shell.handleId);
	}, [activeShellTerminalHandleId, fileTabs.activePath, reviewerChatId, selectShellTerminal, shellTerminals, terminalTarget]);
	// A tab selected while it was pending follows it to the shell it became.
	// Only what still points at the pending tab moves: the user may have
	// selected another tab in the meantime.
	useEffect(() => {
		const adoptedActive = activeShellTerminalHandleId ? adoptedShellHandle(activeShellTerminalHandleId) : undefined;
		if (adoptedActive) {
			setActiveShellTerminal(adoptedActive);
			return;
		}
		if (terminalTarget.kind !== "shell") return;
		const adoptedTarget = adoptedShellHandle(terminalTarget.handleId);
		if (adoptedTarget && shellTerminals.some((shell) => shell.handleId === adoptedTarget)) {
			selectShellTerminal(adoptedTarget);
		}
	}, [activeShellTerminalHandleId, selectShellTerminal, setActiveShellTerminal, shellTerminals, terminalTarget]);

	// If the pane is pointed at a shell that is not in THIS session's strip — e.g.
	// after navigating to a different session whose globally-active shell belongs
	// elsewhere — fall back to the session's own pane rather than render a tab
	// that isn't shown here.
	useEffect(() => {
		setTerminalTarget((current) =>
			current.kind === "shell" && !shellTerminals.some((s) => s.handleId === current.handleId)
				? { kind: "worker" }
				: current,
		);
	}, [shellTerminals]);
	// Reviewer selection belongs to the tab, not its replaceable controller.
	// Keep it through switch teardown, then follow the replacement surface.
	useEffect(() => {
		if ((!reviewerChatId && terminalTarget.kind !== "reviewer") || !reviewerQuery.isFetched || reviewerSwitchPending) return;
		if (availableReviewerChat) {
			if (reviewerChatId !== availableReviewerChat.reviewId) selectReviewerChat(availableReviewerChat.reviewId);
		} else if (availableReviewerTerminal) {
			if (terminalTarget.kind !== "reviewer" || terminalTarget.handleId !== availableReviewerTerminal.handleId || terminalTarget.harness !== availableReviewerTerminal.harness) {
				selectReviewerTerminal(availableReviewerTerminal);
			}
		} else {
			selectSessionTerminal();
		}
	}, [availableReviewerChat, availableReviewerTerminal, reviewerChatId, reviewerQuery.isFetched, reviewerSwitchPending, selectReviewerChat, selectReviewerTerminal, selectSessionTerminal, terminalTarget]);
	const isOrchestrator = session ? isOrchestratorSession(session) : false;
	const hasInspector = Boolean(session);
	const sizing = useMemo(() => inspectorSizing(inspectorView), [inspectorView]);
	const browserEntryWidthFloorRef = useRef<number | null>(null);

	// Arm the shared width transition before the selected inspector surface
	// changes its CSS variable. Browser becomes a co-work canvas; utility views
	// return to their stable rail width on the same spring as the shell sidebar.
	const armWorkspaceTransition = useCallback(() => {
		const split = sessionSplitRef.current;
		if (!split) return;
		if (workspaceResizeTimerRef.current !== null) window.clearTimeout(workspaceResizeTimerRef.current);
		split.setAttribute("data-workspace-resizing", "true");
		void split.offsetWidth;
		workspaceResizeTimerRef.current = window.setTimeout(() => {
			split.removeAttribute("data-workspace-resizing");
			workspaceResizeTimerRef.current = null;
		}, INSPECTOR_SPRING_MS);
	}, []);

	useEffect(
		() => () => {
			if (workspaceResizeTimerRef.current !== null) window.clearTimeout(workspaceResizeTimerRef.current);
			sessionSplitRef.current?.removeAttribute("data-workspace-resizing");
		},
		[],
	);

	const prepareWorkspaceProfile = useCallback(
		(nextSizing: InspectorSizing) => {
			armWorkspaceTransition();
			const groupWidth = sessionSplitRef.current?.clientWidth || window.innerWidth;
			const availableWidth = Math.max(0, groupWidth - INSPECTOR_SEPARATOR_RESERVE_PX);
			const targetInspectorWidth = Number.parseFloat(initialInspectorSize(nextSizing, availableWidth));
			startTerminalLiveResize(
				targetInspectorWidth <= INSPECTOR_COMPACT_MAX_PX ? "compact" : "expanded",
				topbarSecondaryLabelMode(Math.max(0, availableWidth - targetInspectorWidth)),
			);
		},
		[armWorkspaceTransition, startTerminalLiveResize],
	);

	const transitionInspectorView = useCallback(
		(next: InspectorView) => {
			if (next === inspectorView) return;
			if (next === "browser") {
				const currentWidth = Number(window.localStorage.getItem(sizing.storageKey));
				browserEntryWidthFloorRef.current = Number.isFinite(currentWidth) ? currentWidth : null;
			} else {
				browserEntryWidthFloorRef.current = null;
			}
			const nextSizing = inspectorSizing(next);
			if (!sizingGeometryEqual(sizing, nextSizing)) prepareWorkspaceProfile(nextSizing);
			setInspectorViewForSession(uiSessionId, next);
		},
		[
			inspectorView,
			prepareWorkspaceProfile,
			uiSessionId,
			setInspectorViewForSession,
			sizing,
		],
	);

	const newTerminalError = openShellTerminal.error ? apiErrorMessage(openShellTerminal.error) : undefined;
	const newShellTerminalAction = useMemo(() =>
		session && !isOrchestrator ? (
			<Tooltip>
				<TooltipTrigger asChild>
					<TopbarButton
						aria-label={t("shortcut.new-shell-terminal")}
						data-terminal-focus-handoff="true"
						onClick={addShellTerminal}
						type="button"
						variant="icon"
					>
						<Plus aria-hidden="true" className="size-icon-md" />
					</TopbarButton>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{newTerminalError ?? t("terminal.newWithShortcut", { shortcut: newTerminalShortcutLabel })}
				</TooltipContent>
			</Tooltip>
		) : null,
		[addShellTerminal, isOrchestrator, newTerminalError, newTerminalShortcutLabel, session, t],
	);
	const fileAnnotation = useFileAnnotation(sessionId, { hostId });
	const centerFileTabs = useMemo(
		() =>
			fileTabs.openPaths.map((path) => ({
				key: `file:${path}`,
				content: (
					<SessionFileTab
						active={fileTabs.activePath === path}
						dirty={Boolean(dirtyFiles[path])}
						onActivate={() => activateCenterFile(path)}
						onClose={() => closeCenterFile(path)}
						path={centerFileRequestsBySession[uiSessionId]?.[path]?.path ?? path}
						sourceLabel={
							centerFileRequestsBySession[uiSessionId]?.[path]?.source?.kind === "snapshot"
								? (centerFileRequestsBySession[uiSessionId]?.[path]?.source as { label?: string })?.label
								: undefined
						}
					/>
				),
				onSelect: () => activateCenterFile(path),
				onClose: () => closeCenterFile(path),
			})),
		[activateCenterFile, closeCenterFile, dirtyFiles, fileTabs.activePath, fileTabs.openPaths, centerFileRequestsBySession, uiSessionId],
	);

	const activeWorkspaceTabKey = fileTabs.activePath ? `file:${fileTabs.activePath}` : undefined;
	const previewUrl = session?.previewUrl?.trim() || undefined;
	const previewRevision = session?.previewRevision;
	const browserSlotVisible = Boolean(
		session &&
			hasInspector &&
			(browserPoppedOut || (inspectorPanelVisible && inspectorView === "browser")),
	);
	useEffect(() => {
		if (hostId && remoteBase && browserSlotVisible) void remoteSessionQuery.refetch();
	}, [hostId, remoteBase, browserSlotVisible, remoteSessionQuery.refetch]);
	const terminated = session ? !sessionIsActive(session) : false;
	// A completed session's HTML artifact is static output the daemon keeps
	// serving, so an artifact preview the user opened stays visible; every other
	// preview of a terminated session is a stale DB fact and is still torn down.
	const browserTerminated = terminated && !(isArtifactPreviewUrl(previewUrl) && !hostId);
	const browserView = useBrowserView({
		sessionId: uiSessionId,
		origin: hostId ? { hostId, sessionId, proxyBase: remoteBase ?? "" } : undefined,
		active: browserSlotVisible,
		poppedOut: browserPoppedOut,
		terminated: browserTerminated,
		previewUrl,
		previewRevision,
	});
	const browserAnnotationQueue = useBrowserAnnotationQueue({
		sessionId: session?.id,
		hostId,
		sourcePreviewUrl: session?.previewUrl,
		navUrl: browserView.navState.url,
	});
	const browserViewId = browserView.viewId;
	useEffect(
		() =>
			window.ao?.browser.onClosePanel((targetViewId) => {
				if (!browserViewId || targetViewId !== browserViewId) return;
				setBrowserPopOutState({ sessionId, phase: "docked" });
				setInspectorOpenForSession(uiSessionId, false);
			}),
		[browserViewId, sessionId, uiSessionId, setInspectorOpenForSession],
	);
	const browserUrl = browserView.navState.url.trim();
	// A terminated session's `previewUrl` is a stale DB fact; useBrowserView
	// suppresses and destroys the live preview for it, so it must not count as
	// content here either — otherwise a merged/terminated session with an old
	// preview auto-opens Browser onto a view the hook has already torn down.
	const hasBrowserContent = !browserTerminated && Boolean(previewUrl || browserUrl);

	// Entering a session for the first time ever always starts on Summary. This
	// must fire exactly once per session's *lifetime*, not once per "was this
	// the last session I looked at" or "is this view currently mounted" — so
	// the initialized flag lives in the ui-store (inspectorSessions[sessionId])
	// rather than a component-local ref, and survives both re-entering a
	// different previously-visited session and unmounting/remounting this view
	// entirely (e.g. across route transitions). Treat browser content that
	// already existed when the route resolved as the baseline for that visit;
	// only preview work arriving afterward may reveal Browser automatically.
	useLayoutEffect(() => {
		if (!session) return;
		if (browserOnly) {
			const current = useUiStore.getState().inspectorSessions[uiSessionId];
			if (!current) setInspectorOpenForSession(uiSessionId, false);
			if (current?.view !== "browser") setInspectorViewForSession(uiSessionId, "browser");
			return;
		}
		initializeInspectorSession(uiSessionId, hasBrowserContent, hasInspector);
	}, [browserOnly, hasBrowserContent, hasInspector, session, uiSessionId, initializeInspectorSession, setInspectorOpenForSession, setInspectorViewForSession]);

	// Keep rejecting another session's shell/reviewer handle here as well, so it
	// can never be cached under the destination session.
	const routedTerminalTarget = terminalTargetBelongsToSession(terminalTarget, sessionId)
		? terminalTarget
		: ({ kind: "worker" } satisfies TerminalTarget);
	// Chat surface stays mounted in chat mode for worker, reviewer, and shell
	// targets. A terminal pane (reviewer or shell) renders as a tab inside the
	// chat surface, so opening one never costs the user the conversation.
	const chatTargetKind = routedTerminalTarget.kind;
	const renderedSessionMode = interfaceUi.renderedMode;
	const showChatSurface =
		session !== undefined &&
		renderedSessionMode === "chat" &&
		(chatTargetKind === "worker" || chatTargetKind === "reviewer" || chatTargetKind === "shell");
	const chatViewActive =
		session?.mode === "chat" &&
		(hostId ? Boolean(remoteBase) : daemonStatus.state === "ready") &&
		routedTerminalTarget.kind === "worker" &&
		(!activeShellTerminalHandleId ||
			(shellTerminalsQuery.data !== undefined &&
				!shellTerminals.some((shell) => shell.handleId === activeShellTerminalHandleId))) &&
		!reviewerChatId &&
		!fileTabs.activePath;
	useEffect(() => {
		if (!chatViewActive) return;
		const viewId = crypto.randomUUID();
		let left = false;
		let refreshed = false;
		let pending = Promise.resolve();
		const setViewActive = async (active: boolean) => {
			try {
				const { error } = await clientForSessionHost(hostId).POST("/api/v1/sessions/{sessionId}/chat-view", {
					params: { path: { sessionId } },
					body: { viewId, active },
				});
				if (error) throw error;
				// Remote conversations already refresh every two seconds.
				if (active && !left && !refreshed && !hostId) {
					refreshed = true;
					void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId, hostId) });
					void queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(hostId) });
				}
			} finally {
				// Release a late registration too; leaving must not wait on wake.
				if (active && left) void setViewActive(false).catch(() => {});
			}
		};
		const renewView = () => {
			pending = pending.catch(() => {}).then(() => {
				return left ? undefined : setViewActive(true);
			});
			return pending;
		};
		const refreshAfterWakeError = () => {
			if (left || hostId) return;
			void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId, hostId) });
		};
		void renewView().catch(refreshAfterWakeError);
		const renewal = window.setInterval(() => { void renewView().catch(refreshAfterWakeError); }, 10_000);
		return () => {
			left = true;
			window.clearInterval(renewal);
			void setViewActive(false).catch(() => {});
		};
	}, [chatViewActive, hostId, queryClient, sessionId]);
	// A local session's tab menu holds the interface switch and, in a terminal, its agent.
	const agentWorking = chatDraftBoundaries.length > 0 || session?.isTerminated === true ||
		session?.activity?.state === "active" || session?.activity?.state === "waiting_input" || session?.activity?.state === "blocked";
	const sessionTabActions = !session
		? null
		: (
			<SessionTabMenu
				key={uiSessionId}
				session={session}
				hostId={hostId}
				blocked={agentWorking}
				switchTarget={interfaceUi.target}
				switchAction={interfaceUi.switchAction}
				switchControl={interfaceUi.switchControl}
			/>
		);
	const sessionHeaderActions = (
		<div
			className="session-topbar-session-chrome flex shrink-0 items-center"
			data-compact-session-chrome="false"
		>
			{hostId ? <span className="max-w-40 truncate px-3 text-xs text-muted-foreground" title={hostId}>{hostLabel ?? hostId}</span> : null}
			<ShellTopbar embedded />
		</div>
	);
	const sessionTabActionWide = false;

	// The pane shows one terminal at a time, so selecting a shell or the reviewer
	// takes the agent's terminal off screen while the route still points here.
	// Publish which one is showing: the notification runtime lives outside this
	// subtree and must not treat "on the session route" as "watching the agent".
	useEffect(() => {
		setVisibleTerminalKind(uiSessionId, reviewerChatId ? "reviewer" : routedTerminalTarget.kind);
		return () => clearVisibleTerminalKind(uiSessionId);
	}, [clearVisibleTerminalKind, reviewerChatId, routedTerminalTarget.kind, uiSessionId, setVisibleTerminalKind]);

	const prepareFilesInspector = useCallback(() => {
		if (browserOnly) return;
		setBrowserPopOutState({ sessionId, phase: "docked" });
		setFilesPoppedOut(false);
		setFilesChangedOnly(uiSessionId, true);
		transitionInspectorView("files");
		setInspectorOpenForSession(uiSessionId, true);
	}, [browserOnly, sessionId, uiSessionId, setFilesChangedOnly, setInspectorOpenForSession, transitionInspectorView]);

	const fetchWorkspaceFiles = useCallback(async () => {
		return queryClient.fetchQuery(
			sessionWorkspaceFilesQueryOptions(sessionId, t("files.error.loadWorkspace"), hostId),
		);
	}, [hostId, queryClient, sessionId, t]);

	const handleOpenArtifact = useCallback(
		(target: { feedback?: boolean; path: string }) => {
			if (browserOnly) return;
			setBrowserPopOutState({ sessionId, phase: "docked" });
			setFilesPoppedOut(false);
			transitionInspectorView("artifacts");
			setInspectorOpenForSession(uiSessionId, true);
			setArtifactRequestsBySession((current) => ({
				...current,
				[uiSessionId]: { feedback: target.feedback, path: target.path, key: (current[uiSessionId]?.key ?? 0) + 1 },
			}));
		},
		[browserOnly, sessionId, setInspectorOpenForSession, transitionInspectorView, uiSessionId],
	);

	// A file written moments ago, or one past the artifact list cap, is not in
	// the cached session, and the Files inspector can only show listed
	// artifacts. Refresh once before deciding it cannot be opened.
	const revealResolvedArtifact = useCallback(
		async (path: string) => {
			if (browserOnly) return false;
			const listed = (artifacts: SessionArtifact[] | undefined) => artifacts?.some((artifact) => artifact.path === path) ?? false;
			if (!listed(session?.artifactFiles)) {
				await refreshWorkspaces();
				const refreshed = queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryKeyForHost(hostId))
					?.flatMap((workspace) => workspace.sessions)
					.find((candidate) => candidate.id === sessionId);
				if (!listed(refreshed?.artifactFiles)) return false;
			}
			handleOpenArtifact({ path });
			return true;
		},
		[browserOnly, handleOpenArtifact, hostId, queryClient, refreshWorkspaces, session?.artifactFiles, sessionId],
	);

	const revealResolvedWorkspaceFile = useCallback(
		async (rawPath: string, options?: FileOpenOptions) => {
			const reference = normalizeWorkspaceFileReference(rawPath);
			if (!isAbsoluteFileReference(reference)) {
				const data = await fetchWorkspaceFiles();
				openCenterFile(matchWorkspaceFilePath(rawPath, data.files ?? []), options);
				return;
			}
			// The renderer is never told where a session's worktree lives, so the
			// daemon decides which root an absolute path belongs to.
			const resolved = await resolveSessionWorkspacePath(sessionId, reference, hostId);
			if (resolved?.kind === "workspace") {
				openCenterFile(resolved.path, options);
				return;
			}
			if (resolved?.kind === "artifact" && await revealResolvedArtifact(resolved.path)) return;
			// Outside the session, or the daemon could not say. Nothing shows the
			// path belongs here, so open it as written and let the file pane say
			// so, rather than a workspace file that happens to share its name.
			openCenterFile(reference, options);
		},
		[fetchWorkspaceFiles, hostId, openCenterFile, revealResolvedArtifact, sessionId],
	);

	const handleOpenFiles = useCallback(() => {
		markFileViewerPerformance("files-click");
		// Opens on the checked-out branch's default review: its uncommitted
		// changes, or its commits when the worktree is clean.
		resetFilesSelection(uiSessionId);
		prepareFilesInspector();
		void fetchWorkspaceFiles();
	}, [fetchWorkspaceFiles, prepareFilesInspector, resetFilesSelection, uiSessionId]);

	const handleOpenReviewFile = useCallback(
		(target: { line?: number; path: string }) => {
			void revealResolvedWorkspaceFile(target.path, { line: target.line, mode: "diff" });
		},
		[revealResolvedWorkspaceFile],
	);

	const handleOpenFile = useCallback(
		(path: string, line?: number) => {
			void revealResolvedWorkspaceFile(path, { line, mode: "file" });
		},
		[revealResolvedWorkspaceFile],
	);

	const handleArtifactRequestConsumed = useCallback((key: number) => {
		setArtifactRequestsBySession((current) => {
			const request = current[uiSessionId];
			if (!request || request.key !== key || !request.feedback) return current;
			return {
				...current,
				[uiSessionId]: { ...request, feedback: undefined },
			};
		});
	}, [uiSessionId]);
	const openArtifactPreview = useOpenArtifactPreview(session?.id, session?.hostId);
	useEffect(() => {
		if (!workspaceFileOpenRequest || !session) return;
		if (sessionUiKey(workspaceFileOpenRequest.sessionId, workspaceFileOpenRequest.hostId) !== uiSessionId) return;
		const { nonce, path, source } = workspaceFileOpenRequest;
		if (source === "artifact") {
			// Same routing as the Summary panel's artifact rows: HTML opens in
			// the Browser panel, everything else in the Artifacts view.
			const artifact = session.artifactFiles?.find((file) => file.path === path);
			if (artifact?.kind === "html" && artifact.previewUrl) openArtifactPreview(artifact.previewUrl);
			else handleOpenArtifact({ path });
		} else {
			handleOpenFile(path);
		}
		clearWorkspaceFileOpenRequest(nonce);
	}, [
		clearWorkspaceFileOpenRequest,
		handleOpenArtifact,
		handleOpenFile,
		openArtifactPreview,
		openCenterFile,
		prepareFilesInspector,
		session,
		uiSessionId,
		workspaceFileOpenRequest,
	]);

	const handleToggleFilesPopOut = useCallback(
		(next: boolean) => {
			if (next) setBrowserPopOutState({ sessionId, phase: "docked" });
			setFilesPoppedOut(next);
			transitionInspectorView("files");
			setInspectorOpenForSession(uiSessionId, true);
		},
		[sessionId, uiSessionId, setInspectorOpenForSession, transitionInspectorView],
	);

	const handleToggleBrowserPopOut = useCallback(
		(next: boolean) => {
			if (next) setFilesPoppedOut(false);
			setBrowserPopOutState((current) => {
				if (next) {
					if (current.sessionId === sessionId && current.phase !== "docked") return current;
					return { sessionId, phase: "mounting" };
				}
				if (current.sessionId !== sessionId || current.phase === "docked") return current;
				return { sessionId, phase: "docked" };
			});
		},
		[sessionId],
	);

	useEffect(() => {
		if (!hasInspector) return;
		const current = useUiStore.getState().inspectorSessions[uiSessionId];
		if (browserOnly) {
			if (terminated && current?.browserUnseen) setBrowserUnseen(uiSessionId, false);
			return;
		}
		if (!hasBrowserContent) {
			if (current?.browserContentRevealed) setBrowserContentRevealed(uiSessionId, false);
			else if (current?.browserUnseen) setBrowserUnseen(uiSessionId, false);
			return;
		}
		if (current?.browserContentRevealed) return;
		setBrowserContentRevealed(uiSessionId, true);
	}, [
		hasBrowserContent,
		browserOnly,
		hasInspector,
		previewRevision,
		uiSessionId,
		setBrowserContentRevealed,
		setBrowserUnseen,
		terminated,
	]);

	const revealBrowserPanel = useCallback(() => {
		setBrowserContentRevealed(uiSessionId, true);
		setBrowserUnseen(uiSessionId, false);
		if (browserIsVisible(uiSessionId, browserPoppedOut)) return;
		setFilesPoppedOut(false);
		transitionInspectorView("browser");
		setInspectorOpenForSession(uiSessionId, true);
	}, [browserPoppedOut, uiSessionId, setBrowserContentRevealed, setBrowserUnseen, transitionInspectorView, setInspectorOpenForSession]);

	useEffect(() => {
		if (!hasInspector) return;
		const previewKey = previewRevealKey(previewUrl, previewRevision);
		const baseline = previewBaselineRef.current;
		if (!baseline || baseline.sessionId !== uiSessionId) {
			previewBaselineRef.current = { sessionId: uiSessionId, key: previewKey };
			return;
		}
		if (baseline.key === previewKey) return;
		previewBaselineRef.current = { sessionId: uiSessionId, key: previewKey };
		if (!previewKey || terminated) return;
		// Only the routed session mounts SessionView. A new explicit preview
		// reveals its panel; entering a session with an existing target does not.
		revealBrowserPanel();
	}, [
		hasInspector,
		previewRevision,
		previewUrl,
		uiSessionId,
		terminated,
		revealBrowserPanel,
	]);

	// Explicit open commands reveal once per command. A fast command's start
	// and finish can share a React render, so either event can consume its ID.
	// Later completion and UI changes must not override a user's close.
	useEffect(() => {
		if (revealedBrowserCommandsRef.current.sessionId !== uiSessionId) {
			revealedBrowserCommandsRef.current = { sessionId: uiSessionId, commands: new Set() };
		}
		if (!hasInspector || terminated) return;
		const activity = browserView.agentBrowserActivity;
		if (activity && BROWSER_REVEAL_ACTIONS.has(activity.action)) {
			if (!activity.commandId || activity.viewId !== browserView.viewId) return;
			const commands = revealedBrowserCommandsRef.current.commands;
			if (commands.has(activity.commandId)) return;
			commands.add(activity.commandId);
			// Bound deduplication memory while retaining recent overlapping commands.
			if (commands.size > 64) commands.delete(commands.values().next().value!);
			revealBrowserPanel();
			return;
		}
		if (!browserView.agentBrowserActive) return;
		if (browserOnly && !useUiStore.getState().inspectorSessions[uiSessionId]?.browserContentRevealed) {
			setBrowserContentRevealed(uiSessionId, true);
			setInspectorOpenForSession(uiSessionId, true);
			return;
		}
		if (!browserIsVisible(uiSessionId, browserPoppedOut)) setBrowserUnseen(uiSessionId, true);
	}, [
		browserPoppedOut,
		browserView.agentBrowserActive,
		browserView.agentBrowserActivity,
		browserView.viewId,
		hasInspector,
		inspectorView,
		isInspectorOpen,
		uiSessionId,
		setBrowserUnseen,
		terminated,
		browserOnly,
		setBrowserContentRevealed,
		setInspectorOpenForSession,
		revealBrowserPanel,
	]);

	// Opening Browser consumes the pending activity indicator, including the
	// case where the inspector was collapsed while already parked on Browser.
	useEffect(() => {
		if (hasInspector && browserIsVisible(uiSessionId, browserPoppedOut)) {
			setBrowserUnseen(uiSessionId, false);
		}
	}, [browserPoppedOut, hasInspector, inspectorView, isInspectorOpen, uiSessionId, setBrowserUnseen]);

	const handleToggleInspector = useCallback(() => {
		if (browserOnly) setBrowserContentRevealed(uiSessionId, true);
		toggleInspector(uiSessionId);
	}, [browserOnly, uiSessionId, toggleInspector, setBrowserContentRevealed]);

	// Keyboard commands scoped to the session on screen. The main process matches
	// the chord (see main/app-shortcuts.ts), so these also work from xterm and the
	// native Browser view.
	useSessionShortcut("toggle-inspector", handleToggleInspector, hasInspector);
	useSessionShortcut(
		"toggle-diff",
		() => {
			if (browserOnly) return;
			const showingDiff =
				isInspectorOpen &&
				inspectorView === "files" &&
				(useUiStore.getState().inspectorSessions[uiSessionId]?.filesChangedOnly ?? true);
			if (showingDiff) setInspectorOpenForSession(uiSessionId, false);
			else prepareFilesInspector();
		},
		hasInspector,
	);
	useSessionShortcut(
		"toggle-terminal",
		() => {
			if (terminalTarget.kind === "shell") {
				selectSessionTerminal();
				focusAfterPaint("[aria-label='Message the agent']");
				return;
			}
			const shell = shellTerminals[shellTerminals.length - 1];
			if (shell) selectShellTerminal(shell.handleId);
			else if (!isOrchestrator) addShellTerminal();
			focusAfterPaint(".xterm-helper-textarea");
		},
		hasInspector,
	);
	useSessionShortcut(
		"reopen-closed-tab",
		() => {
			const path = closedFilePathsRef.current[uiSessionId]?.pop();
			if (path) {const request=centerFileRequestsBySession[uiSessionId]?.[path];openCenterFile(request?.path ?? path, { ...request, editing:false, mode: "file" });}
		},
		hasInspector,
	);
	useSessionShortcut(
		"copy-session-path",
		() => {
			if (!session || hostId) return;
			aoBridge.editorHandoff.copyWorkspacePath(sessionId).then(
				() => showGlobalToast(t("shortcut.sessionPathCopied")),
				(error: unknown) =>
					showGlobalToast(t("shortcut.sessionPathCopyFailed"), error instanceof Error ? error.message : undefined, "error"),
			);
		},
		hasInspector,
	);
	useSessionShortcut(
		"model-picker",
		() => {
			const picker = document.querySelector<HTMLElement>("[data-shortcut-target='model-picker']:not([disabled])");
			if (!picker) return;
			// Radix menu triggers open on pointerdown or Enter, never on a synthetic click.
			picker.dataset.shortcutOpened = "";
			picker.focus();
			picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		},
		hasInspector,
	);

	const inspectorMotionReadyRef = useRef<string | null>(null);
	const handleInspectorCloseAnimationComplete = useCallback(() => {
		setInspectorSettledClosed(true);
	}, []);
	useLayoutEffect(() => {
		if (!hasInspector) {
			setInspectorSettledClosed(true);
			stopTerminalLiveResize();
			return;
		}
		if (inspectorMotionReadyRef.current !== uiSessionId) {
			setInspectorSettledClosed(!isInspectorOpen);
			stopTerminalLiveResize();
			if (workspaceResizeTimerRef.current !== null) window.clearTimeout(workspaceResizeTimerRef.current);
			workspaceResizeTimerRef.current = null;
			sessionSplitRef.current?.removeAttribute("data-workspace-resizing");
			browserEntryWidthFloorRef.current = null;
		}
	}, [hasInspector, isInspectorOpen, uiSessionId, stopTerminalLiveResize]);
	useEffect(() => {
		if (!hasInspector || inspectorMotionReadyRef.current !== uiSessionId) return;
		if (isInspectorOpen) {
			setInspectorSettledClosed(false);
			const groupWidth = sessionSplitRef.current?.clientWidth || window.innerWidth;
			const availableWidth = Math.max(0, groupWidth - INSPECTOR_SEPARATOR_RESERVE_PX);
			const targetInspectorWidth = Number.parseFloat(initialInspectorSize(sizing, availableWidth));
			startTerminalLiveResize(
				targetInspectorWidth <= INSPECTOR_COMPACT_MAX_PX ? "compact" : "expanded",
				topbarSecondaryLabelMode(Math.max(0, availableWidth - targetInspectorWidth)),
			);
			return;
		}
		const groupWidth = sessionSplitRef.current?.clientWidth || window.innerWidth;
		startTerminalLiveResize("expanded", topbarSecondaryLabelMode(groupWidth));
	}, [hasInspector, isInspectorOpen, uiSessionId, sizing, startTerminalLiveResize]);
	useEffect(() => {
		if (!hasInspector) {
			inspectorMotionReadyRef.current = null;
			return;
		}
		inspectorMotionReadyRef.current = uiSessionId;
		return () => {
			inspectorMotionReadyRef.current = null;
		};
	}, [hasInspector, uiSessionId]);
	if (!session && (hostId ? !remoteSessionQuery.isLoading : !workspaceQuery.isLoading && !workspaceSessionQuery.isLoading)) {
		const remoteCode = hostId && remoteSessionQuery.error ? apiErrorCode(remoteSessionQuery.error) : undefined;
		const remoteError = hostId ? t(remoteCode === "BAD_PASSWORD" ? "remote.hostUnauthorized"
			: remoteCode === "HOST_API_INCOMPATIBLE" ? "remote.hostIncompatible"
			: !remoteBase || remoteCode === "UPSTREAM_UNAVAILABLE" || remoteCode === "HOST_IDENTITY_UNVERIFIED"
				? "remote.hostOffline" : remoteSessionQuery.isError ? "remote.loadSessionFailed" : "session.notFound") : undefined;
		return (
			<div className="grid h-full place-items-center p-6 text-center font-mono text-xs text-passive" role={remoteError ? "alert" : undefined}>
				{remoteError ?? t("session.notFound")}
			</div>
		);
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="session-detail">
			{!hostId && session?.mode !== "chat" && sessionAgentExited(session) && autoResume.variables === sessionId && autoResume.isError ? (
				<p className="px-4 py-2 text-xs text-error" role="alert">
					{apiErrorMessage(autoResume.error)}
				</p>
			) : null}
			<div
				className="session-split relative flex min-h-0 flex-1 overflow-hidden"
				data-testid="panel-group"
				data-workspace-mode={sizing.mode}
				id="session-workspace"
				ref={sessionSplitRef}
				style={
					{
						"--session-inspector-max-width": inspectorMaxWidthCss(
							sizing.maxPercent,
							sizing.chatMinWidth,
						),
						"--session-inspector-motion-duration": `${INSPECTOR_SPRING_MS}ms`,
						"--session-inspector-motion-easing": INSPECTOR_SPRING_EASING,
					} as CSSProperties
				}
			>
				<div
					className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
					data-panel=""
					id="terminal"
				>
					<div className="relative flex h-full min-h-0 flex-col">
						<SessionTopbarHost
							className="relative z-chrome flex h-inspector-tabs w-full shrink-0 overflow-hidden"
							data-testid="session-topbar-host"
						/>
						<div className="relative min-h-0 flex-1">
							{/* The committed mode owns the agent surface. Auxiliary shell and
							    reviewer targets remain terminal surfaces in either mode. */}
							<div
								className={cn("h-full min-h-0", fileTabs.activePath && "invisible pointer-events-none")}
								inert={fileTabs.activePath ? true : undefined}
							>
							{showChatSurface ? (
								<>
								<SessionChatSurface
									sideChatContainer={sideChatContainer}
									key={uiSessionId}
									assetBaseUrl={remoteBase}
									hostId={hostId}
									session={session}
									reviewerTerminal={reviewerTerminal}
									reviewerChat={reviewerChat}
									reviewerChatSelected={Boolean(reviewerChatId)}
									onOpenReviewerTerminal={selectReviewerTerminal}
									onOpenReviewerChat={(target) => selectReviewerChat(target.reviewId)}
									onSessionRenamed={refreshWorkspaces}
									reviewerTarget={
										routedTerminalTarget.kind === "reviewer" ? routedTerminalTarget : undefined
									}
									onSelectChat={selectSessionTerminal}
									shellTerminals={shellTerminals}
									shellTarget={
										routedTerminalTarget.kind === "shell" ? routedTerminalTarget : undefined
									}
									onSelectShellTerminal={selectShellTerminal}
									onCloseShellTerminal={closeShellTerminalByHandle}
									onRenameShellTerminal={renameShellTerminalByHandle}
									daemonReady={hostId ? Boolean(remoteBase) : daemonStatus.state === "ready"}
									theme={theme}
									headerActions={sessionHeaderActions}
									sessionTabAction={sessionTabActions}
									sessionTabActionWide={sessionTabActionWide}
									tabStripAction={newShellTerminalAction}
									workspaceTabs={centerFileTabs}
									workspaceActiveTabKey={activeWorkspaceTabKey}
									workspaceFileActive={Boolean(fileTabs.activePath)}
									auxiliaryTabOrder={resolvedAuxiliaryTabOrder}
									onAuxiliaryTabOrderChange={setAuxiliaryTabOrder}
									controllerResumeError={!hostId && autoResume.variables === sessionId && autoResume.isError
										? apiErrorMessage(autoResume.error) : undefined}
									controllerTransitioning={interfaceUi.controllerTransitioning}
									accountMoving={Boolean(interfaceUi.accountMoveTarget)}
									arriving={interfaceUi.optimisticTarget === "chat"}
									agentResuming={quietResume}
									newWorkDisabled={interfaceUi.newWorkDisabled}
									onConversationWorkChange={interfaceUi.onConversationWorkChange}
									interfaceSwitch={{ control: interfaceUi.switchControl, errorNotice: interfaceUi.switchErrorNotice }}
									onOpenShell={addShellTerminal}
									openingShell={openShellTerminal.isPending}
									shellError={
										openShellTerminal.error ? apiErrorMessage(openShellTerminal.error) : undefined
									}
									onOpenFiles={browserOnly ? undefined : handleOpenFiles}
									onOpenFile={handleOpenFile}
									onOpenLinkInBrowser={browserView.openLink}
								/>
								{reviewerChatId ? (
									<div className="absolute inset-0">
										<ReviewerChatSurface hideHeader hostId={hostId} workerSessionId={sessionId} reviewId={reviewerChatId} />
									</div>
								) : null}
								</>
							) : (
								<CenterPane
									hostId={hostId}
									agentInputDisabled={interfaceUi.agentInputDisabled}
									terminalBooting={interfaceUi.optimisticTarget === "tui"}
									terminalSwitchingLabel={accountSwitchingLabel}
									daemonReady={hostId ? Boolean(remoteBase) : daemonStatus.state === "ready"}
									onCloseShellTerminal={closeShellTerminalByHandle}
									onRenameShellTerminal={renameShellTerminalByHandle}
									onSelectSessionTerminal={selectSessionTerminal}
									onSelectReviewerTerminal={selectReviewerTerminal}
									onSelectReviewerChat={(target) => selectReviewerChat(target.reviewId)}
									onSelectShellTerminal={selectShellTerminal}
									reviewerTerminal={reviewerTerminal}
									reviewerChat={reviewerChat}
									reviewerChatSelected={Boolean(reviewerChatId)}
									reviewerChatContent={reviewerChatId ? <ReviewerChatSurface hideHeader hostId={hostId} workerSessionId={sessionId} reviewId={reviewerChatId} /> : undefined}
									session={session}
									shellTerminals={shellTerminals}
									terminalTarget={routedTerminalTarget}
									theme={theme}
									topbarActions={sessionHeaderActions}
									sessionTabAction={sessionTabActions}
									sessionTabActionWide={sessionTabActionWide}
									tabStripAction={newShellTerminalAction}
									workspaceTabs={centerFileTabs}
									workspaceActiveTabKey={activeWorkspaceTabKey}
									auxiliaryTabOrder={resolvedAuxiliaryTabOrder}
									onAuxiliaryTabOrderChange={setAuxiliaryTabOrder}
								/>
							)}
							</div>
							{fileTabs.openPaths.length > 0 ? (
								<div className={cn("absolute inset-0",!fileTabs.activePath && "invisible pointer-events-none")} inert={!fileTabs.activePath ? true:undefined}>
										<>
											{fileTabs.openPaths.map((fileKey) => {
												const request = centerFileRequestsBySession[uiSessionId]?.[fileKey];
												const token = request ? `${uiSessionId}:${fileKey}:${request.key}` : "";
												return (
													<div
														key={fileKey}
														className={cn("absolute inset-0", fileTabs.activePath !== fileKey && "invisible pointer-events-none")}
														inert={fileTabs.activePath !== fileKey ? true : undefined}
													>
														<SessionFileWorkspace
															active={fileTabs.activePath === fileKey && !filesPoppedOut}
															fileKey={fileKey}
															hostId={hostId}
															source={request?.source}
															previousPath={request?.previousPath}
															annotation={fileAnnotation}
															commitSha={request?.commitSha}
															initialEditing={Boolean(request?.editing && !consumedCenterEditingRequestsRef.current.has(token))}
															initialLine={request?.line != null && !consumedCenterLineRequestsRef.current.has(token) ? request.line : undefined}
															initialMode={request?.mode ?? "file"}
															initialRequestKey={request?.key ?? 0}
															onDirtyChange={setCenterFileDirty}
															onInitialEditingConsumed={markCenterFileEditingConsumed}
															onInitialLineConsumed={markCenterFileLineConsumed}
															path={request?.path ?? fileKey}
															sessionId={sessionId}
															split={filesSplit}
															scope={request?.scope}
														/>
													</div>
												);
											})}
										</>
								</div>
							) : null}
							{interfaceUi.notice}
						</div>
					</div>
				</div>
				{hasInspector ? (
					<SessionInspectorRail
						sessionKey={uiSessionId}
						showCollapsedHandle={!browserOnly}
						isOpen={isInspectorOpen}
						onCloseAnimationComplete={handleInspectorCloseAnimationComplete}
						onExpand={() => setInspectorOpenForSession(uiSessionId, true)}
						restoreMinWidth={
							sizing.mode === "browser" ? (browserEntryWidthFloorRef.current ?? undefined) : undefined
						}
						sizing={sizing}
						settledClosed={!isInspectorOpen && inspectorSettledClosed}
						splitRef={sessionSplitRef}
					>
						<SessionInspector
							sideChatView={sideChatsAvailable ? <div ref={setSideChatContainer} className="h-full min-h-0 flex-1" /> : undefined}
							hostId={hostId}
							browserOnly={browserOnly}
							browserAnnotationQueue={inspectorView === "browser" ? browserAnnotationQueue : undefined}
							browserPoppedOut={browserPoppedOut}
							filesView={
								inspectorView === "files" && session ? (
										<SessionFileExplorer
											hostId={hostId}
											onOpenFile={openCenterFile}
											onSplitChange={setFilesSplit}
											onToggleMaximized={handleToggleFilesPopOut}
											checkedOutBranch={session.branch}
											projectKind={filesKind}
											sessionId={session.id}
											split={filesSplit}
										/>
								) : null
							}
							isInspectorVisible={inspectorPanelVisible}
							artifactRequest={artifactRequestsBySession[uiSessionId] ?? null}
							onArtifactRequestConsumed={handleArtifactRequestConsumed}
							onOpenArtifact={browserOnly ? undefined : handleOpenArtifact}
							onOpenFiles={browserOnly ? undefined : handleOpenFiles}
							onOpenReviewFile={handleOpenReviewFile}
							onOpenReviewerTerminal={selectReviewerTerminal}
							onOpenReviewerChat={selectReviewerChat}
							onWorkerMessageSent={showChatSurface || reviewerChatId ? selectSessionTerminal : undefined}
							onToggleBrowserPopOut={handleToggleBrowserPopOut}
							onViewChange={transitionInspectorView}
							view={inspectorView}
							browserView={hostId || inspectorView === "browser" ? browserView : undefined}
							session={session}
						/>
					</SessionInspectorRail>
				) : null}
			</div>
			{hasInspector ? (
				<div className="session-pinned-actions" data-testid="session-pinned-actions" style={noDragStyle}>
					<Tooltip>
						<TooltipTrigger asChild>
							<TopbarButton
								aria-label={
									browserOnly
										? `${isInspectorOpen ? t("common.close") : t("inspector.open")} ${t("inspector.browser")}`
										: isInspectorOpen ? t("shell.closeInspector") : t("shell.openInspector")
								}
								aria-pressed={isInspectorOpen}
								onClick={handleToggleInspector}
								style={noDragStyle}
								variant="icon"
							>
								{browserOnly ? (
									<span className="relative inline-flex">
										<Globe2 aria-hidden="true" className="size-icon-md" />
										{!isInspectorOpen && browserUnseen ? (
											<span
												aria-hidden="true"
												className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
												data-testid="orchestrator-browser-unseen-indicator"
											/>
										) : null}
									</span>
								) : (
									<PanelRight className="size-icon-md" aria-hidden="true" />
								)}
							</TopbarButton>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{browserOnly
								? `${isInspectorOpen ? t("common.close") : t("inspector.open")} ${t("inspector.browser")}`
								: isInspectorOpen ? t("shell.closeInspectorTitle") : t("shell.openInspectorTitle")}
						</TooltipContent>
					</Tooltip>
					{/* Keep the global notification action trailing at the window edge. */}
					<NotificationCenter style={noDragStyle} />
				</div>
			) : null}
			{interfaceUi.dialogs}
			{/* Maximized files wear the maximized browser's chrome: a backdrop, the
          filter pinned in the titlebar band where the browser's address bar
          sits, and an inset frame for the explorer. The explorer mounts once
          the band exists so the filter never renders inline first. */}
			{filesPoppedOut && session
				? createPortal(
						<SessionFilesPopOut onClose={() => handleToggleFilesPopOut(false)}>{(topbarHost) =>
							<FilesTopbarHostContext.Provider value={topbarHost}>
									<SessionFileExplorer
 onOpenFile={openCenterFile}
										hostId={hostId}
										isMaximized
										onSplitChange={setFilesSplit}
										onToggleMaximized={handleToggleFilesPopOut}
										checkedOutBranch={session.branch}
										projectKind={filesKind}
										sessionId={session.id}
										split={filesSplit}
									/>
							</FilesTopbarHostContext.Provider>
						}</SessionFilesPopOut>,
						document.body,
					)
				: null}
			{/* Maximized browser: a fixed overlay across the app workspace,
          portaled to <body> so it escapes the shell layout (covering the
          sidebar + topbar, not just the session area) and sits outside any
          `[data-panel]` column, so the native WebContentsView is not clamped
          and fills the window below any native titlebar overlay. */}
			{browserPopOutMounted && session
				? createPortal(
						<SessionBrowserPopOut onClose={() => handleToggleBrowserPopOut(false)} onTopbarHost={setBrowserPopoutTopbarHost} phase={browserPopOutPhase === "open" ? "open" : "mounting"}>
								{browserPoppedOut && browserPopoutTopbarHost ? <BrowserPanelView
									active
									annotationQueue={browserAnnotationQueue}
									browserView={browserView}
									onTogglePopOut={handleToggleBrowserPopOut}
									poppedOut
									session={session}
									topbarHost={browserPopoutTopbarHost}
								/> : null}
						</SessionBrowserPopOut>,
						document.body,
					)
				: null}
		</div>
	);
}
