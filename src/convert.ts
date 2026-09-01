/**
 * The conversion core. Pure functions, no DOM — so it can be unit-tested and
 * later moved into a Web Worker without change.
 */

import {
	loadAll,
	dump,
	CORE_SCHEMA,
	YAML11_SCHEMA,
	DUMP_SCHEMA,
	mergeTag,
	type Schema,
} from 'js-yaml';
import { describeError, describeUnclosed, type ParseError } from './errors.js';
import { findGotchas, type Gotcha } from './gotchas.js';

export type YamlVersion = '1.1' | '1.2';
export type Indent = '2' | '4' | 'tab' | 'minified';
export type MultiDoc = 'array' | 'ndjson';

export interface Options {
	version: YamlVersion;
	/** Resolve `<<:` merge keys. Off means `<<` becomes a literal key. */
	mergeKeys: boolean;
	indent: Indent;
	sortKeys: boolean;
	multiDoc: MultiDoc;
	maxAliases: number;
}

export const DEFAULTS: Options = {
	version: '1.2',
	mergeKeys: true,
	indent: '2',
	sortKeys: false,
	multiDoc: 'array',
	maxAliases: 10_000,
};

export interface Success {
	ok: true;
	output: string;
	/** Number of YAML documents found (0 for empty input). */
	docCount: number;
	gotchas: Gotcha[];
	/** Non-fatal notes: dropped comments, precision loss, and so on. */
	notes: string[];
}

export interface Failure {
	ok: false;
	error: ParseError;
	gotchas: Gotcha[];
}

export type Result = Success | Failure;

function schemaFor(options: Options): Schema {
	const base = options.version === '1.1' ? YAML11_SCHEMA : CORE_SCHEMA;
	// YAML 1.1 resolves `<<` natively; the Core schema deliberately omits it,
	// which would otherwise turn `<<: *defaults` into a literal "<<" key and
	// silently produce wrong output for Docker Compose and GitLab CI files.
	return options.mergeKeys ? base.withTags(mergeTag) : base;
}

/** Recursively orders object keys so `JSON.stringify` emits them sorted. */
function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			sorted[key] = sortDeep(source[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * The largest structure we’re willing to serialize.
 *
 * Aliases share a reference rather than copying, so a 300-byte document with
 * six levels of nine-way nesting parses instantly and *then* expands to over a
 * hundred megabytes of JSON. js-yaml's `maxAliases` doesn’t catch it: that
 * counts alias tokens in the source (54 here), not the nodes they expand to.
 * Without this guard the tab locks up, and one level deeper `JSON.stringify`
 * throws RangeError before anything can be shown.
 */
const MAX_NODES = 2_000_000;

/**
 * True when `value` expands to more than `budget` nodes.
 *
 * Walks with an explicit stack and stops the moment the budget is exceeded, so
 * the cost is bounded even when the structure is effectively infinite. Shared
 * references are counted every time they’re reached — which is the point, as
 * that’s exactly what the serializer will do.
 */
function exceedsNodeBudget(value: unknown, budget: number): boolean {
	const stack: unknown[] = [value];
	let seen = 0;

	while (stack.length) {
		const node = stack.pop();
		if (++seen > budget) return true;
		if (Array.isArray(node)) {
			for (const item of node) stack.push(item);
		} else if (node && typeof node === 'object' && !(node instanceof Date)) {
			for (const item of Object.values(node as Record<string, unknown>)) {
				stack.push(item);
			}
		}
	}

	return false;
}

const TOO_LARGE: ParseError = {
	message: 'This document expands to an enormous structure through nested aliases.',
	hint: 'This is the classic “billion laughs” shape — often accidental, occasionally hostile. Each alias is a reference, so a few lines of nesting can expand to millions of nodes. Reduce the nesting of anchors and aliases.',
	raw: `Expansion exceeded ${MAX_NODES.toLocaleString('en')} nodes.`,
};

/** Precision is lost silently by JSON.parse/stringify — worth telling the user. */
function hasUnsafeInteger(value: unknown): boolean {
	if (typeof value === 'number') {
		return Number.isInteger(value) && !Number.isSafeInteger(value);
	}
	if (Array.isArray(value)) return value.some(hasUnsafeInteger);
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		return Object.values(value as Record<string, unknown>).some(hasUnsafeInteger);
	}
	return false;
}

/** YAML `!!binary` decodes to bytes, which JSON can’t represent directly. */
function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		let binary = '';
		for (const byte of value) binary += String.fromCharCode(byte);
		return typeof btoa === 'function' ? btoa(binary) : value;
	}
	if (value instanceof Map) return Object.fromEntries(value);
	if (value instanceof Set) return Array.from(value);
	return value;
}

function stringify(value: unknown, indent: Indent): string {
	if (indent === 'minified') return JSON.stringify(value, replacer) ?? '';
	const space = indent === 'tab' ? '\t' : Number(indent);
	return JSON.stringify(value, replacer, space) ?? '';
}

