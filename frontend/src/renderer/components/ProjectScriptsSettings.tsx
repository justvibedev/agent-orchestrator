import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProjectSettingsSection } from "@aoagents/product-ui";
import type { components } from "../../api/schema";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { clearTerminateSessionState } from "../hooks/useTerminateSession";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import {
	DEFAULT_SETUP_STEP_TIMEOUT_MINUTES, MAX_SCRIPT_STEP_TIMEOUT_MINUTES, MIN_SCRIPT_STEP_TIMEOUT_MINUTES, parseLocalScriptStep,
	scriptStepTimeoutMinutes, serializeLocalScriptStep, type ScriptStepDraft,
} from "../lib/script-steps";
import { cn } from "../lib/utils";
import { SettingsSaveFooter } from "./settings/SettingsSaveFooter";
import type { ProjectSettingsSaveState } from "./ProjectSettingsForm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type Project = components["schemas"]["Project"];
type ScriptKind = "setup" | "cleanup";

export function ProjectScriptsSettings({ projectId, onSaveState }: { projectId: string; onSaveState?: (state: ProjectSettingsSaveState) => void }) {
	const { t } = useTranslation();
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["project", projectId],
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/projects/{id}", { params: { path: { id: projectId } } });
			if (error) throw new Error(apiErrorMessage(error));
			if (data?.status !== "ok") throw new Error(t("settings.project.degraded"));
			return data.project as Project;
		},
	});
	if (query.isLoading) return <p className="px-(--settings-row-inset) text-sm text-settings-muted">{t("settings.project.loading")}</p>;
	if (query.isError || !query.data) return <p role="alert" className="px-(--settings-row-inset) text-sm text-error">{query.error instanceof Error ? query.error.message : t("settings.project.loadFailed")}</p>;
	const project = query.data;
	const scratch = project.kind === "scratch";
	const save = async (steps: ScriptSteps) => {
		// A local step always runs in the project's own workspace; its own time
		// limit is stored with it.
		const scripts = {
			postCreate: steps.postCreate.map(serializeLocalScriptStep),
			...(steps.preRemove && { preRemove: steps.preRemove.map(serializeLocalScriptStep) }),
		};
		const current = await apiClient.GET("/api/v1/projects/{id}", { params: { path: { id: project.id } } });
		if (current.error) throw new Error(apiErrorMessage(current.error));
		if (current.data?.status !== "ok" || !current.data.project) throw new Error(t("settings.project.degraded"));
		const latest = current.data.project as Project;
		const { error } = await apiClient.PUT("/api/v1/projects/{id}", {
			params: { path: { id: project.id } },
			body: { displayName: latest.name, config: { ...latest.config, ...scripts } },
		});
		if (error) throw new Error(apiErrorMessage(error));
	};
	return <ScriptsEditor key={projectId} projectId={project.id} scratch={scratch} postCreate={localSteps(project.config?.postCreate)} preRemove={localSteps(project.config?.preRemove)}
		save={save} onSaveState={onSaveState} onSaved={() => {
			void client.invalidateQueries({ queryKey: ["project", projectId] });
			void client.invalidateQueries({ queryKey: workspaceQueryKey });
		}} />;
}

type ScriptSteps = { postCreate: ScriptStepDraft[]; preRemove?: ScriptStepDraft[] };

function localSteps(commands: string[] | undefined): ScriptStepDraft[] | undefined {
	return commands?.map(parseLocalScriptStep);
}

const emptyStep = (): ScriptStepDraft => ({ command: "", folder: "", timeout: "" });

/**
 * A step whose time limit keeps the form from saving: one with a command (an
 * empty step is dropped on save) and a limit that is not 1 to 120 minutes.
 */
const stepTimeoutInvalid = (step: ScriptStepDraft) => step.command.trim() !== "" && scriptStepTimeoutMinutes(step.timeout) === null;

/**
 * A step's own time limit: a compact minutes field beside the step's other
 * controls. Empty is the default (placeholder); a value outside 1 to 120 is
 * marked invalid at once and keeps the form from saving. Its hint (the range
 * and what empty means) shows in a tooltip on hover and keyboard focus, beside
 * the field, and is the field's description.
 */
