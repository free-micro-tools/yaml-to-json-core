/**
 * yaml-to-json-core — the conversion engine behind https://yamltojsonfree.com
 *
 * Pure functions, no DOM: YAML → JSON, JSON → YAML, comment-preserving YAML
 * formatting, human-readable parse errors, and detection of values whose
 * meaning changes between YAML 1.1 and YAML 1.2 (the "Norway problem").
 */
export {
	convert,
	yamlToJson,
	jsonToYaml,
	formatYaml,
	loadYamlModule,
	DEFAULTS,
	type Direction,
	type Failure,
	type Indent,
	type MultiDoc,
	type Options,
	type Result,
	type Success,
	type YamlVersion,
} from './convert.js';
export { describeError, describeUnclosed, findUnclosed, offsetToLineCol, type ParseError } from './errors.js';
export { findGotchas, type Gotcha } from './gotchas.js';
