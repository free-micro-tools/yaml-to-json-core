/**
 * Fixture checks for the conversion core. Run with `npm run test:lib`.
 * Deliberately dependency-free: it bundles with esbuild and runs on node.
 */
import {
	yamlToJson,
	jsonToYaml,
	formatYaml,
	loadYamlModule,
	DEFAULTS,
	type Options,
} from './convert.js';
import { findUnclosed } from './errors.js';

// The formatter's comment-preserving parser is loaded on demand in the browser.
await loadYamlModule();

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.log(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
	}
}

function opts(over: Partial<Options> = {}): Options {
	return { ...DEFAULTS, ...over };
}

console.log('\nEmpty and whitespace input (the js-yaml v5 load("") regression)');
{
	for (const [label, src] of [
		['empty string', ''],
		['spaces', '   '],
		['newlines', '\n\n'],
	] as const) {
		const r = yamlToJson(src);
		check(`${label} does not throw`, r.ok, true);
		check(`${label} yields empty output`, r.ok && r.output, '');
		check(`${label} reports 0 documents`, r.ok && r.docCount, 0);
	}
}

console.log('\nBasic structures');
{
	const r = yamlToJson('name: app\nports:\n  - 80\n  - 443\nmeta:\n  live: true\n');
	check('nested map and sequence', r.ok && JSON.parse(r.output), {
		name: 'app',
		ports: [80, 443],
		meta: { live: true },
	});
}
{
	const r = yamlToJson('a: 1\n', opts({ indent: 'minified' }));
	check('minified has no whitespace', r.ok && r.output, '{"a":1}');
}
{
	const r = yamlToJson('a:\n  b: 1\n', opts({ indent: 'tab' }));
	check('tab indent', r.ok && r.output, '{\n\t"a": {\n\t\t"b": 1\n\t}\n}');
}
{
	const r = yamlToJson('a:\n  b: 1\n', opts({ indent: '4' }));
	check('4-space indent', r.ok && r.output.includes('\n    "a"'), true);
}
{
	const r = yamlToJson('b: 1\na: 2\n', opts({ sortKeys: true }));
	check('sortKeys orders keys', r.ok && r.output.indexOf('"a"') < r.output.indexOf('"b"'), true);
}
{
	const r = yamlToJson('z:\n  y: 1\n  x: 2\n', opts({ sortKeys: true, indent: 'minified' }));
	check('sortKeys is recursive', r.ok && r.output, '{"z":{"x":2,"y":1}}');
}

console.log('\nMulti-document streams');
{
	const src = 'a: 1\n---\nb: 2\n---\nc: 3\n';
	const arr = yamlToJson(src, opts({ multiDoc: 'array' }));
	check('array mode wraps documents', arr.ok && JSON.parse(arr.output), [{ a: 1 }, { b: 2 }, { c: 3 }]);
	check('array mode counts documents', arr.ok && arr.docCount, 3);

	const nd = yamlToJson(src, opts({ multiDoc: 'ndjson' }));
	check('ndjson emits one line per document', nd.ok && nd.output.split('\n').length, 3);
	check('ndjson lines are minified', nd.ok && nd.output.split('\n')[0], '{"a":1}');

	const single = yamlToJson('a: 1\n');
	check('single document is not wrapped in an array', single.ok && JSON.parse(single.output), { a: 1 });
}

console.log('\nMerge keys (Docker Compose shape)');
{
	const src = 'defaults: &d\n  restart: always\nweb:\n  <<: *d\n  image: nginx\n';
	const on = yamlToJson(src, opts({ mergeKeys: true }));
	check('merge resolves <<', on.ok && JSON.parse(on.output).web, {
		restart: 'always',
		image: 'nginx',
	});

	const off = yamlToJson(src, opts({ mergeKeys: false }));
	check('merge off leaves a literal << key', off.ok && '<<' in JSON.parse(off.output).web, true);
}

console.log('\nYAML 1.1 vs 1.2 (the Norway problem)');
{
	const src = 'country: no\nenabled: yes\nperm: 022\ntime: 12:30\n';
	const v12 = yamlToJson(src, opts({ version: '1.2' }));
	check('1.2 keeps strings', v12.ok && JSON.parse(v12.output), {
		country: 'no',
		enabled: 'yes',
		perm: 22,
		time: '12:30',
	});

	const v11 = yamlToJson(src, opts({ version: '1.1' }));
	check('1.1 coerces', v11.ok && JSON.parse(v11.output), {
		country: false,
		enabled: true,
		perm: 18,
		time: 750,
	});

	check('gotchas found for all four', v12.ok && v12.gotchas.length, 4);
	check('gotcha reports the right line', v12.ok && v12.gotchas[0]!.line, 1);
	check('gotcha reports the right text', v12.ok && v12.gotchas[0]!.text, 'no');
}
{
	const quoted = yamlToJson('country: "no"\n');
	check('quoted values are never flagged', quoted.ok && quoted.gotchas.length, 0);
}
{
	const inComment = yamlToJson('a: 1 # no\n');
	check('comments are never flagged', inComment.ok && inComment.gotchas.length, 0);
}

