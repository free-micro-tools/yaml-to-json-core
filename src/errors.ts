/**
 * Turns js-yaml's terse parser errors into something a human can act on.
 *
 * js-yaml reports a *lot* of distinct mistakes as the same opaque string. Most
 * notably every unclosed bracket, brace and quote surfaces as "deficient
 * indentation", pointing at a line that has nothing to do with the real
 * problem. `findUnclosed()` below recovers the actual cause and the offset of
 * the delimiter that was never closed.
 */

export interface ParseError {
	/** Plain-English description of what went wrong. */
	message: string;
	/** How to fix it, when we can say something specific. */
	hint?: string;
	/** 1-indexed line, for display. */
	line?: number;
	/** 1-indexed column, for display. */
	column?: number;
	/** Character offset into the source — what CodeMirror's linter wants. */
	position?: number;
	/** js-yaml's original wording, kept for the "technical detail" disclosure. */
	raw: string;
}

/**
 * Both parsers used on this site are normalized into this shape: js-yaml
 * (converter) reports `reason` and a 0-indexed `mark`, while the `yaml`
 * package (formatter) reports a `code`, a character range in `pos` and
 * 1-indexed `linePos`.
 */
interface ParserErrorLike {
	reason?: string;
	message?: string;
	/** js-yaml. 0-indexed. */
	mark?: {
		line?: number;
		column?: number;
		position?: number;
	};
	/** `yaml` package. Character offsets, [start, end]. */
	pos?: [number, number];
	/** `yaml` package. 1-indexed, and only present for parse-time errors. */
	linePos?: [{ line: number; col: number }, ({ line: number; col: number } | undefined)?];
}

/**
 * Both parsers append the location and a source snippet to their message.
 * The snippet is already shown by the editor's inline marker, so it’s
 * stripped before the text is matched or displayed.
 */
function stripLocation(raw: string): string {
	return raw.replace(/\s*at line \d+, column \d+:?[\s\S]*$/, '').trim();
}

const OPENERS: Record<string, string> = { '[': ']', '{': '}' };
const CLOSERS = new Set([']', '}']);

interface Unclosed {
	kind: 'flow-seq' | 'flow-map' | 'single-quote' | 'double-quote';
	position: number;
}

/**
 * Scans YAML for a delimiter that’s opened but never closed.
 *
 * This is a lexical scan, not a parse: it tracks quote and comment state so
 * that brackets inside strings and comments are ignored. It’s only consulted
 * when js-yaml has already declared the document invalid, so a false positive
 * can at worst produce a less accurate message than the original — never a
 * spurious error on valid YAML.
 */
export function findUnclosed(src: string): Unclosed | null {
	const stack: Unclosed[] = [];
	let i = 0;

	while (i < src.length) {
		const ch = src[i];

		// Comments run to end of line, but `#` only starts one at the beginning
		// of a line or after whitespace.
		if (ch === '#' && (i === 0 || /\s/.test(src[i - 1]!))) {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}

		if (ch === "'") {
			const start = i;
			i++;
			let closed = false;
			while (i < src.length) {
				if (src[i] === "'") {
					// '' is an escaped quote inside a single-quoted scalar.
					if (src[i + 1] === "'") {
						i += 2;
						continue;
					}
					closed = true;
					i++;
					break;
				}
				// A single-quoted scalar may span lines, but a blank line ends it.
				if (src[i] === '\n' && /^\s*\n/.test(src.slice(i + 1))) break;
				i++;
			}
			if (!closed) return { kind: 'single-quote', position: start };
			continue;
		}

		if (ch === '"') {
			const start = i;
			i++;
			let closed = false;
			while (i < src.length) {
				if (src[i] === '\\') {
					i += 2;
					continue;
				}
				if (src[i] === '"') {
					closed = true;
					i++;
					break;
				}
				if (src[i] === '\n' && /^\s*\n/.test(src.slice(i + 1))) break;
				i++;
			}
			if (!closed) return { kind: 'double-quote', position: start };
			continue;
		}

		if (ch && ch in OPENERS) {
			stack.push({
				kind: ch === '[' ? 'flow-seq' : 'flow-map',
				position: i,
			});
		} else if (ch && CLOSERS.has(ch)) {
			stack.pop();
		}

		i++;
	}

	return stack.length ? stack[0]! : null;
}

/** Converts a character offset into 1-indexed line/column. */
export function offsetToLineCol(src: string, offset: number) {
	const clamped = Math.max(0, Math.min(offset, src.length));
	const before = src.slice(0, clamped);
	const line = before.split('\n').length;
	const column = clamped - (before.lastIndexOf('\n') + 1) + 1;
	return { line, column };
}

