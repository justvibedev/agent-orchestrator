import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { GlobalSettingsForm, type GlobalSettingsSection } from "./GlobalSettingsForm";
import { useLocaleStore } from "../stores/locale-store";
import { useSoundNotificationsStore } from "../stores/sound-notifications-store";
import { useTerminalShellStore } from "../stores/terminal-shell-store";
import { useUiStore } from "../stores/ui-store";
import { useTelemetryPolicyStore } from "../stores/telemetry-policy-store";
import { useAnalyticsOptOutStore } from "../stores/analytics-opt-out-store";
import { TooltipProvider } from "./ui/tooltip";

const { harnessSettingsSectionMock } = vi.hoisted(() => ({ harnessSettingsSectionMock: vi.fn() }));

vi.mock("./settings/HarnessSettingsSection", () => ({
	HarnessSettingsSection: (props: { focusAgentId?: string; hostId?: string; titleHidden?: boolean }) => {
		harnessSettingsSectionMock(props);
		return <div data-testid="harness-settings-section" />;
	},
}));

// The real section reads the cloud gate and /me; here it only marks where the
// General page places it.
vi.mock("./settings/DefaultCloudSandboxRow", () => ({
	DefaultCloudSandboxSection: () => <div data-testid="default-cloud-sandbox-section" />,
}));

const {
	getUiSettings,
	setUiSettings,
	getVersion,
	getDaemonStatus,
	navigateMock,
	writeText,
	openExternal,
	getKeybindings,
	setKeybindings,
	setKeybindingRecording,
	getTelemetryPolicy,
	setTelemetryEvents,
	onTelemetryPolicy,
	getAnalyticsOptOut,
	setAnalyticsOptOut,
	isMacPlatform,
	isWindowsPlatform,
} = vi.hoisted(() => ({
	getUiSettings: vi.fn(),
	setUiSettings: vi.fn(),
	getVersion: vi.fn(),
	getDaemonStatus: vi.fn(),
	navigateMock: vi.fn(),
	writeText: vi.fn(),
	openExternal: vi.fn(),
	getKeybindings: vi.fn(),
	setKeybindings: vi.fn(),
	setKeybindingRecording: vi.fn(),
	// install the per-test policy response. Preserve the bridge's Promise
	// contract for that initial read as well.
	getTelemetryPolicy: vi.fn().mockResolvedValue(undefined),
	setTelemetryEvents: vi.fn(),
	onTelemetryPolicy: vi.fn(),
	getAnalyticsOptOut: vi.fn(),
	setAnalyticsOptOut: vi.fn(),
	isMacPlatform: vi.fn(() => false),
	isWindowsPlatform: vi.fn(() => true),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
	};
});

vi.mock("../lib/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/platform")>();
	return { ...actual, isMacPlatform, isWindowsPlatform };
});

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		app: { getVersion, openExternal },
		clipboard: { writeText },
		daemon: { getStatus: getDaemonStatus },
		remotes: { list: vi.fn(async () => []) },
		cliLink: {
			setEnabled: vi.fn(async () => undefined),
			inspect: vi.fn(async () => ({ ok: false as const, code: "unsupported" as const, message: "unavailable" })),
			link: vi.fn(async () => ({ ok: false as const, code: "unsupported" as const, message: "unavailable" })),
			unlink: vi.fn(async () => ({ ok: false as const, code: "unsupported" as const, message: "unavailable" })),
		},
		uiSettings: { get: getUiSettings, set: setUiSettings },
		keybindings: {
			get: getKeybindings,
			set: setKeybindings,
			setRecording: setKeybindingRecording,
		},
		telemetry: { getPolicy: getTelemetryPolicy, setEventsEnabled: setTelemetryEvents, onPolicy: onTelemetryPolicy, getBootstrap: vi.fn(), capture: vi.fn(), getAnalyticsOptOut, setAnalyticsOptOut },
	},
}));

vi.mock("../lib/cloud-session", () => ({
	useCloudSession: () => ({ status: "authenticated", session: { user: { id: "test-user" } } }),
}));

