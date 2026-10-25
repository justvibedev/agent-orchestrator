/**
 * One Setup or Cleanup step as the editor holds it. folder is the repository
 * folder the step runs in ("" for the project's own checkout). timeout is the
 * step's own time limit in minutes as typed ("" or absent for the default); see
 * scriptStepTimeoutMinutes.
 */
export type ScriptStepDraft = { command: string; folder: string; timeout?: string };

/**
 * A step's time limit, in whole minutes, mirroring the daemon's
 * domain.ScriptStepTimeout bounds and defaults: a Setup step without its own
 * limit runs for 30 minutes. A Cleanup step without one has no limit.
 */
export const DEFAULT_SETUP_STEP_TIMEOUT_MINUTES = 30;
export const MIN_SCRIPT_STEP_TIMEOUT_MINUTES = 1;
export const MAX_SCRIPT_STEP_TIMEOUT_MINUTES = 120;

// The stored form of a step with its own time limit (domain.TimedScriptCommand
// in the local daemon): a first line that is a shell comment, so a release
// without per-step limits keeps and runs the step.
const timedScriptCommandPattern = /^# ao-timeout: ([0-9]{1,4})m\r?\n/;

/**
 * The stored step with its own time limit; one without (undefined) is the
 * command as is and runs with its kind's default. A typed limit equal to a
 * default is kept: the limit stays the step's own if a default changes.
 */
export function timedScriptCommand(minutes: number | undefined, command: string): string {
	if (minutes === undefined || minutes <= 0) return command;
	return `# ao-timeout: ${minutes}m\n${command}`;
}

/** Splits a stored step into its time limit in minutes (undefined when it sets none) and the rest. */
export function parseTimedScriptCommand(stored: string): { minutes?: number; command: string } {
	const match = timedScriptCommandPattern.exec(stored);
	if (!match) return { command: stored };
	return { minutes: Number(match[1]), command: stored.slice(match[0].length) };
}

/**
 * A typed time limit as whole minutes: undefined for "" (the default), null
 * when it is not a whole number from MIN to MAX.
 */
export function scriptStepTimeoutMinutes(text: string | undefined): number | undefined | null {
	const value = (text ?? "").trim();
	if (value === "") return undefined;
	if (!/^[0-9]+$/.test(value)) return null;
	const minutes = Number(value);
	return minutes >= MIN_SCRIPT_STEP_TIMEOUT_MINUTES && minutes <= MAX_SCRIPT_STEP_TIMEOUT_MINUTES ? minutes : null;
}

/** A stored step as the editor holds it. Every limit it sets shows, a default's value too. */
export function parseLocalScriptStep(stored: string): ScriptStepDraft {
	const { minutes, command } = parseTimedScriptCommand(stored);
	return { command, folder: "", ...timeoutText(minutes) };
}

/**
 * The stored form of a step: its command with the time limit typed for it, a
 * default's value included (a Cleanup step without one runs without a limit).
 */
export function serializeLocalScriptStep(step: ScriptStepDraft): string {
	return timedScriptCommand(scriptStepTimeoutMinutes(step.timeout) ?? undefined, step.command);
}

/** A draft's time limit for a stored one: none when the step sets none. */
function timeoutText(minutes: number | undefined): Pick<ScriptStepDraft, "timeout"> {
	return minutes === undefined ? {} : { timeout: String(minutes) };
}