console.log('\nUnclosed delimiters (js-yaml reports all of these as "deficient indentation")');
{
	const cases: Array<[string, string, number]> = [
		['unclosed [', 'name: app\nports: [80, 443\n', 2],
		['unclosed {', 'a: 1\nb: {c: 2\n', 2],
		['unclosed "', 'a: "hello\n', 1],
		["unclosed '", "a: 'hello\n", 1],
	];
	for (const [label, src, line] of cases) {
		const r = yamlToJson(src);
		check(`${label} fails`, r.ok, false);
		check(`${label} names the real cause`, !r.ok && /never closed/.test(r.error.message), true);
		check(`${label} points at the opening line`, !r.ok && r.error.line, line);
	}
	check('brackets inside strings are ignored', findUnclosed('a: "[unclosed in string"\n'), null);
	check('brackets inside comments are ignored', findUnclosed('a: 1 # [\n'), null);
	check('valid nesting is balanced', findUnclosed('a: [1, [2, 3], {b: 4}]\n'), null);
}

console.log('\nOther error translations');
{
	const tab = yamlToJson('a:\n\tb: 1\n');
	check('tab indentation is explained', !tab.ok && /tab character/i.test(tab.error.message), true);

	const dupe = yamlToJson('a: 1\na: 2\n');
	check('duplicate key is explained', !dupe.ok && /more than once/i.test(dupe.error.message), true);
	check('duplicate key points at line 2', !dupe.ok && dupe.error.line, 2);

	const alias = yamlToJson('a: *missing\n');
	check('missing anchor names the alias', !alias.ok && /\*missing/.test(alias.error.message), true);

	const colon = yamlToJson('title: foo: bar\n');
	check('unquoted colon gets a hint', !colon.ok && /colon/i.test(colon.error.hint ?? ''), true);

	const bomb =
		'a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n' +
		'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n';
	const guarded = yamlToJson(bomb, opts({ maxAliases: 20 }));
	check('alias bomb is caught', !guarded.ok && /billion laughs|enormous/i.test(guarded.error.message), true);
}

console.log('\nNotes');
{
	const withComments = yamlToJson('# leading\na: 1\n# trailing\n');
	check('comment loss is reported', withComments.ok && withComments.notes.some((n) => /comment/.test(n)), true);

	const big = yamlToJson('n: 123456789012345678901234567890\n');
	check('precision loss is reported', big.ok && big.notes.some((n) => /safe range/.test(n)), true);
}

console.log('\nBlock scalars, nulls, dates');
{
	const r = yamlToJson('text: |\n  line one\n  line two\nfolded: >\n  a b\nempty:\nalso: ~\n');
	const v = r.ok ? JSON.parse(r.output) : {};
	check('literal block keeps newlines', v.text, 'line one\nline two\n');
	check('folded block joins lines', v.folded, 'a b\n');
	check('empty value is null', v.empty, null);
	check('tilde is null', v.also, null);
}
{
	const r = yamlToJson('d: 2024-01-15T10:00:00Z\n', opts({ version: '1.1' }));
	check('1.1 timestamp serializes as ISO', r.ok && JSON.parse(r.output).d, '2024-01-15T10:00:00.000Z');
}

