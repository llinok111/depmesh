'use strict';

/**
 * Coverage ledger.
 *
 * The graph is only as trustworthy as the statement of what it does *not*
 * contain. This module turns the scanner's ledger into an explicit, machine
 * readable coverage report: which specifiers were seen, which resolved inside
 * the project, which resolved to installed packages (and are therefore outside
 * the graph by design), which failed to resolve and why.
 *
 * No number in this file is estimated. Every count comes from the scan.
 */

const REASONS = {
	'missing-relative': {
		severity: 'high',
		label: 'relative import that does not exist on disk',
		meaning: 'The source references a file that is absent; the graph is missing that edge.'
	},
	'alias-unresolved': {
		severity: 'high',
		label: 'tsconfig alias whose target does not exist',
		meaning: 'The alias matched a `paths` pattern but no candidate file was found.'
	},
	'missing-package': {
		severity: 'medium',
		label: 'bare specifier with no installed package',
		meaning: 'A dependency is declared but not installed, so its internal edges are unknown.'
	},
	'resolved-to-missing-file': {
		severity: 'high',
		label: 'resolver returned a path that does not exist',
		meaning: 'The resolver produced an answer the filesystem contradicts.'
	},
	'resolve-error': {
		severity: 'high',
		label: 'resolver threw',
		meaning: 'The specifier could not be resolved because resolution itself failed.'
	},
	'parse-error': {
		severity: 'critical',
		label: 'file could not be parsed',
		meaning: 'Every import in this file is unknown; treat it as a blind spot.'
	}
};

/**
 * Severities that make the graph *wrong* rather than merely *incomplete*.
 *
 * A missing relative import or an unparsable file means an edge that exists in
 * the source is absent from the graph: the answer is misleading, so the process
 * must fail. A bare specifier whose package is not installed only means that
 * dependency's internals are outside the graph — which is the documented
 * behaviour for every installed package anyway — so it is a warning, not a
 * failure. `--strict` promotes warnings to failures for CI that wants it.
 */
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

function blockingFindings(report) {
	return report.unresolved.findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity));
}

function warningFindings(report) {
	return report.unresolved.findings.filter((f) => !BLOCKING_SEVERITIES.has(f.severity));
}

function coverage(scan, graph) {
	const unresolved = scan.ledger.unresolved;
	const byReason = {};
	for (const item of unresolved) {
		byReason[item.reason] = (byReason[item.reason] || 0) + 1;
	}

	const parsed = scan.nodes.filter((n) => n.parsed).length;
	const unparsed = scan.nodes.filter((n) => !n.parsed);
	const specifiers = scan.ledger.specifiers;
	const internal = scan.ledger.resolvedInternal;
	const external = scan.ledger.resolvedExternal;
	const failed = unresolved.filter((u) => u.specifier !== null).length;

	// Only specifiers that name a file in this project are in scope. Bare
	// specifiers that resolve to installed packages are intentionally outside.
	const inScope = internal + failed;
	const internalRatio = inScope === 0 ? 1 : Number((internal / inScope).toFixed(4));

	const severityOrder = ['critical', 'high', 'medium', 'low'];
	const findings = Object.entries(byReason)
		.map(([reason, count]) => ({
			reason,
			count,
			severity: (REASONS[reason] || {severity: 'low'}).severity,
			label: (REASONS[reason] || {label: reason}).label,
			meaning: (REASONS[reason] || {}).meaning || '',
			examples: unresolved.filter((u) => u.reason === reason).slice(0, 10)
		}))
		.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) || b.count - a.count);

	const unknownEdgeNodes = [...new Set(unresolved.map((u) => u.file))].sort();

	return {
		files: {
			discovered: scan.discovery.scanned,
			nodes: scan.nodes.length,
			parsed,
			unparsed: unparsed.length,
			unparsedFiles: unparsed.map((n) => ({id: n.id, error: n.parseError})),
			ignored: scan.discovery.ignored,
			extensions: scan.extensions
		},
		specifiers: {
			total: specifiers,
			resolvedInternal: internal,
			resolvedExternal: external,
			failed,
			inScope,
			internalRatio,
			byForm: scan.ledger.byForm
		},
		edges: {
			total: scan.edges.length,
			multiSpecifier: scan.edges.filter((e) => e.specifiers.length > 1).length,
			typeOnly: scan.edges.filter((e) => [...e.forms].every((f) => f === 'type')).length
		},
		externalPackages: {
			count: scan.externals.length,
			top: scan.externals.slice(0, 15)
		},
		unresolved: {
			total: unresolved.length,
			byReason,
			findings,
			nodesWithUnknownImports: unknownEdgeNodes.length,
			nodeList: unknownEdgeNodes.slice(0, 50)
		},
		cycles: {
			components: graph.cycles().componentCount,
			cyclicNodes: graph.cycles().cyclicNodeCount,
			selfLoops: graph.cycles().selfLoops.length
		},
		guarantees: [
			'Every edge in the graph corresponds to a specifier that precinct extracted from a real file and filing-cabinet resolved to a real path on disk.',
			'No edge is inferred from naming conventions, directory structure, package manifests or documentation.',
			'Unresolved specifiers are listed individually; they never appear as edges.',
			'Installed third-party packages are counted but not expanded into the graph.'
		],
		caveats: [
			'Dynamic runtime imports built from variables (require(expr), import(path)) are invisible to static analysis and are therefore absent.',
			'Only extensions listed in `extensions` are scanned; files with other extensions are not nodes.',
			'Files that failed to parse contribute no outgoing edges.',
			'Type-only imports are edges by default; pass `--no-type-edges` to exclude them.'
		]
	};
}