function renderForm(section: GlobalSettingsSection = "all", focusAgentId?: string, hostId?: string) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<GlobalSettingsForm focusAgentId={focusAgentId} hostId={hostId} section={section} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(async () => {
	harnessSettingsSectionMock.mockReset();
	for (const m of [
		getUiSettings,
		setUiSettings,
		navigateMock,
		writeText,
		openExternal,
		getVersion,
		getDaemonStatus,
		getKeybindings,
		setKeybindings,
		setKeybindingRecording,
		getTelemetryPolicy,
		setTelemetryEvents,
		onTelemetryPolicy,
		getAnalyticsOptOut,
		setAnalyticsOptOut,
		isMacPlatform,
		isWindowsPlatform,
	]) {
		m.mockReset();
	}
	isWindowsPlatform.mockReturnValue(true);
	getUiSettings.mockResolvedValue({ locale: "en", soundNotificationsEnabled: true, terminalShell: { kind: "auto" } });
	setUiSettings.mockImplementation(async (settings: { locale?: string; soundNotificationsEnabled?: boolean; terminalShell?: { kind: string; path?: string } }) => ({
		locale: "en",
		soundNotificationsEnabled: true,
		terminalShell: { kind: "auto" },
		...settings,
	}));
	getVersion.mockResolvedValue("1.4.0");
	getDaemonStatus.mockResolvedValue({ state: "ready" });
	writeText.mockResolvedValue(undefined);
	openExternal.mockResolvedValue(undefined);
	getKeybindings.mockResolvedValue({});
	setKeybindings.mockImplementation(async (overrides) => overrides);
	setKeybindingRecording.mockResolvedValue(undefined);
	getTelemetryPolicy.mockResolvedValue({ eventsEnabled: false, consentGeneration: "generation-off", updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: true, consentRenewalRequired: false, state: "applied", environmentVeto: false, durabilitySupported: true });
	setTelemetryEvents.mockResolvedValue({ eventsEnabled: true, consentGeneration: "generation-on", updatedAt: "2026-08-28T10:15:31.000Z", acknowledged: true, consentRenewalRequired: false, state: "applied", environmentVeto: false, durabilitySupported: true });
	onTelemetryPolicy.mockReturnValue(() => undefined);
	getAnalyticsOptOut.mockResolvedValue(false);
	setAnalyticsOptOut.mockImplementation(async (optedOut: boolean) => optedOut);
	// Locale defaults to English so existing copy assertions stay green.
	await appI18n.changeLanguage("en");
	useLocaleStore.setState({ locale: "en", loaded: false, saving: false, saveError: false });
	useSoundNotificationsStore.setState({ enabled: true, loaded: false, saving: false, saveError: false });
	useTerminalShellStore.setState({
		preference: { kind: "auto" },
		loaded: false,
		saving: false,
		saveError: false,
	});
	useUiStore.setState({ developerMode: false, remoteHosts: false, diagnostics: false, sideChats: false, windowTranslucency: false });
	useTelemetryPolicyStore.setState({ view: { eventsEnabled: false, consentGeneration: "generation-off", updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: true, consentRenewalRequired: false, state: "applied", environmentVeto: false, durabilitySupported: true }, loaded: true, saving: false, saveError: false });
	useAnalyticsOptOutStore.setState({ optedOut: false, loaded: false, saving: false, loadError: false, saveError: false });
	document.documentElement.lang = "en";
});