function countComments(src: string): number {
	let count = 0;
	for (const line of src.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('#')) count++;
	}
	return count;
}

/** YAML → JSON. */
export function yamlToJson(input: string, options: Options = DEFAULTS): Result {
	const gotchas = options.version === '1.2' ? findGotchas(input) : [];

	if (!input.trim()) {
		return { ok: true, output: '', docCount: 0, gotchas: [], notes: [] };
	}

	let docs: unknown[];
	try {
		// `loadAll` is used even for single documents: unlike `load` it returns
		// [] for empty input rather than throwing, and it handles `---`
		// separated streams in the same call.
		docs = loadAll(input, {
			schema: schemaFor(options),
			maxAliases: options.maxAliases,
		});
	} catch (err) {
		return { ok: false, error: describeError(err, input), gotchas };
	}

	// Checked before anything walks the structure: `sortDeep`, the serializer
	// and the precision check are all exponential on an alias bomb.
	if (exceedsNodeBudget(docs, MAX_NODES)) {
		return { ok: false, error: TOO_LARGE, gotchas };
	}

	const prepared = options.sortKeys ? docs.map(sortDeep) : docs;
	const notes: string[] = [];

	let output: string;
	try {
		if (prepared.length === 0) {
			output = '';
		} else if (prepared.length === 1) {
			output = stringify(prepared[0], options.indent);
		} else if (options.multiDoc === 'ndjson') {
			// One document per line — the shape kubectl and log pipelines expect.
			output = prepared.map((doc) => stringify(doc, 'minified')).join('\n');
		} else {
			output = stringify(prepared, options.indent);
		}
	} catch (err) {
		// Circular references and strings past the engine's length limit both
		// land here. Neither is a parse error, so they’re described directly.
		return {
			ok: false,
			gotchas,
			error:
				err instanceof RangeError
					? TOO_LARGE
					: {
							message: 'This document could not be written as JSON.',
							hint: 'It may contain a structure JSON can’t represent, such as a value that refers back to itself.',
							raw: err instanceof Error ? err.message : String(err),
						},
		};
	}

	if (prepared.length > 1) {
		notes.push(
			options.multiDoc === 'ndjson'
				? `${prepared.length} documents written as JSON Lines, one per line.`
				: `${prepared.length} documents combined into a JSON array.`
		);
	}

	const comments = countComments(input);
	if (comments > 0) {
		notes.push(
			`${comments} comment${comments === 1 ? '' : 's'} dropped — JSON has no syntax for comments.`
		);
	}

	if (prepared.some(hasUnsafeInteger)) {
		notes.push(
			'An integer exceeds JavaScript’s safe range, so its final digits are approximate.'
		);
	}

	return { ok: true, output, docCount: prepared.length, gotchas, notes };
}

/** JSON → YAML, for the reverse direction and the /json-to-yaml page. */
export function jsonToYaml(input: string, options: Options = DEFAULTS): Result {
	if (!input.trim()) {
		return { ok: true, output: '', docCount: 0, gotchas: [], notes: [] };
	}

	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch (err) {
		return {
			ok: false,
			error: jsonParseError(err, input),
			gotchas: [],
		};
	}

	const prepared = options.sortKeys ? sortDeep(value) : value;

	try {
		const output = dump(prepared, {
			// DUMP_SCHEMA quotes anything that either YAML version would read as
			// a non-string, so the result round-trips safely into 1.1 parsers.
			schema: DUMP_SCHEMA,
			indent: options.indent === 'tab' || options.indent === 'minified' ? 2 : Number(options.indent),
			sortKeys: options.sortKeys,
			lineWidth: 120,
		});
		return { ok: true, output, docCount: 1, gotchas: [], notes: [] };
	} catch (err) {
		return { ok: false, error: describeError(err, input), gotchas: [] };
	}
}

/**
 * `JSON.parse` errors vary by engine but modern V8 includes a character
 * position, which we lift into the same shape as the YAML errors.
 */
function jsonParseError(err: unknown, src: string): ParseError {
	const raw = err instanceof Error ? err.message : String(err);
	const match = /at position (\d+)/.exec(raw);
	const position = match ? Number(match[1]) : undefined;

	let line: number | undefined;
	let column: number | undefined;
	if (position !== undefined) {
		const before = src.slice(0, position);
		line = before.split('\n').length;
		column = position - (before.lastIndexOf('\n') + 1) + 1;
	}

	return {
		message: 'This isn’t valid JSON.',
		hint: 'Check for a trailing comma, a missing quote around a key, or single quotes where JSON requires double quotes.',
		line,
		column,
		position,
		raw,
	};
}

/* -------------------------------------------------------------------------
   YAML → YAML reformatting.

   js-yaml discards comments, so this one path uses the `yaml` package, whose
   CST keeps them attached to their nodes. It’s loaded through a dynamic
   import so its ~31 kB only reaches people who open the formatter.
   ---------------------------------------------------------------------- */