function StepTimeoutField({ id, number, value, disabled, invalid, defaultMinutes, onChange }: {
	id: string;
	number: number;
	value: string;
	disabled: boolean;
	/** The form will not save this limit (see stepTimeoutInvalid). */
	invalid: boolean;
	/** The limit an empty field means; undefined (Cleanup of a local project) is no limit at all. */
	defaultMinutes: number | undefined;
	onChange: (value: string) => void;
}) {
	const { t } = useTranslation();
	const noDefault = defaultMinutes === undefined;
	const hintId = `${id}-hint`;
	const hint = noDefault
		? t("settings.project.stepTimeoutNoLimitHint", { min: MIN_SCRIPT_STEP_TIMEOUT_MINUTES, max: MAX_SCRIPT_STEP_TIMEOUT_MINUTES })
		: t("settings.project.stepTimeoutHint", { min: MIN_SCRIPT_STEP_TIMEOUT_MINUTES, max: MAX_SCRIPT_STEP_TIMEOUT_MINUTES, default: defaultMinutes });
	// "none" in the field stands for no limit, not a number of minutes; the unit
	// keeps its room so the row does not shift once a number is typed.
	const showsNoLimit = noDefault && value === "";
	return <label className="flex shrink-0 items-center gap-1 text-xs text-settings-muted" htmlFor={id}>
		<Tooltip>
			<TooltipTrigger asChild>
				<Input
					aria-describedby={hintId}
					aria-invalid={invalid || undefined}
					aria-label={t("settings.project.stepTimeout", { number })}
					autoComplete="off"
					// A no-limit field is wider: its placeholder is a word ("none").
					className={cn("h-7 px-2 text-right text-xs tabular-nums", noDefault ? "w-16" : "w-12")}
					disabled={disabled}
					id={id}
					inputMode="numeric"
					maxLength={3}
					onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
					onKeyDown={(event) => {
						if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
						event.preventDefault();
						const current = scriptStepTimeoutMinutes(value) ?? (defaultMinutes ?? 0);
						const step = event.shiftKey ? 10 : 1;
						const next = event.key === "ArrowUp" ? current + step : current - step;
						onChange(String(Math.min(MAX_SCRIPT_STEP_TIMEOUT_MINUTES, Math.max(MIN_SCRIPT_STEP_TIMEOUT_MINUTES, next))));
					}}
					placeholder={noDefault ? t("settings.project.stepTimeoutNoLimitPlaceholder") : String(defaultMinutes)}
					value={value}
				/>
			</TooltipTrigger>
			{/* Beside the field: above it, it covered the end of the Scripts
			    description, and below it, the step's command. */}
			<TooltipContent side="left" className="max-w-64">{hint}</TooltipContent>
		</Tooltip>
		<span aria-hidden="true" className={cn(showsNoLimit && "invisible")}>{t("settings.project.stepTimeoutUnit")}</span>
		<span className="sr-only" id={hintId}>{hint}</span>
	</label>;
}

