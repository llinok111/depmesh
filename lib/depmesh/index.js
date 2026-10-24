'use strict';

/**
 * Analysis orchestration: scan -> graph -> findings -> serialisable model.
 *
 * This is the single entry point used by the CLI, the tests and the UI. Keeping
 * one path means the numbers a user sees in the browser are produced by exactly
 * the code the test suite exercises.
 */

const path = require('node:path');
const {scan, posix} = require('./scan');
const {Graph} = require('./graph');
const {coverage} = require('./coverage');

function analyse(options = {}) {
	const started = Date.now();
	const scanResult = scan(options);
	const graph = new Graph(scanResult);
	const coverageReport = coverage(scanResult, graph);
	const cycles = graph.cycles();
	const stats = graph.stats();

	return {
		scan: scanResult,
		graph,
		coverage: coverageReport,
		cycles,
		stats,
		meta: {
			// `generatedAt` and `timingMs` are wall-clock facts, not properties of the
			// graph. A build that must be byte-reproducible passes `deterministic: true`
			// and gets a fixed stamp instead, so two runs on the same source produce the
			// same file.
			generatedAt: options.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString(),
			baseDir: posix(path.relative(process.cwd(), scanResult.baseDir)) || '.',
			tool: 'depmesh',
			upstream: 'pahen/madge 8.0.0',
			timingMs: options.deterministic ? 0 : Date.now() - started,
			deterministic: Boolean(options.deterministic)
		}
	};
}

/**
 * Compact, JSON-safe projection for the browser. Deliberately excludes the
 * per-specifier ledger detail (that lives in the coverage panel) and keeps
 * cycles as node lists plus verified sample paths.
 */
function toModel(analysis, {maxChainsPerNode = 0} = {}) {
	const {scan: scanResult, graph, cycles, coverage: coverageReport, stats} = analysis;

	const nodes = scanResult.nodes.map((node) => {
		const componentIndex = graph.sccs().componentOf.get(node.id);
		const inCycle = graph.sccs().cyclicNodes.has(node.id);
		return {
			id: node.id,
			ext: node.ext,
			dir: node.dir,
			in: node.in,
			out: node.out,
			bytes: node.bytes,
			specifiers: node.specifierCount,
			inCycle,
			component: inCycle ? componentIndex : -1,
			parsed: node.parsed
		};
	});

	const edges = scanResult.edges.map((edge) => ({
		s: edge.from,
		t: edge.to,
		k: [...edge.forms].sort().join('+'),
		n: edge.specifiers.length
	}));

	return {
		meta: {
			...analysis.meta,
			roots: scanResult.roots,
			baseDir: analysis.meta.baseDir,
			tsConfig: scanResult.tsConfig
		},
		stats,
		nodes,
		edges,
		externals: scanResult.externals.slice(0, 60),
		cycles: {
			componentCount: cycles.componentCount,
			cyclicNodeCount: cycles.cyclicNodeCount,
			selfLoops: cycles.selfLoops,
			components: cycles.components.map((component, index) => ({
				index,
				size: component.size,
				internalEdges: component.internalEdges,
				nodes: component.nodes,
				samples: component.samples,
				verified: component.verified
			}))
		},
		coverage: {
			files: coverageReport.files,
			specifiers: coverageReport.specifiers,
			edges: coverageReport.edges,
			unresolved: {
				total: coverageReport.unresolved.total,
				byReason: coverageReport.unresolved.byReason,
				findings: coverageReport.unresolved.findings.map((f) => ({
					reason: f.reason,
					count: f.count,
					severity: f.severity,
					label: f.label,
					examples: f.examples.slice(0, 5)
				})),
				nodesWithUnknownImports: coverageReport.unresolved.nodesWithUnknownImports
			},
			guarantees: coverageReport.guarantees,
			caveats: coverageReport.caveats
		},
		maxChainsPerNode
	};
}

/**
 * Impact report for one or more modules, ready for CLI output or UI display.
 */
function impactOf(analysis, id) {
	const {graph} = analysis;
	const dependents = graph.impact(id, {direction: 'dependents'});
	const dependencies = graph.impact(id, {direction: 'dependencies'});
	return {
		id,
		dependents: {
			total: dependents.total,
			byDepth: dependents.byDepth,
			truncated: dependents.truncated,
			direct: dependents.direct
		},
		dependencies: {
			total: dependencies.total,
			byDepth: dependencies.byDepth,
			truncated: dependencies.truncated,
			direct: dependencies.direct
		},
		cycles: graph.cycles().components
			.filter((component) => component.nodes.includes(id))
			.map((component) => ({size: component.size, nodes: component.nodes})),
		fan: {in: dependents.direct.length, out: dependencies.direct.length}
	};
}

module.exports = {analyse, toModel, impactOf};