describe("GlobalSettingsForm", () => {
	it("keeps window transparency in Appearance when Developer Mode changes", async () => {
		isMacPlatform.mockReturnValue(true);
		const user = userEvent.setup();
		renderForm("general");
		const appearance = screen.getByRole("heading", { name: "Appearance" }).closest("section")!;
		const transparency = within(appearance).getByRole("switch", { name: "Window transparency" });
		await user.click(transparency);
		expect(window.localStorage.getItem("ao.windowTranslucency")).toBe("true");
		const developerMode = screen.getByRole("switch", { name: "Developer mode" });
		await user.click(developerMode);
		await user.click(developerMode);
		expect(transparency).toHaveAttribute("aria-checked", "true");
		expect(useUiStore.getState().windowTranslucency).toBe(true);
	});

	it("hides window transparency on platforms without native vibrancy", async () => {
		renderForm("general");
		await screen.findByRole("switch", { name: "Developer mode" });
		expect(screen.queryByRole("switch", { name: "Window transparency" })).not.toBeInTheDocument();
	});

	it("propagates a Harness focus target through the settings catalog", async () => {
		renderForm("harness", "cursor");

		expect(await screen.findByTestId("harness-settings-section")).toBeInTheDocument();
		// Headings that repeat the page title are now hidden by SettingsSection, not this flag.
		expect(harnessSettingsSectionMock).toHaveBeenCalledWith({ focusAgentId: "cursor", titleHidden: false });
	});

	it("keeps Browser in its dedicated settings page", async () => {
		renderForm("general");
		expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
		expect(document.querySelector('[data-section="browserProfiles"]')).not.toBeInTheDocument();
		expect(document.querySelector('[data-section="remoteHosts"]')).not.toBeInTheDocument();
	});

	it("keeps download history inside the Browser settings page", async () => {
		renderForm("browserProfiles");
		expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
		expect(document.querySelector('[data-section="browserProfiles"]')).toBeInTheDocument();
		expect(document.querySelector('[data-section="downloads"]')).toBeInTheDocument();
	});

	it("renders the settings sections", async () => {
		renderForm();
		expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
		expect(screen.getByText("Appearance")).toBeInTheDocument();
		expect(screen.getByText("Language")).toBeInTheDocument();
		expect(screen.getByText("Advanced")).toBeInTheDocument();
		expect(screen.getByText("Report a problem")).toBeInTheDocument();
		// Report form is inline — no dialog, fields directly present.
		expect(screen.getByLabelText("Title")).toBeInTheDocument();
	});

	it("persists developer mode", async () => {
		const user = userEvent.setup();
		renderForm();
		const toggle = await screen.findByRole("switch", { name: "Developer mode" });
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await user.click(toggle);
		expect(window.localStorage.getItem("ao.developerMode")).toBe("true");
	});

	// Admins pick the org's cloud sandbox without turning on Developer Mode or
	// the preview Cloud toggle, which builds that force cloud leave off.
	it("shows the default cloud sandbox outside Developer mode", async () => {
		renderForm("general");
		expect(await screen.findByRole("switch", { name: "Developer mode" })).toHaveAttribute("aria-checked", "false");
		expect(screen.getByTestId("default-cloud-sandbox-section")).toBeInTheDocument();
	});

	it("reveals the Side chats toggle only in Developer mode and persists it", async () => {
		const user = userEvent.setup();
		renderForm("general");
		await screen.findByRole("switch", { name: "Developer mode" });
		expect(screen.queryByRole("switch", { name: "Side chats" })).not.toBeInTheDocument();

		await user.click(screen.getByRole("switch", { name: "Developer mode" }));
		const toggle = await screen.findByRole("switch", { name: "Side chats" });
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await user.click(toggle);
		expect(window.localStorage.getItem("ao.sideChats")).toBe("true");
		expect(useUiStore.getState().sideChats).toBe(true);
	});

	it("reveals the Diagnostics toggle only in Developer mode and persists it", async () => {
		const user = userEvent.setup();
		renderForm("general");
		await screen.findByRole("switch", { name: "Developer mode" });
		expect(screen.queryByRole("switch", { name: "Diagnostics" })).not.toBeInTheDocument();

		await user.click(screen.getByRole("switch", { name: "Developer mode" }));
		const toggle = await screen.findByRole("switch", { name: "Diagnostics" });
		expect(toggle).toHaveAttribute("aria-checked", "false");

		await user.click(toggle);
		expect(window.localStorage.getItem("ao.diagnostics")).toBe("true");
		expect(useUiStore.getState().diagnostics).toBe(true);
	});

	it("keeps Remote hosts in its own page and persists the enable switch", async () => {
		const user = userEvent.setup();
		useUiStore.getState().setDeveloperMode(true);
		renderForm("remoteHosts");
		const remoteHosts = await screen.findByRole("switch", { name: "Connect to remote hosts" });
		expect(remoteHosts).toHaveAttribute("aria-checked", "false");
		expect(screen.queryByRole("switch", { name: "Developer mode" })).not.toBeInTheDocument();

		await user.click(remoteHosts);
		expect(window.localStorage.getItem("ao.remoteHosts")).toBe("true");
		expect(useUiStore.getState().remoteHosts).toBe(true);
	});

	it("switches settings labels to Simplified Chinese and persists locale", async () => {
		const user = userEvent.setup();
		renderForm();
		expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
		expect(screen.getByLabelText("Language")).toBeInTheDocument();

		await user.click(screen.getByLabelText("Language"));
		await user.click(await screen.findByRole("menuitem", { name: "Simplified Chinese" }));

		await waitFor(() => expect(setUiSettings).toHaveBeenCalledWith({ locale: "zh-CN" }));
		await waitFor(() => expect(screen.getByText("语言")).toBeInTheDocument());
		expect(screen.getByText("主题")).toBeInTheDocument();
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(useLocaleStore.getState().locale).toBe("zh-CN");
	});

	it("toggles sound notifications on and persists the change", async () => {
		const user = userEvent.setup();
		renderForm();
		const toggle = await screen.findByRole("switch", { name: "Sound notifications" });
		expect(toggle).toBeChecked();

		await user.click(toggle);

		await waitFor(() => expect(setUiSettings).toHaveBeenCalledWith({ soundNotificationsEnabled: false }));
		expect(toggle).not.toBeChecked();
	});

	it("shows pending daemon cleanup without claiming opt-out completed", async () => {
		setTelemetryEvents.mockResolvedValue({ eventsEnabled: false, consentGeneration: "generation-off-2", updatedAt: "2026-08-28T10:15:31.000Z", acknowledged: false, consentRenewalRequired: false, state: "cleanup_pending", environmentVeto: false, durabilitySupported: true, reason: "cleanup_failed" });
		useTelemetryPolicyStore.setState({ view: { eventsEnabled: true, consentGeneration: "generation-on", updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: true, consentRenewalRequired: false, state: "applied", environmentVeto: false, durabilitySupported: true }, loaded: true });
		const user = userEvent.setup(); renderForm();
		await user.click(await screen.findByRole("switch", { name: "Share error events" }));
		expect(await screen.findByText("Telemetry is off locally. Daemon cleanup is still pending.")).toBeInTheDocument();
	});

	it("opts out of PostHog usage analytics from the Privacy section, independent of error events", async () => {
		const user = userEvent.setup();
		renderForm();
		const toggle = await screen.findByRole("switch", { name: "Share usage analytics" });
		await waitFor(() => expect(toggle).toBeEnabled());
		expect(toggle).toBeChecked();
		expect(screen.getByText(/your email is used only as a person property/)).toBeInTheDocument();

		await user.click(toggle);

		await waitFor(() => expect(setAnalyticsOptOut).toHaveBeenCalledWith(true));
		await waitFor(() => expect(toggle).not.toBeChecked());
		// The error-event policy is a separate control and was not touched.
		expect(setTelemetryEvents).not.toHaveBeenCalled();
	});

	it("labels an analytics preference load failure as a load failure", async () => {
		getAnalyticsOptOut.mockRejectedValueOnce(new Error("unavailable"));
		renderForm();
		expect(await screen.findByText("Could not load the analytics preference.")).toHaveAttribute("role", "alert");
		expect(screen.queryByText("Could not save the analytics preference.")).not.toBeInTheDocument();
	});

	it("names the platform restriction instead of claiming cleanup keeps retrying", async () => {
		useTelemetryPolicyStore.setState({ view: { eventsEnabled: false, consentGeneration: "generation-off", updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: false, consentRenewalRequired: false, state: "cleanup_failed", environmentVeto: false, durabilitySupported: false, reason: "durability_unsupported" }, loaded: true });
		renderForm();
		expect(await screen.findByText("Enabling is unavailable on this platform because durable consent writes are not supported.")).toBeInTheDocument();
		expect(screen.queryByText("Telemetry cleanup failed. Reporting remains disabled while cleanup retries.")).not.toBeInTheDocument();
	});

	it("does not promise retries for the fail-closed view when the controller is unavailable", async () => {
		useTelemetryPolicyStore.setState({ view: { eventsEnabled: false, consentGeneration: "unavailable", updatedAt: new Date(0).toISOString(), acknowledged: false, consentRenewalRequired: false, state: "cleanup_failed", environmentVeto: true, durabilitySupported: false, reason: "invalid_authority" }, loaded: true });
		renderForm();
		expect(await screen.findByText("Enabling is unavailable on this platform because durable consent writes are not supported.")).toBeInTheDocument();
		expect(screen.queryByText("Telemetry cleanup failed. Reporting remains disabled while cleanup retries.")).not.toBeInTheDocument();
	});

	it("names the release gate when a saved opt-in cannot be honoured", async () => {
		useTelemetryPolicyStore.setState({ view: { eventsEnabled: true, consentGeneration: "generation-on", updatedAt: "2026-08-28T10:15:30.000Z", acknowledged: true, consentRenewalRequired: false, state: "applied", environmentVeto: false, durabilitySupported: true, reason: "release_blocked" }, loaded: true });
		renderForm();
		expect(await screen.findByText("Error reporting is disabled by this release's safety gate.")).toBeInTheDocument();
		expect(screen.queryByText("Telemetry is off locally. Daemon cleanup is still pending.")).not.toBeInTheDocument();
	});

	it("selects Git Bash as the default Windows terminal", async () => {
		const user = userEvent.setup();
		renderForm();
		const selector = await screen.findByLabelText("Terminal shell");

		await user.click(selector);
		await user.click(await screen.findByRole("menuitem", { name: "Git Bash" }));

		await waitFor(() => expect(setUiSettings).toHaveBeenCalledWith({ terminalShell: { kind: "git-bash" } }));
	});

	it("discards an uncommitted custom shell path when editing is cancelled", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.click(await screen.findByLabelText("Terminal shell"));
		await user.click(await screen.findByRole("menuitem", { name: "Custom path" }));
		await waitFor(() => expect(setUiSettings).toHaveBeenCalledWith({ terminalShell: { kind: "custom" } }));

		setUiSettings.mockClear();
		await user.click(screen.getByRole("button", { name: "Edit Shell executable" }));
		const input = screen.getByLabelText("Shell executable");
		await user.type(input, "C:\\Tools\\bash.exe");
		await user.keyboard("{Escape}");

		expect(screen.queryByLabelText("Shell executable")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit Shell executable" })).toHaveTextContent("C:\\path\\to\\shell.exe");
		expect(setUiSettings).not.toHaveBeenCalled();
	});

	it("keeps the current sound notifications value and reports a persistence failure", async () => {
		setUiSettings.mockRejectedValue(new Error("disk full"));
		const user = userEvent.setup();
		renderForm();
		const toggle = await screen.findByRole("switch", { name: "Sound notifications" });

		await user.click(toggle);

		expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the sound notifications preference.");
		expect(useSoundNotificationsStore.getState().enabled).toBe(true);
		expect(toggle).toBeChecked();
	});

	it("keeps the current language and reports a persistence failure", async () => {
		setUiSettings.mockRejectedValue(new Error("disk full"));
		const user = userEvent.setup();
		renderForm();
		await screen.findByLabelText("Settings");

		await user.click(screen.getByLabelText("Language"));
		await user.click(await screen.findByRole("menuitem", { name: "Simplified Chinese" }));

		expect(await screen.findByText("Could not save the language preference.")).toHaveAttribute("role", "alert");
		expect(useLocaleStore.getState().locale).toBe("en");
		expect(screen.getByText("Appearance")).toBeInTheDocument();
	});

	it("closes settings with Escape", async () => {
		const user = userEvent.setup();
		renderForm();
		await screen.findByLabelText("Settings");

		await user.keyboard("{Escape}");

		// Escape is handled by the wrapping Radix Dialog, not the form itself
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("renders the report form inline without a dialog", async () => {
		renderForm();
		expect(await screen.findByLabelText("Title")).toBeInTheDocument();
		expect(screen.queryByRole("dialog", { name: "Report a problem" })).not.toBeInTheDocument();
	});

	it("opens feedback from settings and copies redacted report drafts", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		getVersion.mockResolvedValue("9.9.9-test");
		getDaemonStatus.mockResolvedValue({
			state: "ready",
			message: "Listening at http://127.0.0.1:31001?token=secret",
		});
		renderForm();

		await user.type(await screen.findByLabelText("Title"), "Create project fails in /Users/alice/private-repo");
		await user.type(
			screen.getByLabelText("What happened?"),
			"Open http://127.0.0.1:5173/projects/demo?access_token=local-secret and click Create. Show a clear prerequisite error.",
		);
		expect(screen.queryByRole("combobox", { name: "Report type" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Include safe diagnostics")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Expected behavior")).not.toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Report destination" })).toBeInTheDocument();
		expect(screen.queryByRole("radiogroup", { name: "Report destination" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Report preview")).not.toBeInTheDocument();

		expect(screen.getByRole("button", { name: /copy & create github issue/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /copy & open discord/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /copy & open email/i })).toBeInTheDocument();
		expect(screen.getByLabelText("What happened?")).toHaveClass("resize-none");
		await user.click(screen.getByRole("button", { name: /copy & create github issue/i }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).toContain("Create project fails");
		expect(copied).toContain("AO version: 9.9.9-test");
		expect(copied).toContain("Daemon: ready");
		expect(copied).toContain("[redacted-local-path]");
		expect(copied).toContain("[redacted-local-url]");
		expect(copied).not.toContain("/Users/alice");
		expect(copied).not.toContain("local-secret");
		expect(copied).not.toContain("## Type");
		expect(copied).not.toContain("Generated locally by AO");
		expect(openExternal).toHaveBeenCalledWith(
			expect.stringContaining("https://github.com/justvibedev/agent-orchestrator/issues/new"),
		);
		expect(open).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Title")).toHaveValue("");
		expect(screen.getByLabelText("What happened?")).toHaveValue("");
	});

	it("opens Discord support and lets Windows users choose an email provider", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		getVersion.mockRejectedValue(new Error("version unavailable"));
		getDaemonStatus.mockRejectedValue(new Error("daemon unavailable"));
		renderForm();

		await user.type(await screen.findByLabelText("Title"), "Need help with setup");
		await user.type(screen.getByLabelText("What happened?"), "The setup flow stalls after the first prompt.");

		expect(screen.getByRole("button", { name: /copy & open discord/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /copy & open email/i })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /copy & open discord/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toContain("**AO feedback**");
		expect(screen.getByText("Discord draft copied.")).toBeInTheDocument();
		expect(screen.getByLabelText("Title")).toHaveValue("");
		expect(screen.getByLabelText("What happened?")).toHaveValue("");

		expect(screen.getByRole("button", { name: /copy & open email/i })).toBeDisabled();
		await user.type(screen.getByLabelText("Title"), "Need help with setup");
		expect(screen.queryByText("Discord draft copied.")).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("What happened?"), "The setup flow stalls after the first prompt.");
		await user.click(screen.getByRole("button", { name: /copy & open email/i }));
		await user.click(await screen.findByRole("menuitem", { name: "Gmail" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
		expect(writeText.mock.calls[0][0]).toContain("Daemon: unknown");
		expect(writeText.mock.calls[1][0]).toContain("To: prasad@untrivial.ai");
		expect(writeText.mock.calls[1][0]).toContain("AO feedback");
		expect(openExternal).toHaveBeenCalledWith("https://discord.gg/WjKNa7EbB8");
		expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("https://mail.google.com/mail/"));
		expect(open).not.toHaveBeenCalled();
	});

	it("keeps the direct system email handoff outside Windows", async () => {
		const user = userEvent.setup();
		isWindowsPlatform.mockReturnValue(false);
		renderForm();

		await user.type(await screen.findByLabelText("Title"), "Need help with setup");
		await user.type(screen.getByLabelText("What happened?"), "The setup flow stalls after the first prompt.");
		await user.click(screen.getByRole("button", { name: /copy & open email/i }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("mailto:prasad@untrivial.ai"));
		expect(screen.queryByRole("menuitem", { name: "Gmail" })).not.toBeInTheDocument();
	});

	it("keeps the report form to title and details while tailoring placeholder guidance", async () => {
		renderForm();

		expect(await screen.findByLabelText("Title")).toHaveAttribute("placeholder", "Brief Title");
		expect(screen.getByLabelText("What happened?")).toHaveAttribute(
			"placeholder",
			"Share what happened, what you expected, and how to reproduce it.",
		);
		expect(screen.queryByLabelText("Expected behavior")).not.toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "Report type" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Include safe diagnostics")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Report preview")).not.toBeInTheDocument();
	});

});
