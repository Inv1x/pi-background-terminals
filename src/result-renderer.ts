import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sanitizeText } from "./ui/output-view.ts";

export interface TerminalResultDetails {
	readonly id?: string;
	readonly title?: string;
	readonly status?: string;
	readonly exitCode?: number;
	readonly signal?: string;
}

/** Render captured terminal text literally; only Pi theme styling is interpreted. */
export const renderTerminalResultMessage: MessageRenderer<
	TerminalResultDetails
> = (message, { expanded, outputPad }, theme) => {
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
		: sanitizeText(details.signal ?? `exit ${details.exitCode ?? "?"}`);
	const id = sanitizeText(details.id ?? "?");
	const title = sanitizeText(details.title ?? "");
	const header =
		`${icon} ` +
		theme.fg("accent", theme.bold(`terminal ${id}`)) +
		theme.fg("muted", ` · ${title} · ${how}`);

	const content = typeof message.content === "string" ? message.content : "";
	// The first line duplicates the themed summary. Everything after it is
	// untrusted process output: strip terminal controls, but never parse Markdown.
	const body = sanitizeText(content.split("\n").slice(1).join("\n").trim());
	const bodyLines = body ? body.split("\n") : [];
	const visibleLines = expanded ? bodyLines : bodyLines.slice(0, 8);
	let text = header;
	for (const line of visibleLines) text += `\n${theme.fg("toolOutput", line)}`;
	if (!expanded && bodyLines.length > visibleLines.length)
		text += `\n${theme.fg("dim", "... (Ctrl+O to expand)")}`;

	const box = new Box(outputPad, 1, (line) =>
		theme.bg("customMessageBg", line),
	);
	box.addChild(new Text(text, 0, 0));
	return box;
};
