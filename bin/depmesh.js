#!/usr/bin/env node
'use strict';

/**
 * depmesh CLI.
 *
 * Subcommands mirror the four questions the tool answers, plus a build step
 * that emits a self-contained interactive page.
 */

const fs = require('node:fs');
const path = require('node:path');
const {analyse, toModel, impactOf} = require('../lib/depmesh');
const {coverageText, blockingFindings, warningFindings} = require('../lib/depmesh/coverage');
const {buildPage} = require('../lib/depmesh/ui');

const USAGE = `depmesh - dependency graph analysis on real source

Usage
  depmesh analyse  [options] <path...>     full report (text or json)
  depmesh coverage [options] <path...>     coverage ledger only
  depmesh impact   [options] <path...> --target <id>
  depmesh paths    [options] <path...> --from <id> --to <id>
  depmesh cycles   [options] <path...>
  depmesh build    [options] <path...> --out <file.html>

Common options
  --base <dir>            base directory for node ids (default: common root)
  --ext <list>            comma separated extensions (default: js,jsx,mjs,cjs,ts,tsx)
  --tsconfig <file>       tsconfig.json for aliases and path mapping
  --exclude <regexp>      repeatable; skip matching files
  --no-type-edges         drop edges that exist only as \`import type\`
  --strict                also fail on warnings (uninstalled packages)
  --deterministic         fixed timestamp + zero timing, for byte-reproducible builds
  --max-files <n>         refuse to analyse more than n files (default 5000)
  --json                  machine readable output
  --quiet                 suppress the progress line on stderr

Exit codes
  0  analysed; the graph is complete for every file that parsed
  1  analysed, but at least one edge is provably missing (broken relative
     import, unresolvable alias, unparsable file) - or a warning with --strict
  2  invalid arguments or analysis failed
`;

function parseArgs(argv) {
	const options = {
		roots: [],
		ext: null,
		base: null,
		tsconfig: null,
		exclude: [],
		typeEdges: true,
		strict: false,
		deterministic: false,
		maxFiles: 5000,
		json: false,
		quiet: false,
		out: null,
		target: null,
		from: null,
		to: null,
		maxPaths: 50,
		maxLength: 12,
		depth: 1
	};
	let command = null;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('-') && !command) {
			command = arg;
			continue;
		}
		switch (arg) {
			case '--base': options.base = argv[++i]; break;
			case '--ext': options.ext = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
			case '--tsconfig': options.tsconfig = argv[++i]; break;
			case '--exclude': options.exclude.push(argv[++i]); break;
			case '--no-type-edges': options.typeEdges = false; break;
			case '--strict': options.strict = true; break;
			case '--deterministic': options.deterministic = true; break;
			case '--max-files': options.maxFiles = Number(argv[++i]); break;
			case '--json': options.json = true; break;
			case '--quiet': options.quiet = true; break;
			case '--out': options.out = argv[++i]; break;
			case '--target': options.target = argv[++i]; break;
			case '--from': options.from = argv[++i]; break;
			case '--to': options.to = argv[++i]; break;
			case '--max-paths': options.maxPaths = Number(argv[++i]); break;
			case '--max-length': options.maxLength = Number(argv[++i]); break;
			case '--depth': options.depth = Number(argv[++i]); break;
			case '-h':
			case '--help': options.help = true; break;
			default:
				if (arg.startsWith('-')) {
					throw new Error(`unknown option: ${arg}`);
				}
				options.roots.push(arg);
		}
	}
	return {command, options};
}

function analyseOptions(options) {
	return {
		roots: options.roots.length ? options.roots : ['.'],
		baseDir: options.base || undefined,
		extensions: options.ext || undefined,
		tsConfig: options.tsconfig || undefined,
		exclude: options.exclude,
		includeTypeEdges: options.typeEdges,
		maxFiles: options.maxFiles,
		deterministic: options.deterministic
	};
}

