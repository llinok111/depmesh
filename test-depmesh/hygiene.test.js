'use strict';

/**
 * Dependency hygiene.
 *
 * The scanner requires `precinct`, `filing-cabinet` and `typescript` directly.
 * Until this test existed they were only reachable as transitive dependencies of
 * `dependency-tree`, so which version actually ran was decided by npm's hoisting
 * rather than by this package. That is a ghost dependency: it works until the
 * tree changes shape.
 *
 * These tests read the manifest and the source, so they fail the moment a direct
 * require is added without a matching declaration.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const builtins = new Set(require('node:module').builtinModules);

function sourceFiles() {
	const dir = path.join(root, 'lib', 'depmesh');
	return [
		...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)),
		path.join(root, 'bin', 'depmesh.js')
	];
}

function bareRequires(file) {
	const source = fs.readFileSync(file, 'utf8');
	const found = [];
	for (const match of source.matchAll(/require\('([^']+)'\)/g)) {
		const specifier = match[1];
		if (specifier.startsWith('.') || specifier.startsWith('node:') || builtins.has(specifier)) {
			continue;
		}
		found.push(specifier.startsWith('@') ?
			specifier.split('/').slice(0, 2).join('/') :
			specifier.split('/')[0]);
	}
	return found;
}

test('hygiene: every package the added code requires is a declared dependency', () => {
	const declared = new Set([
		...Object.keys(pkg.dependencies || {}),
		...Object.keys(pkg.devDependencies || {})
	]);

	const missing = new Set();
	for (const file of sourceFiles()) {
		for (const name of bareRequires(file)) {
			if (!declared.has(name)) {
				missing.add(`${name} (required by ${path.relative(root, file)})`);
			}
		}
	}

	assert.deepEqual([...missing], [], 'no ghost dependencies: declare what you require');
});

test('hygiene: the three packages the scanner needs are direct dependencies', () => {
	for (const name of ['precinct', 'filing-cabinet', 'typescript']) {
		assert.ok(pkg.dependencies[name], `${name} is a direct dependency, not a transitive accident`);
	}
});

test('hygiene: typescript is a hard dependency because the scanner always imports it', () => {
	assert.equal(pkg.peerDependencies, undefined, 'no optional peer for something used unconditionally');
	const scanner = fs.readFileSync(path.join(root, 'lib', 'depmesh', 'scan.js'), 'utf8');
	assert.match(scanner, /require\('typescript'\)/, 'the scanner does import it unconditionally');
});

test('hygiene: the lockfile records the same direct dependencies', () => {
	const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
	const locked = lock.packages[''].dependencies || {};
	assert.deepEqual(Object.keys(locked).sort(), Object.keys(pkg.dependencies).sort());
	for (const [name, range] of Object.entries(pkg.dependencies)) {
		assert.equal(locked[name], range, `${name} range matches the manifest`);
	}
});
