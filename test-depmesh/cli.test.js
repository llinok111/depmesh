'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'bin', 'depmesh.js');
const fixture = (name) => path.join(__dirname, 'fixtures', name);

const run = (args) => {
	try {
		const stdout = execFileSync(process.execPath, [cli, ...args], {cwd: root, encoding: 'utf8'});
		return {code: 0, stdout, stderr: ''};
	} catch (error) {
		return {code: error.status, stdout: error.stdout || '', stderr: error.stderr || ''};
	}
};

test('cli: analyse --json emits a machine readable report', () => {
	const {code, stdout} = run(['analyse', fixture('clean'), '--json']);
	assert.equal(code, 0);
	const report = JSON.parse(stdout);
	assert.equal(report.stats.nodes, 3);
	assert.equal(report.stats.edges, 3);
	assert.equal(report.coverage.specifiers.failed, 0);
	assert.equal(report.meta.upstream, 'pahen/madge 8.0.0');
});

test('cli: exit code 1 when an import could not be resolved', () => {
	const clean = run(['analyse', fixture('clean'), '--quiet']);
	assert.equal(clean.code, 0);

	const broken = run(['analyse', fixture('missing'), '--quiet']);
	assert.equal(broken.code, 1, 'unresolved imports are a non-zero exit but not a crash');
	assert.match(broken.stdout, /missing-relative/);
});

test('cli: exit code 2 on invalid input', () => {
	assert.equal(run(['nonsense']).code, 2);
	assert.equal(run(['analyse', '--nope']).code, 2, 'unknown option');
	assert.equal(run(['impact', fixture('clean')]).code, 2, 'impact needs --target');
	assert.equal(run(['paths', fixture('clean'), '--from', 'a.js']).code, 2, 'paths needs --to');
	assert.equal(run(['build', fixture('clean')]).code, 2, 'build needs --out');
});

test('cli: an uninstalled package warns but does not fail the build; --strict does', () => {
	const lenient = run(['analyse', fixture('warn-only'), '--quiet']);
	assert.equal(lenient.code, 0, 'a bare specifier for an absent package is not a broken graph');
	assert.match(lenient.stdout, /missing-package: 1/);

	const strict = run(['analyse', fixture('warn-only'), '--quiet', '--strict']);
	assert.equal(strict.code, 1, '--strict promotes warnings to failures');

	// The same distinction must hold for the HTML build, otherwise `npm run
	// build && publish` breaks on a project that merely has optional deps.
	const out = path.join(os.tmpdir(), `depmesh-warn-${process.pid}.html`);
	const build = run(['build', fixture('warn-only'), '--out', out, '--quiet']);
	assert.equal(build.code, 0, build.stderr);
	fs.rmSync(out, {force: true});
});

test('cli: paths and impact print concrete results', () => {
	const paths = run(['paths', fixture('diamond'), '--from', 'entry.js', '--to', 'z.js']);
	assert.equal(paths.code, 0);
	assert.match(paths.stdout, /entry\.js -> x\.js -> z\.js/);
	assert.match(paths.stdout, /entry\.js -> y\.js -> z\.js/);

	const impact = run(['impact', fixture('cycles'), '--target', 'e.js']);
	assert.equal(impact.code, 0);
	assert.match(impact.stdout, /Transitive dependents \.+ 3/);
	assert.match(impact.stdout, /2 hop\(s\): 1/);
});

test('cli: cycles lists components with verified samples', () => {
	const {code, stdout} = run(['cycles', fixture('cycles')]);
	assert.equal(code, 0);
	assert.match(stdout, /Cyclic components: 2/);
	assert.match(stdout, /verified=true/);
});

test('cli: build writes a self-contained page with the model embedded', () => {
	const out = path.join(os.tmpdir(), `depmesh-${process.pid}.html`);
	const {code, stdout} = run(['build', fixture('cycles'), '--out', out]);
	assert.equal(code, 0, stdout);
	const html = fs.readFileSync(out, 'utf8');
	assert.match(html, /<script type="application\/json" id="depmesh-model">/);
	assert.match(html, /id="cv"/);
	assert.equal(/src="http/.test(html), false, 'no remote scripts');
	assert.equal(/href="http/.test(html), false, 'no remote styles');

	const payload = html.split('<script type="application/json" id="depmesh-model">')[1].split('</script>')[0];
	const model = JSON.parse(payload);
	assert.equal(model.nodes.length, 8);
	assert.equal(model.edges.length, 10);
	assert.equal(model.cycles.componentCount, 2);
	assert.equal(model.coverage.specifiers.failed, 0);

	fs.rmSync(out, {force: true});
});

test('cli: embedded JSON cannot terminate its own script tag', () => {
	const {buildPage} = require('../lib/depmesh/ui');
	const model = {
		meta: {baseDir: '</script><img src=x onerror=alert(1)>', generatedAt: 'now'},
		stats: {nodes: 1, edges: 0, density: 0, roots: 1, leaves: 1, cycleComponents: 0, cyclicNodes: 0, selfLoops: 0, externals: 0, unresolved: 0},
		nodes: [{id: '</script>evil.js', ext: 'js', dir: '', in: 0, out: 0, bytes: 1, specifiers: 0, inCycle: false, component: -1, parsed: true}],
		edges: [],
		externals: [],
		cycles: {componentCount: 0, cyclicNodeCount: 0, selfLoops: [], components: []},
		coverage: {
			files: {discovered: 1, nodes: 1, parsed: 1, unparsed: 0, unparsedFiles: [], ignored: {}, extensions: ['js']},
			specifiers: {total: 0, resolvedInternal: 0, resolvedExternal: 0, failed: 0, inScope: 0, internalRatio: 1, byForm: {}},
			edges: {total: 0, multiSpecifier: 0, typeOnly: 0},
			unresolved: {total: 0, byReason: {}, findings: [], nodesWithUnknownImports: 0},
			guarantees: [],
			caveats: []
		}
	};
	const html = buildPage(model, {coverageText: 'x'});
	const payload = html.split('<script type="application/json" id="depmesh-model">')[1].split('</script>')[0];
	assert.equal(payload.includes('</script>'), false, 'raw closing tag never reaches the payload');
	assert.equal(JSON.parse(payload).nodes[0].id, '</script>evil.js', 'the value survives intact');
});