const UNCLOSED_COPY: Record<Unclosed['kind'], { message: string; hint: string }> = {
	'flow-seq': {
		message: 'A flow sequence opened with “[” is never closed.',
		hint: 'Add the matching “]”, or rewrite the list in block style with one “- item” per line.',
	},
	'flow-map': {
		message: 'A flow mapping opened with “{” is never closed.',
		hint: 'Add the matching “}”, or rewrite it in block style with one “key: value” per line.',
	},
	'single-quote': {
		message: 'A single-quoted string is never closed.',
		hint: "Add the closing “'”. To include a literal apostrophe inside a single-quoted string, double it: 'it''s'.",
	},
	'double-quote': {
		message: 'A double-quoted string is never closed.',
		hint: 'Add the closing “"”, or escape any quote inside the string as \\".',
	},
};

/**
 * Recovers the real cause behind the vague messages that every YAML parser
 * produces for an unterminated delimiter. js-yaml says "deficient indentation"
 * and points at an unrelated line; the `yaml` package used by the formatter
 * says "must be sufficiently indented and end with a ]". Both are useless
 * without knowing *which* delimiter, and *where* it opened.
 *
 * Returns null when the message isn’t one of those, or when the scan finds
 * everything balanced — in which case the caller's normal translation applies.
 */
export function describeUnclosed(src: string, raw: string): ParseError | null {
	const looksUnterminated =
		/deficient indentation|unexpected end of the stream|end with a [\]}]|unexpected end of|missing closing/i.test(
			raw
		);
	if (!looksUnterminated) return null;

	const unclosed = findUnclosed(src);
	if (!unclosed) return null;

	const { line, column } = offsetToLineCol(src, unclosed.position);
	const copy = UNCLOSED_COPY[unclosed.kind];
	return {
		message: copy.message,
		hint: copy.hint,
		line,
		column,
		position: unclosed.position,
		raw,
	};
}

/** Both parsers name the alias, but each phrases it differently. */
const ALIAS_NAME =
	/unidentified alias "?([^"\s]+)"?|unresolved alias[^:]*:\s*(\S+)/i;

function aliasName(raw: string): string | undefined {
	const match = ALIAS_NAME.exec(raw);
	return match?.[1] ?? match?.[2];
}

/**
 * Ordered list of matchers against the parser's message. First match wins, so
 * more specific patterns come first.
 *
 * Each `test` covers both parsers' wording for the same mistake: js-yaml drives
 * the converter, the `yaml` package drives the comment-preserving formatter,
 * and they describe identical problems in completely different words. Keeping
 * one table means a fix to the copy improves every page at once.
 */
