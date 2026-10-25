import { useState, type ReactNode } from "react";
import { Copy, ExternalLink, FolderSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../lib/bridge";
import type { LocalPathAction, LocalPathInspection } from "../../shared/local-path";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ui/context-menu";

/**
 * A local path from chat text. Click opens it (never executes; main falls back to Reveal);
 * right-click offers Reveal / Open / Copy. Existence is checked in main when the menu opens,
 * not at render, so prose that merely looks like a path costs nothing.
 */
export function LocalPathMenu({ path, children }: { path: string; children: ReactNode }) {
	const { t } = useTranslation();
	const [inspection, setInspection] = useState<LocalPathInspection>();
	const perform = (action: LocalPathAction) => void aoBridge.localPath.perform(path, action).catch(() => undefined);
	const available = inspection?.ok === true;
	return (
		<ContextMenu onOpenChange={(open) => {
			if (open) void aoBridge.localPath.inspect(path).then(setInspection, () => setInspection({ ok: false, reason: "invalid" }));
		}}>
			<ContextMenuTrigger asChild>
				<span
					role="button"
					tabIndex={0}
					className="cursor-pointer rounded hover:underline focus-visible:underline"
					onClick={() => perform("open")}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						perform("open");
					}}
				>
					{children}
				</span>
			</ContextMenuTrigger>
			<ContextMenuContent className="min-w-52">
				<ContextMenuItem disabled={!available} onSelect={() => perform("reveal")}>
					<FolderSearch aria-hidden="true" />
					{t("path.reveal")}
				</ContextMenuItem>
				<ContextMenuItem disabled={!available} onSelect={() => perform("open")}>
					<ExternalLink aria-hidden="true" />
					{t("path.open")}
				</ContextMenuItem>
				<ContextMenuItem disabled={!available} onSelect={() => perform("copy")}>
					<Copy aria-hidden="true" />
					{t("path.copy")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