function main(argv) {
	let parsed;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`depmesh: ${error.message}\n\n${USAGE}`);
		return 2;
	}
	const {command, options} = parsed;

	if (options.help || !command) {
		process.stdout.write(USAGE);
		return command ? 0 : 2;
	}

	const known = ['analyse', 'coverage', 'impact', 'paths', 'cycles', 'build'];
	if (!known.includes(command)) {
		process.stderr.write(`depmesh: unknown command "${command}"\n\n${USAGE}`);
		return 2;
	}

	let analysis;
	try {
		analysis = analyse(analyseOptions(options));
	} catch (error) {
		process.stderr.write(`depmesh: analysis failed: ${error.message}\n`);
		if (error.code) {
			process.stderr.write(`  code: ${error.code}\n`);
		}
		return 2;
	}

	const {graph, coverage: coverageReport, stats} = analysis;
	const blocking = blockingFindings(coverageReport);
	const warnings = warningFindings(coverageReport);

	switch (command) {
		case 'analyse': {
			if (options.json) {
				process.stdout.write(`${JSON.stringify({
					meta: analysis.meta,
					stats,
					coverage: coverageReport,
					cycles: graph.cycles()
				}, null, 2)}\n`);
				break;
			}
			process.stdout.write(`${reportText(analysis)}\n`);
			break;
		}
		case 'coverage': {
			if (options.json) {
				process.stdout.write(`${JSON.stringify(coverageReport, null, 2)}\n`);
			} else {
				process.stdout.write(`${coverageText(coverageReport)}\n`);
			}
			break;
		}
		case 'impact': {
			if (!options.target) {
				process.stderr.write('depmesh: --target <id> is required for impact\n');
				return 2;
			}
			const report = impactOf(analysis, options.target);
			if (report.dependents === undefined) {
				process.stderr.write(`depmesh: unknown node "${options.target}"\n`);
				return 2;
			}
			if (options.json) {
				process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			} else {
				process.stdout.write(`${impactText(report)}\n`);
			}
			break;
		}
		case 'paths': {
			if (!options.from || !options.to) {
				process.stderr.write('depmesh: --from and --to are required for paths\n');
				return 2;
			}
			const result = graph.paths(options.from, options.to, {
				maxLength: options.maxLength,
				maxPaths: options.maxPaths
			});
			if (result.error) {
				process.stderr.write(`depmesh: unknown node "${result.error === 'unknown-node' ? result.id : result.error}"\n`);
				return 2;
			}
			if (options.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} else {
				process.stdout.write(`Paths ${result.from} -> ${result.to}\n`);
				if (!result.count) {
					process.stdout.write('  (no path within the given budget)\n');
				}
				for (const p of result.paths) {
					process.stdout.write(`  ${p.join(' -> ')}\n`);
				}
				if (result.truncated) {
					process.stdout.write(`  ! truncated by ${result.reason} after ${result.budget.expansions} expansions\n`);
				}
			}
			break;
		}
		case 'cycles': {
			const cycles = graph.cycles();
			if (options.json) {
				process.stdout.write(`${JSON.stringify(cycles, null, 2)}\n`);
			} else {
				process.stdout.write(`${cyclesText(cycles)}\n`);
			}
			break;
		}
		case 'build': {
			if (!options.out) {
				process.stderr.write('depmesh: --out <file.html> is required for build\n');
				return 2;
			}
			const model = toModel(analysis);
			const html = buildPage(model);
			const outPath = path.resolve(options.out);
			fs.mkdirSync(path.dirname(outPath), {recursive: true});
			fs.writeFileSync(outPath, html);
			process.stdout.write(`wrote ${outPath} (${Buffer.byteLength(html)} bytes, ${model.nodes.length} nodes, ${model.edges.length} edges)\n`);
			break;
		}
		default:
			return 2;
	}

	if (!options.quiet) {
		if (blocking.length) {
			const count = blocking.reduce((sum, f) => sum + f.count, 0);
			process.stderr.write(`depmesh: ${count} import(s) missing from the graph (${blocking.map((f) => f.reason).join(', ')}) - see coverage\n`);
		} else if (warnings.length) {
			const count = warnings.reduce((sum, f) => sum + f.count, 0);
			process.stderr.write(`depmesh: ${count} warning(s) (${warnings.map((f) => f.reason).join(', ')}) - use --strict to fail on these\n`);
		}
	}

	return blocking.length || (options.strict && warnings.length) ? 1 : 0;
}

