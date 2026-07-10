#!/usr/bin/env node
/**
 * Release step: moves `unreleased` entries in src/assets/whats-new.json into
 * a new dated entry prepended to `releases`, then empties `unreleased`.
 * Trims `releases` to the newest 10 versions to bound bundle size.
 *
 * Usage:
 *   node scripts/stamp-whats-new.mjs --version 2.15.0 --date 2026-07-15 [--require-entries]
 *
 * With --require-entries, an empty `unreleased` array fails the release
 * (exit 1) instead of silently skipping.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'src',
	'assets',
	'whats-new.json'
);
const MAX_RELEASES = 10;

function parseArgs(argv) {
	const args = { version: null, date: null, requireEntries: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--version') args.version = argv[++i];
		else if (arg === '--date') args.date = argv[++i];
		else if (arg === '--require-entries') args.requireEntries = true;
		else {
			console.error(`Unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	return args;
}

/** Detects the file's indentation unit (tab or N spaces) so the rewrite matches it. */
function detectIndent(raw) {
	const match = raw.match(/\n([ \t]+)\S/);
	if (!match) return '\t';
	return match[1][0] === '\t' ? '\t' : match[1];
}

function main() {
	const { version, date, requireEntries } = parseArgs(process.argv.slice(2));

	if (!version || !date) {
		console.error(
			'Usage: node scripts/stamp-whats-new.mjs --version <x.y.z> --date <YYYY-MM-DD> [--require-entries]'
		);
		process.exit(1);
	}

	const raw = readFileSync(DATA_PATH, 'utf8');
	const indent = detectIndent(raw);
	const data = JSON.parse(raw);
	const unreleased = data.unreleased ?? [];

	if (unreleased.length === 0) {
		if (requireEntries) {
			console.error(
				`No unreleased What's New entries in ${path.relative(process.cwd(), DATA_PATH)}. ` +
					`Add at least one entry to "unreleased" before releasing ${version}, ` +
					'or omit --require-entries for this release.'
			);
			process.exit(1);
		}
		console.log("No unreleased entries — nothing to stamp, whats-new.json left unchanged.");
		return;
	}

	data.releases = [{ version, date, entries: unreleased }, ...(data.releases ?? [])].slice(
		0,
		MAX_RELEASES
	);
	data.unreleased = [];

	writeFileSync(DATA_PATH, JSON.stringify(data, null, indent) + '\n');
	console.log(
		`Stamped ${unreleased.length} entr${unreleased.length === 1 ? 'y' : 'ies'} into release ${version} (${date}).`
	);
}

main();
