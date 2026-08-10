import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "./terminal-text.ts";

export interface TerminalResultDetails {
	readonly id?: string;
	readonly title?: string;
	readonly status?: string;
	readonly exitCode?: number;
	readonly signal?: string;
}

/** Historical completion rows stay metadata-only, regardless of expansion. */
export const renderTerminalResultMessage: MessageRenderer<
	TerminalResultDetails
> = (message, { outputPad }, theme) => {
	const details = message.details ?? {};
	const failed = details.status === "failed";
	const killed = details.status === "killed";
	const icon = failed
		? theme.fg("error", "x")
		: killed
			? theme.fg("muted", "■")
			: theme.fg("success", "■");
	const how = killed
		? "killed"
		: sanitizeTerminalLine(details.signal ?? `exit ${details.exitCode ?? "?"}`);
	const id = sanitizeTerminalLine(details.id ?? "?");
	const title = sanitizeTerminalLine(details.title ?? "");
	const summary =
		`${icon} ` +
		theme.fg("accent", theme.bold(`terminal ${id}`)) +
		theme.fg("muted", `${title ? ` · ${title}` : ""} · ${how}`);

	const box = new Box(outputPad, 1, (line) =>
		theme.bg("customMessageBg", line),
	);
	box.addChild(new Text(summary, 0, 0));
	return box;
};
