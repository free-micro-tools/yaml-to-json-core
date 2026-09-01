/**
 * Detects values whose meaning changes between YAML 1.1 and YAML 1.2.
 *
 * This is the "Norway Problem" family: `country: no` is the string "no" under
 * YAML 1.2 but the boolean `false` under YAML 1.1, and different tools pick
 * different versions. Docker Compose, Kubernetes and most Python tooling read
 * 1.1; Go and most JS parsers read 1.2. A file can therefore convert cleanly
 * here and still behave differently in production.
 *
 * We find these by walking js-yaml's event stream and testing only *plain*
 * (unquoted) scalars — a quoted "no" is unambiguous and is never flagged.
 * Using events rather than a regex over the raw text means we get exact
 * character offsets and never match inside comments or strings.
 */

import { parseEvents, EVENT_ID, SCALAR_STYLE } from 'js-yaml';
import { offsetToLineCol } from './errors.js';

export interface Gotcha {
	line: number;
	column: number;
	position: number;
	end: number;
	/** The literal source text, e.g. "no". */
	text: string;
	/** How YAML 1.1 reads it. */
	as11: string;
	/** How YAML 1.2 reads it. */
	as12: string;
	message: string;
	hint: string;
}

const BOOLEAN_WORDS =
	/^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
/** Leading-zero integers: octal under 1.1, plain decimal under 1.2. */
const LEADING_ZERO_INT = /^-?0[0-7]+$/;
/** `0o`-prefixed octal: a 1.2 form that 1.1 reads as a string. */
const MODERN_OCTAL = /^-?0o[0-7]+$/;
/** Colon-separated numbers: base-60 under 1.1, a string under 1.2. */
const SEXAGESIMAL = /^-?[0-9]+(:[0-5]?[0-9])+$/;
/** Exponent floats without a decimal point: a number in 1.2, a string in 1.1. */
const BARE_EXPONENT = /^-?[0-9]+e[-+]?[0-9]+$/i;

function truthiness(text: string): string {
	return /^(y|Y|yes|Yes|YES|on|On|ON)$/.test(text) ? 'true' : 'false';
}

function classify(text: string): Omit<Gotcha, 'line' | 'column' | 'position' | 'end' | 'text'> | null {
	if (BOOLEAN_WORDS.test(text)) {
		const bool = truthiness(text);
		return {
			as11: bool,
			as12: `"${text}"`,
			message: `“${text}” is the boolean ${bool} in YAML 1.1, but the string "${text}" in YAML 1.2.`,
			hint: `Quote it as "${text}" to always get a string, or write ${bool} to always get a boolean.`,
		};
	}

	if (LEADING_ZERO_INT.test(text)) {
		const octal = parseInt(text, 8);
		const decimal = parseInt(text, 10);
		return {
			as11: String(octal),
			as12: String(decimal),
			message: `“${text}” is octal ${octal} in YAML 1.1, but decimal ${decimal} in YAML 1.2.`,
			hint: `This bites file permissions especially hard. Quote it as "${text}" to keep it a string, or write 0o${text.replace(/^-?0/, '')} for an unambiguous octal.`,
		};
	}

	if (MODERN_OCTAL.test(text)) {
		const value = parseInt(text.replace('0o', ''), 8);
		return {
			as11: `"${text}"`,
			as12: String(value),
			message: `“${text}” is the number ${value} in YAML 1.2, but the string "${text}" in YAML 1.1.`,
			hint: 'Older parsers don’t understand the 0o octal prefix. Use a quoted string if the consumer reads YAML 1.1.',
		};
	}

	if (SEXAGESIMAL.test(text)) {
		const parts = text.split(':').map(Number);
		const value = parts.reduce((acc, part) => acc * 60 + part, 0);
		return {
			as11: String(value),
			as12: `"${text}"`,
			message: `“${text}” is the base-60 number ${value} in YAML 1.1, but the string "${text}" in YAML 1.2.`,
			hint: `Times and version-like values should be quoted: "${text}".`,
		};
	}

	if (BARE_EXPONENT.test(text)) {
		return {
			as11: `"${text}"`,
			as12: String(Number(text)),
			message: `“${text}” is a number in YAML 1.2, but the string "${text}" in YAML 1.1.`,
			hint: 'YAML 1.1 requires a decimal point in exponent notation. Write it as 1.0e3, or quote it.',
		};
	}

	return null;
}

/**
 * Returns every plain scalar in `src` whose value depends on the YAML version.
 * Never throws: if the document doesn’t parse, there’s nothing useful to
 * report and the caller is already showing a parse error.
 */
export function findGotchas(src: string): Gotcha[] {
	if (!src.trim()) return [];

	let events;
	try {
		events = parseEvents(src, {});
	} catch {
		return [];
	}

	const found: Gotcha[] = [];

	for (const event of events) {
		if (event.type !== EVENT_ID.SCALAR) continue;
		// Quoted and block scalars are unambiguous by construction.
		if (event.style !== SCALAR_STYLE.PLAIN) continue;

		const text = src.slice(event.valueStart, event.valueEnd);
		const classified = classify(text);
		if (!classified) continue;

		const { line, column } = offsetToLineCol(src, event.valueStart);
		found.push({
			line,
			column,
			position: event.valueStart,
			end: event.valueEnd,
			text,
			...classified,
		});
	}

	return found;
}
