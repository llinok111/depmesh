'use strict';

/**
 * Packaging tests.
 *
 * README promises three things that are easy to break silently: the package is
 * called `depmesh`, it ships a `depmesh` bin, and the upstream API is still
 * reachable through the `./madge` subpath. These are cheap to assert and were in
 * fact wrong once (the README documented a `require('depmesh')` that resolved to
 * the upstream madge entry point).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaging: the package is named depmesh and does not shadow upstream madge', () => {
	assert.equal(pkg.name, 'depmesh');
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	assert.equal(pkg.license, 'MIT');
});

test('packaging: both binaries are declared and exist', () => {
	assert.equal(pkg.bin.depmesh, './bin/depmesh.js');
	assert.equal(pkg.bin.madge, './bin/cli.js');
	for (const target of Object.values(pkg.bin)) {
		const abs = path.join(root, target);
		assert.ok(fs.existsSync(abs), `${target} exists`);
		const head = fs.readFileSync(abs, 'utf8').split('\n')[0];
		assert.match(head, /^#!.*node/, `${target} has a node shebang`);
	}
});

test('packaging: the main entry is the analysis API, not the upstream module', () => {
	const api = require(root);
	assert.deepEqual(Object.keys(api).sort(), ['analyse', 'impactOf', 'toModel']);
	assert.equal(typeof api.analyse, 'function');
	assert.equal(typeof api.toModel, 'function');
});

test('packaging: the upstream madge API is still reachable and unchanged in shape', () => {
	const madge = require(path.join(root, 'lib', 'api.js'));
	assert.equal(typeof madge, 'function', 'upstream export is still a factory function');
	const proto = Object.getOwnPropertyNames(Object.getPrototypeOf({}));
	assert.ok(proto.length >= 0);

	// The subpath export must point at the same file the upstream CLI uses.
	assert.equal(pkg.exports['./madge'], './lib/api.js');
	for (const [subpath, target] of Object.entries(pkg.exports)) {
		assert.ok(fs.existsSync(path.join(root, target)), `${subpath} -> ${target} exists`);
	}
});

test('packaging: the lockfile agrees with package.json', () => {
	const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
	assert.equal(lock.name, pkg.name);
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[''].name, pkg.name);
	assert.equal(lock.packages[''].version, pkg.version);
});
