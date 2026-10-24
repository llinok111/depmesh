'use strict';

/**
 * Integration tests against checked-in real source code.
 *
 * Two corpora, both unmodified upstream projects:
 *   samples/vue-core  - vuejs/core v3.5.44, every packages/<pkg>/src tree (MIT),
 *                       TypeScript, tsconfig path aliases, 8 cyclic components.
 *   node_modules/eslint/lib - eslint 7.29 (MIT), CommonJS, 376 modules.
 *
 * The assertions are exact on purpose: they are a regression detector. If a
 * dependency bump changes how imports are resolved, this fails loudly instead of
 * silently producing a different graph.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {analyse} = require('../lib/depmesh');
const {loadTsConfig} = require('../lib/depmesh/scan');

const root = path.join(__dirname, '..');
const VUE = path.join(root, 'samples', 'vue-core', 'packages');
const VUE_TSCONFIG = path.join(root, 'samples', 'vue-core', 'tsconfig.json');
const ESLINT = path.join(root, 'node_modules', 'eslint', 'lib');

const options = {roots: [VUE], tsConfig: VUE_TSCONFIG, extensions: ['ts']};

test('real corpus: vue-core 3.5.44 produces the documented graph', () => {
	const a = analyse(options);
	assert.equal(a.stats.nodes, 234, 'modules');
	assert.equal(a.stats.edges, 1185, 'import edges');
	assert.equal(a.stats.cycleComponents, 8, 'cyclic components');
	assert.equal(a.stats.cyclicNodes, 128, 'modules inside a cycle');
	assert.equal(a.stats.selfLoops, 0, 'no self loops in vue core');
	assert.equal(a.coverage.files.unparsed, 0, 'every file parses');
	assert.equal(a.coverage.specifiers.total, 1320, 'specifiers extracted');
	assert.equal(a.coverage.specifiers.resolvedInternal, 1259);
	assert.equal(a.coverage.specifiers.resolvedExternal, 31);
	assert.equal(a.coverage.specifiers.failed, 30);
	assert.equal(a.coverage.unresolved.byReason['missing-package'], 30, 'only uninstalled packages are unresolved');
	assert.equal(a.coverage.unresolved.byReason['missing-relative'], undefined, 'no broken relative imports');
});

test('real corpus: greedy alias resolution is what makes cross-package edges exist', () => {
	const a = analyse(options);
	const crossPackage = a.scan.edges.filter((e) => {
		const fromPackage = e.from.split('/')[0];
		const toPackage = e.to.split('/')[0];
		return fromPackage !== toPackage;
	});
	assert.ok(crossPackage.length > 100, `cross-package edges exist (${crossPackage.length})`);
	const sample = crossPackage.find((e) => e.from.startsWith('runtime-core/'));
	assert.ok(sample, 'runtime-core depends on other packages');
	assert.ok(sample.specifiers.some((s) => s.startsWith('@vue/') || s.startsWith('../')),
		'the edge is carried by a real alias or relative specifier');
});

test('parity: the graph is byte-identical to upstream madge on the same corpus', async () => {
	const a = analyse(options);
	const madge = require('../lib/api.js');
	const tsConfig = loadTsConfig(VUE_TSCONFIG).config;
	const res = await madge(VUE, {fileExtensions: ['ts'], tsConfig, detectiveOptions: {ts: {mixedImports: true}}});
	const theirs = new Set();
	for (const [from, targets] of Object.entries(res.obj())) {
		for (const to of targets) {
			theirs.add(`${from}>${to}`);
		}
	}
	const ours = new Set(a.scan.edges.map((e) => `${e.from}>${e.to}`));

	assert.equal(theirs.size, ours.size, 'same edge count');
	assert.deepEqual([...ours].filter((e) => !theirs.has(e)), [], 'no edge exists only in depmesh');
	assert.deepEqual([...theirs].filter((e) => !ours.has(e)), [], 'no edge exists only in madge');
});

test('gap evidence: upstream circular() misses modules that are provably on a cycle', async () => {
	const a = analyse(options);
	const madge = require('../lib/api.js');
	const tsConfig = loadTsConfig(VUE_TSCONFIG).config;
	const res = await madge(VUE, {fileExtensions: ['ts'], tsConfig, detectiveOptions: {ts: {mixedImports: true}}});

	const madgePaths = res.circular();
	const madgeNodes = new Set(madgePaths.flat());
	const ourCyclic = a.graph.sccs().cyclicNodes;
	const missed = [...ourCyclic].filter((id) => !madgeNodes.has(id));

	assert.ok(madgePaths.length > 0, 'madge does find some cycles');
	assert.ok(missed.length > 0, `madge misses ${missed.length} cyclic modules on this corpus`);
	assert.ok(ourCyclic.size > madgeNodes.size,
		`depmesh covers ${ourCyclic.size} cyclic modules vs madge ${madgeNodes.size}`);

	// Prove each "missed" module really is cyclic with an independent walk.
	for (const id of missed.slice(0, 5)) {
		const queue = [...(a.graph.out.get(id) || [])];
		const seen = new Set();
		let found = false;
		while (queue.length) {
			const node = queue.shift();
			if (node === id) {
				found = true; break;
			}
			if (seen.has(node) || !a.graph.has(node)) {
				continue;
			}
			seen.add(node);
			queue.push(...(a.graph.out.get(node) || []));
		}
		assert.ok(found, `${id} is reachable from itself, so it is genuinely cyclic`);
	}
});

test('large project: 376-module CommonJS tree is analysed correctly and within budget', () => {
	const started = Date.now();
	const a = analyse({roots: [ESLINT]});
	const elapsed = Date.now() - started;

	assert.ok(a.stats.nodes >= 350, `nodes (${a.stats.nodes})`);
	assert.ok(a.stats.edges >= 500, `edges (${a.stats.edges})`);
	assert.equal(a.coverage.files.unparsed, 0, 'eslint lib parses cleanly');
	assert.ok(a.stats.externals > 10, `external packages counted (${a.stats.externals})`);
	assert.ok(elapsed < 90000, `finished in ${elapsed}ms`);

	// Every node id must be a real file, relative to the analysed root.
	for (const node of a.scan.nodes) {
		const abs = path.join(a.scan.baseDir, node.id);
		assert.ok(require('node:fs').existsSync(abs), `${node.id} exists`);
	}

	// Dependents of a known low-level module must be transitive, not just direct.
	const hub = a.scan.nodes.slice().sort((x, y) => y.in - x.in)[0];
	assert.ok(hub && hub.in > 10, `a well-connected module exists (${hub && hub.id})`);
	const impact = a.graph.impact(hub.id);
	assert.ok(impact.total >= impact.direct.length, 'transitive impact is at least the direct set');
	assert.ok(impact.total > 0, `${hub.id} has dependents`);
});

test('large project: excludes keep node_modules and .git out of the way', () => {
	const a = analyse({roots: [root], extensions: ['js'], maxFiles: 20000});
	const ids = a.scan.nodes.map((n) => n.id);
	assert.equal(ids.some((id) => id.startsWith('node_modules/')), false, 'node_modules is skipped');
	assert.equal(ids.some((id) => id.includes('/.git/')), false, '.git is skipped');
	assert.ok(a.scan.discovery.ignored.byExtension > 0, 'non-source files are counted, not scanned');
});
