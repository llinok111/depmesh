'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {analyse} = require('../lib/depmesh');
const {Graph} = require('../lib/depmesh/graph');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('cycles: two disjoint cycles plus a self loop are found exactly', () => {
	const a = analyse({roots: [fixture('cycles')]});
	const cycles = a.graph.cycles();

	assert.equal(a.stats.nodes, 8, 'eight real files were discovered');
	assert.equal(a.stats.edges, 10, 'ten real require() edges exist');
	assert.equal(cycles.componentCount, 2, 'a<->b and c->d->e->c are two components');
	assert.equal(cycles.selfLoops.length, 1, 'self.js requires itself once');

	assert.deepEqual(cycles.components.map((c) => c.size).sort(), [2, 3], 'component sizes are 2 and 3');

	for (const component of cycles.components) {
		assert.ok(component.samples.length > 0, 'each component gets at least one sample');
		for (const sample of component.samples) {
			assert.equal(sample[0], sample[sample.length - 1], 'sample starts and ends at the same node');
			for (let i = 0; i < sample.length - 1; i++) {
				assert.ok((a.graph.out.get(sample[i]) || []).includes(sample[i + 1]),
					`edge ${sample[i]} -> ${sample[i + 1]} exists in the real graph`);
			}
		}
		assert.equal(component.verified, true, 'component samples passed the closed-walk check');
	}

	const keys = cycles.components.flatMap((c) => c.samples.map((s) => s.join('>')));
	assert.equal(new Set(keys).size, keys.length, 'no duplicate rotations in the sample list');
});

test('cycles: acyclic modules are never reported as cyclic', () => {
	const a = analyse({roots: [fixture('cycles')]});
	for (const id of ['root.js', 'leaf.js']) {
		assert.equal(a.graph.sccs().cyclicNodes.has(id), false, `${id} must not be cyclic`);
	}
	assert.equal(a.graph.sccs().cyclicNodes.has('self.js'), true, 'self loop is cyclic');
});

test('SCC result matches an independent reachability oracle on a real 234-module corpus', () => {
	const a = analyse({
		roots: [path.join(__dirname, '..', 'samples', 'vue-core', 'packages')],
		tsConfig: path.join(__dirname, '..', 'samples', 'vue-core', 'tsconfig.json'),
		extensions: ['ts']
	});
	const graph = a.graph;
	const sccNodes = new Set(graph.sccs().cyclicNodes);

	// Oracle: node v is on a cycle iff v is reachable from v in one or more steps.
	const reachableFromSelf = (start) => {
		const seen = new Set();
		const queue = [...(graph.out.get(start) || [])];
		while (queue.length) {
			const node = queue.shift();
			if (node === start) {
				return true;
			}
			if (seen.has(node) || !graph.has(node)) {
				continue;
			}
			seen.add(node);
			queue.push(...(graph.out.get(node) || []));
		}
		return false;
	};

	const oracle = graph.ids.filter(reachableFromSelf);
	assert.ok(oracle.length > 100, `the corpus really contains many cyclic modules (${oracle.length})`);
	assert.deepEqual([...sccNodes].sort(), oracle.sort(),
		'Tarjan SCC membership must equal the brute-force cycle reachability set');

	for (const component of graph.cycles().components) {
		for (const sample of component.samples) {
			assert.ok(graph._isClosedWalk(sample), `sample is a real closed walk: ${sample.join(' -> ')}`);
		}
	}
});

test('paths: shortest path follows real edges and is genuinely shortest', () => {
	const a = analyse({roots: [fixture('cycles')]});
	const result = a.graph.shortestPath('root.js', 'e.js');
	assert.deepEqual(result.path, ['root.js', 'c.js', 'd.js', 'e.js']);
	assert.equal(result.length, 3);

	assert.deepEqual(a.graph.inn.get('e.js'), ['d.js']);
	assert.equal(a.graph.shortestPath('leaf.js', 'root.js').reachable, false, 'reverse direction is unreachable');
});

test('paths: every distinct simple path is enumerated, duplicates are not', () => {
	const a = analyse({roots: [fixture('diamond')]});
	const result = a.graph.paths('entry.js', 'z.js');
	assert.equal(result.truncated, false);
	assert.deepEqual(result.paths, [
		['entry.js', 'x.js', 'z.js'],
		['entry.js', 'y.js', 'z.js']
	]);
});