type YamlModule = typeof import('yaml');
let yamlModule: YamlModule | null = null;

export async function loadYamlModule(): Promise<void> {
	yamlModule ??= await import('yaml');
}

export function formatYaml(input: string, options: Options = DEFAULTS): Result {
	if (!input.trim()) {
		return { ok: true, output: '', docCount: 0, gotchas: [], notes: [] };
	}
	if (!yamlModule) {
		// loadYamlModule() hasn’t resolved yet; the caller re-runs when it does.
		return { ok: true, output: '', docCount: 0, gotchas: [], notes: [] };
	}
	const yaml = yamlModule;

	const gotchas = options.version === '1.2' ? findGotchas(input) : [];
	const notes: string[] = [];

	try {
		const docs = yaml.parseAllDocuments(input, {
			version: options.version,
			merge: options.mergeKeys,
			keepSourceTokens: true,
		});

		for (const doc of docs) {
			if (doc.errors.length) {
				const error = describeError(doc.errors[0], input);
				return {
					ok: false,
					gotchas,
					error: {
						...error,
						hint:
							error.hint ??
							'The formatter uses a stricter parser than the converter so that it can keep your comments. Fix the syntax and it will reformat.',
					},
				};
			}
		}

		// A document consisting only of comments or directives produces no
		// document nodes at all. Emitting "" there would silently delete the
		// very thing this page exists to preserve.
		if (docs.length === 0) {
			notes.push('There’s nothing to reformat — the input holds only comments.');
			return {
				ok: true,
				output: `${input.replace(/[ \t]+$/gm, '').trimEnd()}\n`,
				docCount: 0,
				gotchas,
				notes,
			};
		}

		const indentValue =
			options.indent === 'tab' || options.indent === 'minified'
				? 2
				: Number(options.indent);

		const rendered = docs.map((doc) => {
			if (options.sortKeys) sortNodeDeep(yaml, doc.contents);
			return doc.toString({ indent: indentValue, lineWidth: 0 });
		});

		// Every document after the first already prints its own "---" marker, so
		// joining on one as well produced "---\n---\n" — an extra empty document
		// that made the output parse as twice as many documents as went in.
		const output = rendered
			.map((text, i) => (i === 0 || /^---(\s|$)/.test(text) ? text : `---\n${text}`))
			.join('');

		if (options.indent === 'tab') {
			notes.push('YAML forbids tabs for indentation, so 2 spaces were used instead.');
		}
		if (options.indent === 'minified') {
			notes.push('YAML has no minified form, so 2 spaces were used instead.');
		}
		// Only claim the comments survived if there actually are some in the
		// output — the note used to appear even when every one had been dropped.
		if (countComments(output) > 0) {
			notes.push('Comments were preserved — this is what the JSON converter can’t do.');
		}
		if (docs.length > 1) {
			notes.push(`${docs.length} documents reformatted.`);
		}
		// Unresolvable tags parse fine and round-trip unchanged, but they’re
		// worth naming: they’re the values a JSON conversion would reject.
		for (const warning of new Set(docs.flatMap((doc) => doc.warnings.map((w) => w.message)))) {
			notes.push(warning.replace(/\s*at line \d+, column \d+:?[\s\S]*$/, ''));
		}

		return { ok: true, output, docCount: docs.length, gotchas, notes };
	} catch (err) {
		// Unresolved aliases are raised here rather than during the parse, so
		// this path carries real errors, not just crashes.
		return { ok: false, error: describeError(err, input), gotchas };
	}
}

/**
 * Sorts every mapping in a `yaml` document tree by key.
 *
 * The converter's `sortDeep` works on plain values; this has to work on the
 * node tree, because that’s what carries the comments. Sorting only the top
 * level — as this used to — left nested blocks in source order, so the same
 * option behaved differently on the formatter than on every other page.
 */
function sortNodeDeep(yaml: YamlModule, node: unknown): void {
	if (yaml.isMap(node)) {
		for (const item of node.items) sortNodeDeep(yaml, item.value);
		node.items.sort((a, b) =>
			String(yaml.isScalar(a.key) ? a.key.value : a.key).localeCompare(
				String(yaml.isScalar(b.key) ? b.key.value : b.key)
			)
		);
	} else if (yaml.isSeq(node)) {
		for (const item of node.items) sortNodeDeep(yaml, item);
	} else if (yaml.isPair(node)) {
		sortNodeDeep(yaml, node.value);
	}
}

export type Direction = 'yaml-to-json' | 'json-to-yaml' | 'yaml-format';

export function convert(
	input: string,
	direction: Direction,
	options: Options = DEFAULTS
): Result {
	if (direction === 'json-to-yaml') return jsonToYaml(input, options);
	if (direction === 'yaml-format') return formatYaml(input, options);
	return yamlToJson(input, options);
}
