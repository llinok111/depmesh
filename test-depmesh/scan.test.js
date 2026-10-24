'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {analyse} = require('../lib/depmesh');
const {scan, loadTsConfig} = require('../lib/depmesh/scan');
const {coverageText} = require('../lib/depmesh/coverage');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('missing dependencies: reported individually, never turned into edges', () => {
	const a = analyse({roots: [fixture('missing')]});
	const unresolved = a.scan.ledger.unresolved;

	assert.equal(a.scan.edges.length, 1, 'only ok.js -> helper.js is a real edge');
	assert.equal(a.scan.edges[0].specifiers[0], './helper');

	const bySpecifier = new Map(unresolved.map((u) => [u.specifier, u]));
	assert.equal(bySpecifier.get('./does-not-exist').reason, 'missing-relative');
	assert.equal(bySpecifier.get('this-package-is-not-installed').reason, 'missing-package');

	// The missing target must NOT appear as a node: a missing file has no code.
	assert.equal(a.graph.has('does-not-exist.js'), false);
	assert.equal(a.graph.has('this-package-is-not-installed'), false);

	const cov = a.coverage;
	assert.equal(cov.unresolved.total, 2);
	assert.equal(cov.unresolved.byReason['missing-relative'], 1);
	assert.equal(cov.specifiers.inScope, 3, 'one resolved + two failed imports are in scope');
	assert.equal(cov.specifiers.internalRatio, Number((1 / 3).toFixed(4)));
});

test('tsconfig paths without baseUrl resolve only because depmesh repairs the config', () => {
	const withPatch = analyse({
		roots: [fixture('alias/src')],
		tsConfig: fixture('alias/tsconfig.json')
	});
	const withoutPatch = analyse({
		roots: [fixture('alias/src')],
		tsConfig: fixture('alias/tsconfig.json'),
		injectBaseUrl: false
	});

	assert.ok(withPatch.scan.tsConfig.patches.includes('tsconfig-paths-baseurl'));
	assert.equal(withPatch.scan.edges.length, 3, 'two runtime aliases/relative imports plus one type-only alias');
	assert.deepEqual(
		withPatch.scan.edges.map((e) => `${e.from}>${e.to}`).sort(),
		['index.ts>math.ts', 'index.ts>types.ts', 'index.ts>util.ts']
	);

	// Control: the untouched config loses every alias edge. This is what madge and
	// dependency-tree do today, and it is why the patch exists.
	assert.equal(withoutPatch.scan.edges.length, 1, 'only the relative import survives');
	assert.deepEqual(withoutPatch.scan.edges.map((e) => `${e.from}>${e.to}`), ['index.ts>math.ts']);
	assert.equal(withoutPatch.scan.ledger.unresolved.length, 2);
	assert.deepEqual(withoutPatch.scan.ledger.unresolved.map((u) => u.specifier).sort(), ['@app/types', '@app/util']);
});

test('type-only edges can be excluded explicitly', () => {
	const a = analyse({roots: [fixture('alias/src')], tsConfig: fixture('alias/tsconfig.json'), includeTypeEdges: false});
	assert.deepEqual(a.scan.edges.map((e) => `${e.from}>${e.to}`).sort(), ['index.ts>math.ts', 'index.ts>util.ts']);
	assert.equal(a.scan.typeEdgesDropped, 1);
});

test('syntax errors are detected instead of being silently seen as "no imports"', () => {
	const a = analyse({roots: [fixture('parse-error')]});
	assert.equal(a.coverage.files.unparsed, 1);
	assert.equal(a.coverage.files.unparsedFiles[0].id, 'broken.js');
	assert.match(a.coverage.files.unparsedFiles[0].error, /syntax error/);
	assert.equal(a.scan.ledger.unresolved.filter((u) => u.reason === 'parse-error').length, 1);
	assert.equal(a.scan.edges.length, 0, 'a broken file contributes no edges');
});

test('specifiers inside comments and strings never become edges', () => {
	const a = analyse({roots: [fixture('clean')]});
	const ids = a.scan.edges.map((e) => `${e.from}>${e.to}`);
	assert.deepEqual(ids.sort(), ['b.js>a.js', 'entry.js>a.js', 'entry.js>b.js']);
	// The comment "never imported by anything" in the alias fixture must not create
	// a relationship either.
	const alias = analyse({roots: [fixture('alias/src')], tsConfig: fixture('alias/tsconfig.json')});
	assert.equal(alias.scan.edges.some((e) => e.from === 'orphan.ts'), false);
});

test('every edge is backed by a specifier that exists verbatim in the importing file', () => {
	const a = analyse({roots: [path.join(__dirname, '..', 'samples', 'vue-core', 'packages')], tsConfig: path.join(__dirname, '..', 'samples', 'vue-core', 'tsconfig.json'), extensions: ['ts']});
	const cache = new Map();
	for (const edge of a.scan.edges) {
		const source = cache.get(edge.from) || fs.readFileSync(path.join(a.scan.baseDir, edge.from), 'utf8');
		cache.set(edge.from, source);
		assert.ok(edge.specifiers.length > 0, `${edge.from} -> ${edge.to} carries a specifier`);
		for (const specifier of edge.specifiers) {
			assert.ok(source.includes(specifier),
				`"${specifier}" appears literally in ${edge.from}`);
		}
		assert.ok(fs.existsSync(path.join(a.scan.baseDir, edge.to)),
			`edge target ${edge.to} exists on disk`);
	}
});

test('coverage text states both guarantees and blind spots', () => {
	const a = analyse({roots: [fixture('missing')]});
	const text = coverageText(a.coverage);
	assert.match(text, /Analysis coverage/);
	assert.match(text, /Internal resolution rate/);
	assert.match(text, /missing-relative/);
	assert.match(text, /Known limitations/);
	assert.match(text, /Dynamic runtime imports/);
});

test('maxFiles refuses absurd inputs instead of hanging', () => {
	assert.throws(
		() => scan({roots: [path.join(__dirname, '..', 'samples', 'vue-core', 'packages')], extensions: ['ts'], maxFiles: 5}),
		(error) => error.code === 'DEPMESH_TOO_MANY_FILES'
	);
});

test('loadTsConfig parses a real tsconfig and reports what it patched', () => {
	const info = loadTsConfig(fixture('alias/tsconfig.json'));
	assert.equal(info.config.compilerOptions.paths['@app/*'][0], './src/*');
	assert.equal(info.patches.length, 1);
	assert.equal(path.normalize(info.config.compilerOptions.baseUrl), path.normalize(fixture('alias')));
});
