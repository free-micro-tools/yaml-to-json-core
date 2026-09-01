# yaml-to-json-core

YAML ⇄ JSON conversion with error messages a human can act on, and warnings for
every value whose meaning changes between YAML 1.1 and YAML 1.2.

This is the engine behind **[yamltojsonfree.com](https://yamltojsonfree.com/)** —
a free, browser-only [YAML to JSON converter](https://yamltojsonfree.com/),
[JSON to YAML converter](https://yamltojsonfree.com/json-to-yaml/),
[YAML validator](https://yamltojsonfree.com/yaml-validator/) and
[comment-preserving YAML formatter](https://yamltojsonfree.com/yaml-formatter/).
Pure TypeScript, no DOM, ~30 kB minified, runs in Node and the browser.

```ts
import { yamlToJson } from 'yaml-to-json-core';

const result = yamlToJson('name: app\nports: [80, 443\n');

if (!result.ok) {
  console.log(result.error.message); // A flow sequence opened with “[” is never closed.
  console.log(result.error.hint);    // Add the matching “]”, or rewrite the list in block style…
  console.log(result.error.line);    // 2   ← the line where “[” was opened, not where js-yaml gave up
}
```

## Why another YAML library?

It isn’t one — parsing is done by [js-yaml](https://github.com/nodeca/js-yaml)
(conversion) and [yaml](https://github.com/eemeli/yaml) (formatting). What this
package adds is everything a converter needs *around* a parser:

| | What you get |
|---|---|
| **Real error messages** | js-yaml reports an unclosed bracket, brace or quote as “deficient indentation” at an unrelated line. `describeError()` recovers the actual delimiter and where it opened, and translates the dozen most common parser messages into a sentence plus a fix. Both parsers’ wording is covered, so the same mistake reads the same way whichever engine raised it. |
| **YAML 1.1 vs 1.2 warnings** | `country: NO` is the string `"NO"` in YAML 1.2 and the boolean `false` in YAML 1.1 — the [Norway problem](https://yamltojsonfree.com/yaml-1-1-vs-1-2/). `findGotchas()` walks the parser’s event stream and reports every *plain* scalar that changes meaning between versions (booleans, leading-zero octals, `12:30` sexagesimals, bare exponents), with exact offsets and what each version produces. Quoted values are never flagged. |
| **Multi-document streams** | `---`-separated input becomes a JSON array or JSON Lines (one object per line, what `kubectl` expects), with the document count reported. |
| **Merge keys under YAML 1.2** | js-yaml’s Core schema drops `<<`, which silently breaks Docker Compose and GitLab CI files. Merge keys are resolved by default and can be switched off. |
| **Alias-bomb protection** | A “billion laughs” document is rejected by node budget *before* anything walks the structure — js-yaml’s `maxAliases` counts alias tokens, not the nodes they expand to. |
| **Safe JSON → YAML** | Output uses a schema that quotes anything either YAML version would read as a non-string, so it round-trips through PyYAML, Go and JavaScript parsers alike. |
| **Comment-preserving formatting** | `formatYaml()` reflows indentation and quoting while keeping every comment attached to its line, using the `yaml` package’s concrete syntax tree. |

## Install

```sh
npm install yaml-to-json-core
```

Requires Node 20+ or any modern browser. ESM only.

## API

### `yamlToJson(input, options?)` → `Result`

```ts
import { yamlToJson, DEFAULTS } from 'yaml-to-json-core';

const r = yamlToJson(src, { ...DEFAULTS, indent: '4', sortKeys: true, multiDoc: 'ndjson' });
if (r.ok) {
  r.output;    // string — the JSON
  r.docCount;  // number of YAML documents found
  r.notes;     // e.g. "3 comments dropped — JSON has no syntax for comments."
  r.gotchas;   // values that differ between YAML 1.1 and 1.2 (see below)
} else {
  r.error;     // ParseError — message, hint, line, column, position, raw
  r.gotchas;
}
```

### `jsonToYaml(input, options?)` → `Result`

JSON in, YAML out. Ambiguous strings (`"no"`, `"yes"`, `"on"`, `"off"`, `"022"`, `"12:30"`) come
out quoted so a YAML 1.1 consumer reads them back as strings.

### `formatYaml(input, options?)` → `Result`

Comment-preserving reformat. The `yaml` package is loaded lazily; call
`await loadYamlModule()` once before the first `formatYaml()`.

### `convert(input, direction, options?)` → `Result`

Dispatches to one of the three by `direction`: `'yaml-to-json' | 'json-to-yaml' | 'yaml-format'`.

### `findGotchas(src)` → `Gotcha[]`

Standalone Norway-problem detector. Each hit carries `line`, `column`, `position`, `end`,
the literal `text`, `as11`, `as12`, a `message` and a `hint`.

```ts
findGotchas('country: NO\nmode: 0644\n');
// [
//   { text: 'NO',   as11: 'false', as12: '"NO"', line: 1, … },
//   { text: '0644', as11: '420',   as12: '644',  line: 2, … },
// ]
```

### `describeError(err, src)` → `ParseError`

Turn a thrown js-yaml or `yaml` error into `{ message, hint?, line?, column?, position?, raw }`.
Useful if you run the parser yourself and only want the translations.

### Options

| Option | Values | Default | Notes |
|---|---|---|---|
| `version` | `'1.2'` \| `'1.1'` | `'1.2'` | Which YAML schema to parse with. Gotchas are only reported under 1.2. |
| `mergeKeys` | boolean | `true` | Resolve `<<:` merge keys. Off makes `<<` a literal key. |
| `indent` | `'2'` \| `'4'` \| `'tab'` \| `'minified'` | `'2'` | JSON indentation. YAML output falls back to 2 for `tab`/`minified`. |
| `sortKeys` | boolean | `false` | Sort object keys recursively. |
| `multiDoc` | `'array'` \| `'ndjson'` | `'array'` | How `---` streams are combined. |
| `maxAliases` | number | `10000` | Passed to js-yaml; the node-budget guard applies regardless. |

## Background reading

The behaviour above is documented at length on the site:

- [YAML 1.1 vs 1.2, and the Norway problem](https://yamltojsonfree.com/yaml-1-1-vs-1-2/) — every value that changes meaning, and which parsers read which version
- [Common YAML errors and how to fix them](https://yamltojsonfree.com/common-yaml-errors/) — the six mistakes behind almost every failed parse
- [Convert YAML to JSON in code](https://yamltojsonfree.com/convert-yaml-to-json-in-code/) — Python, Node.js, Go and yq equivalents, with the version gotchas each carries

## Development

```sh
npm install
npm run build   # tsc → dist/
npm test        # 90 fixture checks, no test framework
```

`src/convert.ts`, `src/errors.ts` and `src/gotchas.ts` are the same files the site ships
(only the `.js` import extensions differ); behaviour changes land here first and are then
mirrored there.

## License

[MIT](./LICENSE) © yamltojsonfree