const TRANSLATIONS: Array<{
	test: RegExp;
	message: string | ((raw: string) => string);
	hint: string;
	/** Recovers an offset when the parser reports none, as `yaml` does for
	 *  errors raised after parsing (unresolved aliases, for instance). */
	locate?: (raw: string, src: string) => number | undefined;
}> = [
	{
		// js-yaml: "tab characters must not be used in indentation"
		// yaml:    "Tabs are not allowed as indentation"
		test: /tab characters must not be used in indentation|tabs are not allowed as indentation/i,
		message: 'A tab character is used for indentation.',
		hint: 'YAML forbids tabs for indentation — they’re ambiguous across editors. Replace each tab with spaces (2 is conventional).',
	},
	{
		// js-yaml: "duplicated mapping key"  /  yaml: "Map keys must be unique"
		test: /duplicated mapping key|map keys must be unique/i,
		message: 'This key is defined more than once in the same mapping.',
		hint: 'JSON objects and YAML mappings both require unique keys. Rename or remove the duplicate — or nest it one level deeper if you meant a sub-key.',
	},
	{
		test: /unidentified alias|unresolved alias/i,
		message: (raw) => {
			const name = aliasName(raw);
			return name
				? `The alias “*${name}” points at an anchor that doesn’t exist.`
				: 'This alias points at an anchor that doesn’t exist.';
		},
		hint: 'Define the anchor first with “&name value”. Anchors must appear earlier in the document than the aliases that use them.',
		// The `yaml` package raises this while building the output rather than
		// while parsing, so the error carries no position at all. The alias is
		// unique enough in the source to find by name.
		locate: (raw, src) => {
			const name = aliasName(raw);
			if (!name) return undefined;
			const at = src.indexOf(`*${name}`);
			return at === -1 ? undefined : at;
		},
	},
	{
		test: /aliases exceeded maxAliases|exceeded maximum number of aliases|expands to an enormous/i,
		message: 'This document expands to an enormous structure through nested aliases.',
		hint: 'This is the classic “billion laughs” shape — often accidental, occasionally hostile. Reduce the nesting of anchors and aliases, or raise the alias limit if you trust the source.',
	},
	{
		test: /unknown (scalar |sequence |mapping )?tag/i,
		message: 'This document uses a custom tag the converter doesn’t recognize.',
		hint: 'Application-specific tags such as !Ref or !GetAtt (CloudFormation) have no JSON equivalent. Remove the tag or quote the value to convert it as a plain string.',
	},
	{
		// js-yaml: "name of an anchor node must contain at least one character"
		// yaml:    "Anchor cannot be an empty string"
		test: /name of an anchor node must contain at least one character|anchor cannot be an empty string/i,
		message: 'An anchor was declared with “&” but no name.',
		hint: 'Give the anchor a name, as in “&defaults”, or remove the stray “&”.',
	},
	{
		// The `yaml` package's wording for an unquoted value containing a colon.
		test: /nested mappings are not allowed in compact mappings/i,
		message: 'A value contains a colon, so YAML read it as a second key.',
		hint: 'Quote the value — write “title: \'foo: bar\'” — or move the nested mapping onto its own indented line.',
	},
	{
		// js-yaml: "bad indentation of a mapping entry"
		// yaml:    "All mapping items must start at the same column"
		test: /bad indentation of a mapping entry|all mapping items must start at the same column/i,
		message: 'A mapping entry isn’t lined up with the block it belongs to.',
		hint: 'Two common causes: an unquoted value containing a colon (write “title: \'foo: bar\'”), or a line indented with a different number of spaces than its siblings.',
	},
	{
		test: /bad indentation of a sequence entry|all sequence items must start at the same column/i,
		message: 'A sequence entry isn’t lined up with the block it belongs to.',
		hint: 'Every “-” in the same list must sit at the same indentation.',
	},
	{
		// yaml: raised when a key runs over several lines, which usually means a
		// missing colon on the line above.
		test: /implicit keys need to be on a single line|implicit map keys need to be followed by map values/i,
		message: 'A key spans more than one line.',
		hint: 'A key and its “:” must sit on the same line. This usually means the colon is missing from the line above, or a value needs quoting.',
	},
	{
		test: /expected a document, but the input is empty/i,
		message: 'The document is empty.',
		hint: 'Paste some YAML to convert.',
	},
	{
		test: /expected a single document in the stream/i,
		message: 'The input contains more than one YAML document.',
		hint: 'Documents are separated by “---”. Choose how multiple documents should be represented using the output control above.',
	},
	{
		test: /deficient indentation/i,
		message: 'The indentation here doesn’t match any open block.',
		hint: 'Check that nested keys are indented further than their parent, and that sibling keys share the same indentation. Use spaces, never tabs.',
	},
];

/**
 * Translates a thrown parser error into a `ParseError`.
 *
 * Handles both js-yaml (the converter) and the `yaml` package (the formatter):
 * they carry their position in different fields and describe the same mistakes
 * in different words, but everything downstream sees one shape.
 *
 * @param src the YAML that failed to parse — used to recover unclosed
 *            delimiters and to compute line/column when the error lacks a mark
 */
export function describeError(err: unknown, src: string): ParseError {
	const e = err as ParserErrorLike;
	const raw = e?.reason ?? e?.message ?? String(err);
	const short = stripLocation(raw);

	const unclosed = describeUnclosed(src, short);
	if (unclosed) return { ...unclosed, raw };

	// js-yaml marks are 0-indexed; the `yaml` package's linePos already counts
	// from 1, as humans and editors do.
	let position =
		typeof e?.mark?.position === 'number' ? e.mark.position : e?.pos?.[0];
	let line =
		typeof e?.mark?.line === 'number' ? e.mark.line + 1 : e?.linePos?.[0]?.line;
	let column =
		typeof e?.mark?.column === 'number'
			? e.mark.column + 1
			: e?.linePos?.[0]?.col;

	// A position with no line/col — or the reverse — still deserves both, so the
	// status message can offer a "jump to line" link either way.
	if (line === undefined && typeof position === 'number') {
		({ line, column } = offsetToLineCol(src, position));
	}

	for (const entry of TRANSLATIONS) {
		if (!entry.test.test(short)) continue;

		if (position === undefined && entry.locate) {
			const found = entry.locate(short, src);
			if (found !== undefined) {
				position = found;
				({ line, column } = offsetToLineCol(src, found));
			}
		}

		return {
			message:
				typeof entry.message === 'function' ? entry.message(short) : entry.message,
			hint: entry.hint,
			line,
			column,
			position,
			raw,
		};
	}

	return {
		// Fall back to the parser's own wording, capitalised so it reads as a
		// sentence and stripped of the snippet the editor already draws.
		message: short.charAt(0).toUpperCase() + short.slice(1),
		line,
		column,
		position,
		raw,
	};
}
