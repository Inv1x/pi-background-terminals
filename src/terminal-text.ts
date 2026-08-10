/**
 * Shared terminal-literal contract for every untrusted string rendered by this
 * extension. Captured output remains raw; callers sanitize only at a display or
 * tool-result boundary. The transform is deliberately idempotent so defensive
 * re-sanitization by a custom renderer cannot reveal a second escape sequence.
 */

const ESC = 0x1b;
const BEL = 0x07;
const C1_DCS = 0x90;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_SOS = 0x98;
const C1_PM = 0x9e;
const C1_APC = 0x9f;
const FORMAT_CHARACTER = /\p{Cf}/u;

function controlStringEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === BEL || code === C1_ST) return index + 1;
		if (code === ESC && text.charCodeAt(index + 1) === 0x5c) return index + 2;
	}
	// An unterminated OSC/DCS/etc. leaves the real terminal consuming all
	// following bytes too, so discard the remainder rather than expose payload.
	return text.length;
}

function csiEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return text.length;
}

function escapeEnd(text: string, start: number): number {
	const introducer = text.charCodeAt(start + 1);
	if (introducer === 0x5b) return csiEnd(text, start + 2);
	if (
		introducer === 0x5d ||
		introducer === 0x50 ||
		introducer === 0x58 ||
		introducer === 0x5e ||
		introducer === 0x5f
	)
		return controlStringEnd(text, start + 2);

	let index = start + 1;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code > 0x2f) break;
		index++;
	}
	const final = text.charCodeAt(index);
	return final >= 0x30 && final <= 0x7e ? index + 1 : start + 1;
}

/**
 * Return terminal-literal text: LF is preserved and tabs are expanded, while
 * ANSI/ECMA-48 sequences (including unterminated strings), C0/C1 controls, and
 * Unicode format/bidi controls are removed. This function is idempotent.
 */
export function sanitizeTerminalText(text: string): string {
	let safe = "";
	for (let index = 0; index < text.length; ) {
		const code = text.charCodeAt(index);
		if (code === ESC) {
			index = escapeEnd(text, index);
			continue;
		}
		if (code === C1_CSI) {
			index = csiEnd(text, index + 1);
			continue;
		}
		if (
			code === C1_OSC ||
			code === C1_DCS ||
			code === C1_SOS ||
			code === C1_PM ||
			code === C1_APC
		) {
			index = controlStringEnd(text, index + 1);
			continue;
		}
		if (code === 0x09) {
			safe += "  ";
			index++;
			continue;
		}
		if (
			(code >= 0 && code <= 0x1f && code !== 0x0a) ||
			(code >= 0x7f && code <= 0x9f)
		) {
			index++;
			continue;
		}
		const character = String.fromCodePoint(text.codePointAt(index) ?? code);
		if (!FORMAT_CHARACTER.test(character)) safe += character;
		index += character.length;
	}
	return safe;
}

/** Keep untrusted metadata inside one physical terminal row. */
export function sanitizeTerminalLine(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
}
