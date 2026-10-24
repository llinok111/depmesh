#!/usr/bin/env node
'use strict';

/**
 * Reproducible measurement of what upstream madge 8.0.0 does and does not
 * report on a real corpus, compared against depmesh on the identical edge set.
 *
 * Every number quoted in docs/UPSTREAM-FINDINGS.md is produced here. Run:
 *
 *   node scripts/measure-upstream.js
 *
 * No network access, no Graphviz, no writes outside stdout.
 */

const path = require('node:path');
const madge = require('../lib/api');
const {analyse} = require('../lib/depmesh');
const {loadTsConfig} = require('../lib/depmesh/scan');

const root = path.join(__dirname, '..');
const CORPUS = path.join(root, 'samples', 'vue-core', 'packages');
const TSCONFIG = path.join(root, 'samples', 'vue-core', 'tsconfig.json');

const depmeshOptions = {roots: [CORPUS], tsConfig: TSCONFIG, extensions: ['ts']};

function edgeSetOf(obj) {
	const set = new Set();
	for (const [from, targets] of Object.entries(obj)) {
		for (const to of targets) {
			set.add(`${from}>${to}`);
		}
	}
	return set;
}

function cyclicModulesReachable(graph) {
	// Independent oracle: a node is cyclic iff it can reach itself in >= 1 step.
	const out = [];
	for (const id of graph.ids) {
		const seen = new Set();
		const queue = [...(graph.out.get(id) || [])];
		let found = false;
		while (queue.length) {
			const node = queue.shift();
			if (node === id) {
				found = true;
				break;
			}
			if (seen.has(node) || !graph.has(node)) {
				continue;
			}
			seen.add(node);
			queue.push(...(graph.out.get(node) || []));
		}
		if (found) {
			out.push(id);
		}
	}
	return out;
}

async function main() {
	const report = {};

	const analysis = analyse(depmeshOptions);
	const {graph, scan, stats} = analysis;
	report.depmesh = {
		nodes: stats.nodes,
		edges: stats.edges,
		cyclicComponents: stats.cycleComponents,
		cyclicNodes: stats.cyclicNodes,
		scanMs: scan.timing.scanMs
	};

	const oracle = cyclicModulesReachable(graph);
	report.oracle = {cyclicNodes: oracle.length, matchesScc: oracle.length === stats.cyclicNodes};

	// --- parity with upstream, using the repaired tsconfig
	const repaired = loadTsConfig(TSCONFIG);
	const res = await madge(CORPUS, {
		fileExtensions: ['ts'],
		tsConfig: repaired.config,
		detectiveOptions: {ts: {mixedImports: true}}
	});
	const madgeEdges = edgeSetOf(res.obj());
	const ourEdges = new Set(scan.edges.map((e) => `${e.from}>${e.to}`));
	report.parity = {
		madgeEdges: madgeEdges.size,
		depmeshEdges: ourEdges.size,
		onlyMadge: [...madgeEdges].filter((e) => !ourEdges.has(e)).length,
		onlyDepmesh: [...ourEdges].filter((e) => !madgeEdges.has(e)).length
	};

	// --- upstream cycle report vs SCC
	const circular = res.circular();
	const mentioned = new Set(circular.flat());
	const cyclic = graph.sccs().cyclicNodes;
	const missed = [...cyclic].filter((id) => !mentioned.has(id));
	report.upstreamCycles = {
		pathRows: circular.length,
		distinctRows: new Set(circular.map((p) => p.join('>'))).length,
		modulesMentioned: mentioned.size,
		modulesActuallyCyclic: cyclic.size,
		missedByUpstream: missed.length,
		missedSample: missed.slice(0, 8)
	};

	// Each "missed" module must be provably cyclic by an independent walk.
	report.upstreamCycles.missedProof = missed.slice(0, 8).map((id) => {
		const seen = new Set();
		const queue = [...(graph.out.get(id) || [])];
		let ok = false;
		while (queue.length) {
			const node = queue.shift();
			if (node === id) {
				ok = true;
				break;
			}
			if (seen.has(node) || !graph.has(node)) {
				continue;
			}
			seen.add(node);
			queue.push(...(graph.out.get(node) || []));
		}
		return {id, reachableFromSelf: ok};
	});

	// Supersets: how many reported rows contain another reported row as a
	// contiguous sub-path (i.e. are not themselves minimal).
	const bodies = circular.map((p) => p.join('>'));
	let supersets = 0;
	for (const row of bodies) {
		if (bodies.some((other) => other !== row && row.includes(other))) {
			supersets++;
		}
	}
	report.upstreamCycles.supersetRows = supersets;

	// --- the tsconfig paths/baseUrl effect, same corpus, same detector
	const rawTsConfig = (() => {
		const ts = require('typescript');
		const file = ts.readJsonConfigFile(TSCONFIG, ts.sys.readFile);
		const parsed = ts.parseJsonSourceFileConfigFileContent(file, ts.sys, path.dirname(TSCONFIG));
		return parsed.raw;
	})();
	const withoutFix = await madge(CORPUS, {
		fileExtensions: ['ts'],
		tsConfig: rawTsConfig,
		detectiveOptions: {ts: {mixedImports: true}}
	});
	const withoutEdges = edgeSetOf(withoutFix.obj());
	report.tsconfigFix = {
		withoutBaseUrl: {edges: withoutEdges.size, skipped: withoutFix.warnings().skipped.length},
		withBaseUrl: {edges: madgeEdges.size, skipped: res.warnings().skipped.length},
		edgesRecovered: madgeEdges.size - withoutEdges.size,
		aliasOnlyEdges: [...madgeEdges].filter((e) => !withoutEdges.has(e)).length
	};

	// --- depends() is one hop; impact is the closure
	const hub = scan.nodes.slice().sort((a, b) => b.in - a.in || a.id.localeCompare(b.id))[0];
	const upstreamDepends = res.depends(hub.id);
	const impact = graph.impact(hub.id);
	report.impact = {
		hub: hub.id,
		upstreamDepends: upstreamDepends.length,
		depmeshDirect: impact.direct.length,
		depmeshTransitive: impact.total,
		shareOfGraph: Number((impact.total / stats.nodes).toFixed(4))
	};

	console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
