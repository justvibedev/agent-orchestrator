import { Activity, BadgeCheck, Bot, CircleHelp, Globe2, Keyboard, Server, Settings2, Smartphone, type LucideIcon } from "lucide-react";
import { lazy, type ReactNode } from "react";
import type { TFunction } from "i18next";
import type { GlobalSettingsSection, HarnessDiagnosticsRequest } from "../../stores/ui-store";
import { BrowserDownloadsSection } from "./BrowserDownloadsSection";
import { BrowserProfilesSection } from "./BrowserProfilesSection";
import { CodexAccountsSection } from "./CodexAccountsSection";
import { ConnectMobileContent } from "./ConnectMobileContent";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { HarnessSettingsSection } from "./HarnessSettingsSection";
import { KeyboardShortcutsContent } from "./KeyboardShortcutsContent";
import { MobileDevicesSection } from "./MobileDevicesSection";
import { ReportProblemContent } from "./ReportProblemContent";
import { RemoteHostsSettings } from "./RemoteHostsSettings";
import { SettingsSection } from "./SettingsSection";

/** The memory window's own blocks, loaded only when the page is opened: it
 * samples the machine every two seconds while it is on screen. */
const MemoryDiagnostics = lazy(async () => {
	const module = await import("../SessionMemoryPanel");
	return { default: module.MemoryDiagnostics };
});


type CatalogContext = {
	developerMode: boolean;
	/** Developer mode with the Diagnostics toggle on — gates the memory and CPU page. */
	diagnostics: boolean;
	focusAgentId?: string;
	hostId?: string;
	startLogin?: boolean;
	showDiagnostics?: HarnessDiagnosticsRequest;
	/** One page is shown, under its own title: a first heading that only
	 * rewords that title ("Keyboard shortcuts" on Shortcuts) is hidden. */
	singlePage?: boolean;
};

export type SettingsCatalogItem = {
	id: GlobalSettingsSection;
	icon: LucideIcon;
	label: (t: TFunction) => string;
	visible?: (context: CatalogContext) => boolean;
	/** Left out of the single-page "all" view; it has its own page in the nav.
	 * Diagnostics is a live monitor, not a preference: rendering it inside the
	 * whole-settings page would sample the machine whenever settings opens. */
	pageOnly?: boolean;
	render: (t: TFunction, titleHidden: boolean, context: CatalogContext) => ReactNode;
};

const globalSettingsCatalog: SettingsCatalogItem[] = [
	{
		id: "general",
		icon: Settings2,
		label: (t) => t("settings.general"),
		render: (_t, titleHidden) => <GeneralSettingsSection titleHidden={titleHidden} />,
	},
	{
		id: "harness",
		icon: Bot,
		label: (t) => t("settings.harness"),
		render: (_t, titleHidden, { focusAgentId, hostId, startLogin, showDiagnostics }) => <HarnessSettingsSection focusAgentId={focusAgentId} {...(hostId ? { hostId } : {})} {...(startLogin ? { startLogin } : {})} {...(showDiagnostics ? { showDiagnostics } : {})} titleHidden={titleHidden} />,
	},
	{
		id: "agents",
		icon: BadgeCheck,
		label: (t) => t("settings.agents"),
		// In developer mode, subscription accounts live on each CLI's Harness
		// Account tab instead.
		visible: ({ developerMode }) => !developerMode,
		render: (_t, titleHidden) => <CodexAccountsSection titleHidden={titleHidden} />,
	},
	{
		id: "browserProfiles",
		icon: Globe2,
		label: (t) => t("settings.browserProfiles"),
		render: (_t, titleHidden) => (
			<>
				<BrowserProfilesSection titleHidden={titleHidden} />
				<BrowserDownloadsSection />
			</>
		),
	},
	{
		id: "remoteHosts",
		icon: Server,
		label: (t) => t("settings.remoteHosts"),
		visible: ({ developerMode }) => developerMode,
		render: (_t, titleHidden) => <RemoteHostsSettings titleHidden={titleHidden} />,
	},
	{
		id: "mobile",
		icon: Smartphone,
		label: (t) => t("settings.mobile"),
		render: (t, titleHidden) => (
			<>
				<SettingsSection titleHidden={titleHidden} title={t("settings.mobile")} grouped>
					{/* Its own card rows: the pairing content row, then Keep awake. */}
					<ConnectMobileContent active />
				</SettingsSection>
				{/* Its own section (and card) when devices are paired; renders nothing otherwise. */}
				<MobileDevicesSection />
			</>
		),
	},
	{
		id: "shortcuts",
		icon: Keyboard,
		label: (t) => t("settings.shortcuts"),
		render: (_t, titleHidden, { singlePage }) => <KeyboardShortcutsContent active titleHidden={titleHidden || Boolean(singlePage)} />,
	},
	{
		id: "diagnostics",
		icon: Activity,
		label: (t) => t("settings.diagnostics"),
		pageOnly: true,
		visible: ({ diagnostics }) => diagnostics,
		render: (t, titleHidden) => (
			<SettingsSection titleHidden={titleHidden} title={t("settings.diagnostics")}>
				<MemoryDiagnostics />
			</SettingsSection>
		),
	},
	{
		id: "help",
		icon: CircleHelp,
		label: (t) => t("settings.help"),
		render: (t, titleHidden) => (
			<SettingsSection titleHidden={titleHidden} title={t("settings.reportProblem")} grouped>
				<div className="settings-content-row">
					<ReportProblemContent active />
				</div>
			</SettingsSection>
		),
	},
];

export function visibleGlobalSettings(context: CatalogContext): SettingsCatalogItem[] {
	return globalSettingsCatalog.filter((item) => item.visible?.(context) ?? true);
}

export function globalSettingsItem(section: GlobalSettingsSection, context: CatalogContext): SettingsCatalogItem {
	return visibleGlobalSettings(context).find((item) => item.id === section) ?? globalSettingsCatalog[0];
}

export function globalSettingsItemsFor(section: GlobalSettingsSection | "all", context: CatalogContext): SettingsCatalogItem[] {
	return section === "all"
		? visibleGlobalSettings(context).filter((item) => !item.pageOnly)
		: [globalSettingsItem(section, context)];
}
