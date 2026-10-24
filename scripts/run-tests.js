#!/usr/bin/env node
'use strict';

/**
 * Test runner.
 *
 * `node --test <dir>` behaves differently across Node versions and needs a
 * trailing slash to recurse, so the file list is passed explicitly instead.
 *
 * Usage:
 *   node scripts/run-tests.js            # all unit + integration suites
 *   node scripts/run-tests.js graph cli  # only matching files
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const testDir = path.join(__dirname, '..', 'test-depmesh');
const filters = process.argv.slice(2);

const files = fs.readdirSync(testDir)
	.filter((name) => name.endsWith('.test.js'))
	.filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
	.sort()
	.map((name) => path.join(testDir, name));

if (files.length === 0) {
	console.error('no test files matched');
	process.exit(2);
}

console.log(`running ${files.length} test file(s):`);
for (const file of files) {
	console.log(`  ${path.basename(file)}`);
}
console.log('');

const started = Date.now();
const result = spawnSync(process.execPath, ['--test', ...files], {stdio: 'inherit'});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\ntotal wall time: ${elapsed}s`);
process.exit(result.status === null ? 1 : result.status);