function reportText(analysis) {
	const {stats, graph, coverage: coverageReport} = analysis;
	const lines = [];
	lines.push(`depmesh report - ${analysis.meta.baseDir}`);
	lines.push('='.repeat(48));
	lines.push('');
	lines.push(`Modules ............... ${stats.nodes}`);
	lines.push(`Import edges .......... ${stats.edges}`);
	lines.push(`Graph density ......... ${stats.density}`);
	lines.push(`Entry points (no in) .. ${stats.roots}`);
	lines.push(`Leaves (no out) ....... ${stats.leaves}`);
	lines.push(`Cyclic components ..... ${stats.cycleComponents}`);
	lines.push(`Modules in a cycle .... ${stats.cyclicNodes}`);
	lines.push(`Self loops ............ ${stats.selfLoops}`);
	lines.push(`External packages ..... ${stats.externals}`);
	lines.push(`Unresolved imports .... ${stats.unresolved}`);
	lines.push(`Scan time ............. ${analysis.scan.timing.scanMs} ms`);
	lines.push('');
	if (stats.cycleComponents) {
		lines.push('Largest cyclic components');
		lines.push('-------------------------');
		for (const component of graph.cycles().components.slice(0, 5)) {
			lines.push(`  ${component.size} modules, ${component.internalEdges} internal edges`);
			if (component.samples[0]) {
				lines.push(`    e.g. ${component.samples[0].join(' -> ')}`);
			}
		}
		lines.push('');
	}
	lines.push(coverageText(coverageReport));
	return lines.join('\n');
}

function impactText(report) {
	const lines = [];
	lines.push(`Impact of changing ${report.id}`);
	lines.push('='.repeat(48));
	lines.push('');
	lines.push(`Depends on (direct) ......... ${report.dependencies.direct.length}`);
	lines.push(`Depended on by (direct) ..... ${report.dependents.direct.length}`);
	lines.push(`Transitive dependents ....... ${report.dependents.total}`);
	lines.push(`Transitive dependencies ..... ${report.dependencies.total}`);
	lines.push('');
	if (report.dependents.total) {
		lines.push('Transitive dependents by distance (what may break)');
		lines.push('--------------------------------------------------');
		for (const depth of Object.keys(report.dependents.byDepth).sort((a, b) => a - b)) {
			const list = report.dependents.byDepth[depth];
			lines.push(`  ${depth} hop(s): ${list.length}`);
			for (const id of list.slice(0, 8)) {
				lines.push(`    ${id}`);
			}
			if (list.length > 8) {
				lines.push(`    ... ${list.length - 8} more`);
			}
		}
		lines.push('');
	}
	if (report.cycles.length) {
		lines.push('Inside a cyclic component');
		lines.push('-------------------------');
		for (const cycle of report.cycles) {
			lines.push(`  ${cycle.size} modules (see depmesh cycles)`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

function cyclesText(cycles) {
	const lines = [];
	lines.push(`Cyclic components: ${cycles.componentCount}`);
	lines.push(`Modules inside a cycle: ${cycles.cyclicNodeCount}`);
	lines.push(`Self loops: ${cycles.selfLoops.length}`);
	lines.push('');
	for (const [index, component] of cycles.components.entries()) {
		lines.push(`#${index + 1}  ${component.size} modules, ${component.internalEdges} internal edges  (verified=${component.verified})`);
		lines.push(`    nodes: ${component.nodes.slice(0, 12).join(', ')}${component.nodes.length > 12 ? `, ... +${component.nodes.length - 12}` : ''}`);
		for (const sample of component.samples) {
			lines.push(`    cycle: ${sample.join(' -> ')}`);
		}
		lines.push('');
	}
	for (const loop of cycles.selfLoops) {
		lines.push(`self loop: ${loop[0]}`);
	}
	return lines.join('\n');
}

if (require.main === module) {
	process.exitCode = main(process.argv.slice(2));
}

module.exports = {main, parseArgs, USAGE};