console.log('\nJSON to YAML');
{
	const r = jsonToYaml('{"name":"app","ports":[80,443]}');
	check('produces block YAML', r.ok && r.output, 'name: app\nports:\n  - 80\n  - 443\n');
}
{
	const r = jsonToYaml('{"country":"no","version":"1.10"}');
	check('ambiguous strings are quoted on the way out', r.ok && /['"]no['"]/.test(r.output), true);
}
{
	const r = jsonToYaml('{"b":1,"a":2}', opts({ sortKeys: true }));
	check('sortKeys applies', r.ok && r.output.indexOf('a:') < r.output.indexOf('b:'), true);
}
{
	const r = jsonToYaml('{ trailing: , }');
	check('invalid JSON fails', r.ok, false);
	check('invalid JSON is explained', !r.ok && /isn’t valid JSON/.test(r.error.message), true);
}
{
	const r = jsonToYaml('');
	check('empty JSON input does not throw', r.ok && r.output, '');
}

console.log('\nAlias expansion guard (js-yaml counts alias tokens, not the nodes they expand to)');
{
	// Six levels of nine-way nesting: 319 bytes in, 132 MB of JSON out. One
	// level deeper and JSON.stringify throws RangeError mid-conversion.
	const bomb =
		'l0: &l0 [1,2,3,4,5,6,7,8,9]\n' +
		[1, 2, 3, 4, 5]
			.map((i) => `l${i}: &l${i} [` + Array(9).fill(`*l${i - 1}`).join(',') + ']\n')
			.join('') +
		'top: [' + Array(9).fill('*l5').join(',') + ']\n';

	const started = Date.now();
	const r = yamlToJson(bomb);
	check('alias bomb is refused', r.ok, false);
	check('alias bomb is explained', !r.ok && /enormous structure/.test(r.error.message), true);
	check('alias bomb is refused quickly', Date.now() - started < 1000, true);

	// The guard must not reject documents that are merely large.
	const wide = 'items:\n' + Array(5000).fill('  - value').join('\n') + '\n';
	check('a large but ordinary document still converts', yamlToJson(wide).ok, true);
}

console.log('\nYAML formatting (comments preserved)');
{
	const r = formatYaml('# lead\nserver:\n      host:   0.0.0.0\n      port: 8080   # inline\n');
	check('indentation is normalized', r.ok && r.output, '# lead\nserver:\n  host: 0.0.0.0\n  port: 8080 # inline\n');
	check('comment preservation is reported', r.ok && r.notes.some((n) => /preserved/.test(n)), true);
}
{
	const r = formatYaml('a: 1\n---\nb: 2\n---\nc: 3\n');
	// Each document after the first prints its own "---", so joining on one as
	// well produced "---\n---\n" — an empty document between every pair.
	check('multi-document separators are not doubled', r.ok && r.output, 'a: 1\n---\nb: 2\n---\nc: 3\n');

	// The doubled separator made the output parse as twice as many documents as
	// went in, so a second pass kept growing the file.
	const again = r.ok ? formatYaml(r.output) : r;
	check('reformatting is idempotent', again.ok && again.output, r.ok && r.output);
	check('document count is unchanged by a round trip', again.ok && again.docCount, 3);
}
{
	const r = formatYaml('---\na: 1\n---\nb: 2\n');
	check('an explicit leading marker is kept', r.ok && r.output, '---\na: 1\n---\nb: 2\n');
}
{
	const r = formatYaml('b: 1\na:\n  d: 2\n  c: 3\n', opts({ sortKeys: true }));
	check('sortKeys is recursive, as it is for JSON', r.ok && r.output, 'a:\n  c: 3\n  d: 2\nb: 1\n');
}
{
	const r = formatYaml('a:\n  b:\n    c: 1\n', opts({ indent: '4' }));
	check('indent width applies', r.ok && r.output, 'a:\n    b:\n        c: 1\n');
}
{
	// The page exists to keep comments; emitting "" here deleted the only content.
	const r = formatYaml('# just a comment\n');
	check('a comment-only document is not emptied', r.ok && r.output, '# just a comment\n');
	check('and says why nothing changed', r.ok && r.notes.some((n) => /only comments/.test(n)), true);
}
{
	const r = formatYaml('name: app\n');
	check('a document without comments claims nothing about them', r.ok && r.notes.length, 0);
}
{
	const r = formatYaml('a: !Ref Foo\n');
	check('an unresolvable tag round-trips', r.ok && r.output, 'a: !Ref Foo\n');
	check('and is reported as a note', r.ok && r.notes.some((n) => /Unresolved tag/.test(n)), true);
}

console.log('\nFormatter errors get the same translations as the converter');
{
	const tab = formatYaml('a:\n\tb: 1\n');
	check('tab indentation is explained', !tab.ok && /tab character/i.test(tab.error.message), true);
	check('tab indentation points at line 2', !tab.ok && tab.error.line, 2);

	const dupe = formatYaml('a: 1\na: 2\n');
	check('duplicate key is explained', !dupe.ok && /more than once/i.test(dupe.error.message), true);

	const alias = formatYaml('a: *missing\n');
	check('missing anchor names the alias', !alias.ok && /\*missing/.test(alias.error.message), true);
	// The `yaml` package raises this after parsing, with no position at all.
	check('missing anchor is still located', !alias.ok && alias.error.line, 1);

	const bracket = formatYaml('name: app\nports: [80, 443\n');
	check('unclosed bracket names the real cause', !bracket.ok && /never closed/.test(bracket.error.message), true);
	check('unclosed bracket points at the opening line', !bracket.ok && bracket.error.line, 2);

	const colon = formatYaml('title: foo: bar\n');
	check('unquoted colon gets a hint', !colon.ok && /quote/i.test(colon.error.hint ?? ''), true);

	check('every failure keeps the parser wording for the detail panel', !tab.ok && tab.error.raw.length > 0, true);
	check('but strips the snippet from the headline', !tab.ok && /at line/.test(tab.error.message), false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
