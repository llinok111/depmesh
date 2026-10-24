#!/usr/bin/env node
'use strict';

/**
 * Artifact freshness check.
 *
 * Two committed files are generated: the corpus report and the demo page. A
 * stale copy is a documentation bug that nothing else catches, so both are
 * regenerated and compared here.
 *
 * Comparison is line-ending agnostic on purpose. Git checks text files out with
 * the platform's convention (core.autocrlf), so a byte comparison reports
 * "stale" on Windows for a file that is in fact correct - a false positive that
 * would train everyone to ignore the check.
 *
 *   node scripts/check-artifacts.js
 *
 * Exit 0 when both artifacts match a fresh build, 1 when either is stale.
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const normalise = (buffer) => buffer.toString('utf8').replace(/\r\n/g, '\n');

const run = (args) => spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8'});

let failures = 0;

// --- 1. Markdown report: the generator has its own --check mode, which already
// compares normalised content.
{
	const result = run(['scripts/build-report.js', '--check']);
	if (result.status === 0) {
		console.log(`ok    docs/REPORT-vue-core.md`);
	} else {
		console.error(`FAIL  docs/REPORT-vue-core.md`);
		console.error((result.stderr || '').trim());
		failures++;
	}
}

// --- 2. Demo page: build to a scratch path so the committed file is untouched.
{
	const committed = path.join(root, 'demo', 'vue-core.html');
	const scratch = path.join(root, 'node_modules', '.depmesh-check', 'vue-core.html');

	if (!fs.existsSync(committed)) {
		console.error('FAIL  demo/vue-core.html: committed file is missing');
		failures++;
	} else {
		fs.mkdirSync(path.dirname(scratch), {recursive: true});
		const result = run([
			'bin/depmesh.js', 'build', 'samples/vue-core/packages',
			'--tsconfig', 'samples/vue-core/tsconfig.json',
			'--ext', 'ts',
			'--deterministic', '--quiet',
			'--out', scratch
		]);

		if (result.status !== 0) {
			console.error('FAIL  demo/vue-core.html: build failed');
			console.error((result.stderr || result.stdout || '').trim().split('\n').slice(-4).join('\n'));
			failures++;
		} else {
			const a = normalise(fs.readFileSync(committed));
			const b = normalise(fs.readFileSync(scratch));

			if (a === b) {
				console.log('ok    demo/vue-core.html');
			} else {
				console.error('FAIL  demo/vue-core.html: committed copy differs from a fresh build');
				const aLines = a.split('\n');
				const bLines = b.split('\n');
				for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
					if (aLines[i] !== bLines[i]) {
						console.error(`  first difference at line ${i + 1}`);
						console.error(`  committed: ${JSON.stringify((aLines[i] || '').slice(0, 100))}`);
						console.error(`  fresh:     ${JSON.stringify((bLines[i] || '').slice(0, 100))}`);
						break;
					}
				}
				failures++;
			}
		}
	}
}

if (failures) {
	console.error(`\n${failures} artifact(s) stale - regenerate with "npm run depmesh:report" / "npm run depmesh:build"`);
	process.exitCode = 1;
} else {
	console.log('\nall artifacts are up to date');
}