test('paths: enumeration reports its budget instead of pretending to be complete', () => {
	const a = analyse({roots: [fixture('diamond')]});
	const tight = a.graph.paths('entry.js', 'z.js', {maxPaths: 1});
	assert.equal(tight.count, 1);
	assert.equal(tight.truncated, true);
	assert.equal(tight.reason, 'max-paths');
	assert.equal(tight.budget.maxPaths, 1);

	const tooShort = a.graph.paths('entry.js', 'z.js', {maxLength: 1});
	assert.equal(tooShort.count, 0, 'a 1-hop budget cannot reach a 2-hop target');
	assert.equal(tooShort.truncated, false, 'an empty result from a small budget is not truncation');
});

test('impact: reverse closure equals an independent recount, with correct depth bands', () => {
	const a = analyse({roots: [fixture('cycles')]});
	const impact = a.graph.impact('e.js', {direction: 'dependents'});

	assert.deepEqual(impact.direct, ['d.js'], 'only d.js imports e.js directly');
	assert.deepEqual(impact.byDepth[1], ['d.js']);
	assert.deepEqual(impact.byDepth[2], ['c.js']);
	assert.deepEqual(impact.byDepth[3], ['root.js']);
	assert.equal(impact.total, 3);

	const inn = new Map();
	for (const edge of a.scan.edges) {
		if (!inn.has(edge.to)) {
			inn.set(edge.to, []);
		}
		inn.get(edge.to).push(edge.from);
	}
	const seen = new Set();
	const queue = ['e.js'];
	while (queue.length) {
		const node = queue.shift();
		for (const parent of inn.get(node) || []) {
			if (parent === 'e.js' || seen.has(parent)) {
				continue;
			}
			seen.add(parent);
			queue.push(parent);
		}
	}
	assert.deepEqual(impact.affected, [...seen].sort());
});

test('impact: a direct-only implementation would fail this assertion', () => {
	const a = analyse({roots: [fixture('cycles')]});
	const impact = a.graph.impact('e.js', {direction: 'dependents'});
	assert.equal(impact.direct.length, 1);
	assert.equal(impact.total, 3);
	assert.ok(impact.total > impact.direct.length,
		'one-hop-only code would return 1 here and fail');
});

test('graph: unknown ids are refused rather than silently returning empty results', () => {
	const a = analyse({roots: [fixture('clean')]});
	assert.equal(a.graph.shortestPath('nope.js', 'a.js').error, 'unknown-node');
	assert.equal(a.graph.impact('nope.js').error, 'unknown-node');
	assert.equal(a.graph.paths('nope.js', 'a.js').error, 'unknown-node');
});

test('graph: SCC survives a 20k-node chain without recursing to death', () => {
	const count = 20000;
	const scan = {
		baseDir: process.cwd(),
		roots: ['.'],
		extensions: ['js'],
		tsConfig: null,
		nodes: Array.from({length: count}, (_, i) => ({
			id: `m${i}.js`, ext: 'js', dir: '.', parsed: true, parseError: null, bytes: 10, specifierCount: 1, in: 0, out: 0
		})),
		edges: Array.from({length: count - 1}, (_, i) => ({
			from: `m${i}.js`, to: `m${i + 1}.js`, specifiers: ['./next'], forms: new Set(['require'])
		})),
		externals: [],
		ledger: {specifiers: count, resolvedInternal: count, resolvedExternal: 0, unresolved: [], byForm: {require: count}},
		discovery: {scanned: count, ignored: {}, roots: count},
		timing: {scanMs: 0}
	};

	const g = new Graph(scan);
	assert.equal(g.sccs().cyclic.length, 0, 'a chain has no cycles');

	const capped = g.impact(`m${count - 1}.js`);
	assert.equal(capped.truncated, true, 'the node budget is reported, not hidden');
	assert.ok(capped.total <= 4001, `budget respected (${capped.total})`);

	const full = g.impact(`m${count - 1}.js`, {maxNodes: count + 10});
	assert.equal(full.total, count - 1, 'without a budget the whole chain is covered');
});