/** Human readable text rendering of the coverage report. */
function coverageText(report) {
	const lines = [];
	const pct = (v) => `${(v * 100).toFixed(2)}%`;
	lines.push('Analysis coverage');
	lines.push('=================');
	lines.push('');
	lines.push(`Files scanned ............ ${report.files.discovered}`);
	lines.push(`Nodes in graph ........... ${report.files.nodes}`);
	lines.push(`Parsed successfully ...... ${report.files.parsed} (${pct(report.files.parsed / Math.max(1, report.files.nodes))})`);
	lines.push(`Failed to parse ......... ${report.files.unparsed}`);
	lines.push(`Extensions ............... ${report.files.extensions.join(', ')}`);
	lines.push('');
	lines.push(`Import specifiers seen ... ${report.specifiers.total}`);
	lines.push(`  resolved inside project  ${report.specifiers.resolvedInternal}`);
	lines.push(`  resolved to packages ... ${report.specifiers.resolvedExternal}`);
	lines.push(`  unresolved ............. ${report.specifiers.failed}`);
	lines.push(`Internal resolution rate . ${pct(report.specifiers.internalRatio)} of in-scope specifiers`);
	lines.push('');
	lines.push(`Edges in graph ........... ${report.edges.total}`);
	lines.push(`  merged (multi-specifier) ${report.edges.multiSpecifier}`);
	lines.push(`  type-only .............. ${report.edges.typeOnly}`);
	lines.push(`External packages ........ ${report.externalPackages.count} (not expanded)`);
	lines.push('');
	if (report.unresolved.total) {
		lines.push('Unresolved imports by reason');
		lines.push('---------------------------');
		for (const finding of report.unresolved.findings) {
			lines.push(`[${finding.severity}] ${finding.reason}: ${finding.count}`);
			lines.push(`    ${finding.label}`);
			for (const example of finding.examples.slice(0, 3)) {
				lines.push(`      ${example.file} -> ${example.specifier || '(parse)'}`);
			}
		}
		lines.push('');
	} else {
		lines.push('Unresolved imports ....... none');
		lines.push('');
	}
	lines.push(`Cyclic components ........ ${report.cycles.components}`);
	lines.push(`Nodes inside a cycle ..... ${report.cycles.cyclicNodes}`);
	lines.push(`Self loops ............... ${report.cycles.selfLoops}`);
	lines.push('');
	lines.push('Guarantees');
	lines.push('----------');
	for (const g of report.guarantees) {
		lines.push(`* ${g}`);
	}
	lines.push('');
	lines.push('Known limitations');
	lines.push('-----------------');
	for (const c of report.caveats) {
		lines.push(`* ${c}`);
	}
	return lines.join('\n');
}

module.exports = {coverage, coverageText, REASONS, blockingFindings, warningFindings, BLOCKING_SEVERITIES};