function ScriptsEditor({ projectId, scratch, postCreate, preRemove, save, onSaveState, onSaved }: {
	/** The project, for retrying its cleanup. */
	projectId?: string;
	scratch: boolean;
	postCreate?: ScriptStepDraft[];
	preRemove?: ScriptStepDraft[];
	save: (scripts: ScriptSteps) => Promise<void>;
	onSaveState?: (state: ProjectSettingsSaveState) => void;
	onSaved: () => void;
}) {
	const { t } = useTranslation();
	const client = useQueryClient();
	const [activeTab, setActiveTab] = useState<ScriptKind>("setup");
	const [drafts, setDrafts] = useState<Record<ScriptKind, ScriptStepDraft[]>>(() => ({
		setup: postCreate?.length ? postCreate.map((step) => ({ ...step })) : [emptyStep()],
		cleanup: preRemove?.length ? preRemove.map((step) => ({ ...step })) : [emptyStep()],
	}));
	const kept = (steps: ScriptStepDraft[]) => steps.filter((step) => step.command.trim()).map((step) => ({ command: step.command, folder: step.folder, timeout: (step.timeout ?? "").trim() }));
	const commands: ScriptSteps = {
		postCreate: kept(drafts.setup),
		...(!scratch && { preRemove: kept(drafts.cleanup) }),
	};
	// The first step whose time limit is not a whole number of minutes in range.
	const invalidTimeout = (["setup", "cleanup"] as const).flatMap((kind) => kind === "cleanup" && scratch ? [] : drafts[kind]
		.map((step, index) => ({ kind, number: index + 1, invalid: stepTimeoutInvalid(step) })))
		.find((step) => step.invalid);
	const timeoutError = invalidTimeout ? t("settings.project.stepTimeoutInvalid", {
		phase: t(invalidTimeout.kind === "setup" ? "settings.project.scriptSetup" : "settings.project.scriptCleanup"),
		number: invalidTimeout.number, min: MIN_SCRIPT_STEP_TIMEOUT_MINUTES, max: MAX_SCRIPT_STEP_TIMEOUT_MINUTES,
	}) : undefined;
	const [saved, setSaved] = useState(() => JSON.stringify(commands));
	const [savedAt, setSavedAt] = useState(false);
	const dirty = JSON.stringify(commands) !== saved;
	const mutation = useMutation({
		mutationFn: async (scripts: ScriptSteps) => {
			await save(scripts);
			return scripts;
		},
		onSuccess: (scripts) => { setSaved(JSON.stringify(scripts)); setSavedAt(true); onSaved(); },
	});
	const retry = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/sessions/cleanup", { params: { query: { project: projectId ?? "" } } });
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: (result) => {
			for (const sessionId of [...result.cleaned, ...result.alreadyGone]) clearTerminateSessionState(client, sessionId);
			onSaved();
		},
	});
	useEffect(() => {
		onSaveState?.({
			// This form saves only on "Save changes", so unsaved edits are reported as
			// dirty but never as the autosave "pending" phase, which the settings
			// sidebar shows as an endless "Saving" spinner.
			phase: mutation.isError ? "failed" : mutation.isPending ? "saving" : savedAt && !dirty ? "saved" : "idle",
			dirty,
			requestPending: mutation.isPending,
			error: mutation.error instanceof Error ? mutation.error.message : undefined,
		});
	}, [dirty, mutation.error, mutation.isError, mutation.isPending, onSaveState, savedAt]);
	const locked = mutation.isPending || retry.isPending;
	const updateSteps = (kind: ScriptKind, steps: ScriptStepDraft[]) => {
		setDrafts((current) => ({ ...current, [kind]: steps }));
		setSavedAt(false);
	};
	return <form id="project-settings-form" className="flex min-h-full shrink-0 flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!timeoutError) mutation.mutate(commands); }}>
		<Tabs className="flex flex-1 flex-col gap-3" value={activeTab} onValueChange={(value) => setActiveTab(value as ScriptKind)}>
			<TabsList aria-label={t("settings.project.scripts")} className="shrink-0 self-start">
				<TabsTrigger value="setup">{t("settings.project.scriptSetup")}</TabsTrigger>
				<TabsTrigger value="cleanup">{t("settings.project.scriptCleanup")}</TabsTrigger>
			</TabsList>
			{(["setup", "cleanup"] as const).map((kind) => <TabsContent key={kind} value={kind}>
				{kind === "cleanup" && scratch ? <p className="px-(--settings-row-inset) text-sm text-settings-muted">{t("settings.project.cleanupScratchUnavailable")}</p> : <ProjectSettingsSection title={t(kind === "setup" ? "settings.project.scriptSetup" : "settings.project.scriptCleanup")} titleHidden grouped>
					<div className="settings-content-row flex flex-col gap-4">
						<div className="space-y-1 text-pretty text-xs leading-4 text-settings-muted">
							<p>{t(kind === "setup" ? scratch ? "settings.project.setupHintScratch" : "settings.project.setupHintGit" : "settings.project.cleanupHint")}</p>
							<p>{t(`settings.project.${kind}ShellHint`)}</p>
							<p>{t("settings.project.setupPlatformHint")}</p>
						</div>
						{!scratch && <details className="text-xs text-settings-muted">
							<summary className="cursor-pointer font-medium text-settings-label">{t(`settings.project.${kind}Paths`)}</summary>
							{/* The page is unselectable by default; these names are meant to be copied into a step. */}
							<div className="mt-2 select-text space-y-1">
								<p><code>{"AO_SOURCE_TREE_PATH"}</code>: {t(`settings.project.${kind}SourcePath`)}</p>
								<p><code>{"AO_WORKTREE_PATH"}</code>: {t(`settings.project.${kind}WorktreePath`)}</p>
							</div>
						</details>}
						{/* One provider for the list's time limit tooltips, so moving from one
						    field to the next shows its tooltip at once. */}
						<TooltipProvider><div className="space-y-4">
							{drafts[kind].map((step, index) => <div key={index}>
								<div className="mb-1 flex items-center justify-between gap-2">
									<label className="text-sm font-medium text-settings-label" htmlFor={`${kind}-step-${index}`}>{t(`settings.project.${kind}Step`, { number: index + 1 })}</label>
									<div className="flex min-w-0 items-center gap-1">
										<StepTimeoutField
											disabled={locked}
											id={`${kind}-step-${index}-timeout`}
											invalid={stepTimeoutInvalid(step)}
											defaultMinutes={kind === "setup" ? DEFAULT_SETUP_STEP_TIMEOUT_MINUTES : undefined}
											number={index + 1}
											value={step.timeout ?? ""}
											onChange={(timeout) => updateSteps(kind, drafts[kind].map((item, i) => i === index ? { ...item, timeout } : item))}
										/>
										<button aria-label={t(kind === "setup" ? "settings.project.removeSetupStep" : "settings.project.removeCleanupStep", { number: index + 1 })} className="rounded p-1 text-settings-muted hover:text-error focus-visible:ring-2 focus-visible:ring-ring" disabled={locked} onClick={() => updateSteps(kind, drafts[kind].length === 1 ? [emptyStep()] : drafts[kind].filter((_, i) => i !== index))} type="button"><Trash2 aria-hidden="true" size={16} /></button>
									</div>
								</div>
								<textarea className="settings-field-control min-h-24 w-full px-4 py-3 font-mono text-xs" disabled={locked} id={`${kind}-step-${index}`} spellCheck={false} value={step.command} onChange={(event) => updateSteps(kind, drafts[kind].map((item, i) => i === index ? { ...item, command: event.target.value } : item))} />
							</div>)}
							<Button className="gap-1.5 self-start text-settings-muted hover:text-settings-label" disabled={locked} onClick={() => updateSteps(kind, [...drafts[kind], emptyStep()])} size="sm" type="button" variant="ghost"><Plus aria-hidden="true" size={16} />{t(kind === "setup" ? "settings.project.addSetupStep" : "settings.project.addCleanupStep")}</Button>
						</div></TooltipProvider>
					</div>
					{kind === "cleanup" && <div className="settings-content-row space-y-2">
						<p className="text-xs text-settings-muted">{t("settings.project.cleanupRetryHint")}</p>
						<Button disabled={dirty || mutation.isPending || retry.isPending} onClick={() => retry.mutate()} type="button" variant="ghost" size="sm" className="text-settings-muted hover:text-settings-label">{t("settings.project.retryCleanup")}</Button>
						{retry.isError && <p role="alert" className="text-sm text-error">{retry.error instanceof Error ? retry.error.message : t("settings.project.cleanupRetryFailed")}</p>}
						{retry.data && <div role="status" className="space-y-1 text-sm text-settings-muted">
							<p>{t("settings.project.cleanupRetryResult", { cleaned: retry.data.cleaned.length, skipped: retry.data.skipped.length })}</p>
							{retry.data.skipped.map((item) => <p key={item.sessionId}>{item.sessionId}: {item.reason}</p>)}
						</div>}
					</div>}
				</ProjectSettingsSection>}
			</TabsContent>)}
		</Tabs>
		<SettingsSaveFooter dirty={dirty} disabled={locked || timeoutError !== undefined}
			error={timeoutError ?? (mutation.isError ? mutation.error instanceof Error ? mutation.error.message : t("settings.project.saveFailed") : undefined)} />
	</form>;
}
