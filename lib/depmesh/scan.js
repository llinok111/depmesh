'use strict';

/**
 * depmesh scanner.
 *
 * Every edge in the graph must be traceable to one concrete import/require
 * statement in one concrete file. This module is the only place where that
 * trace is produced: it walks real files, extracts real specifiers with
 * precinct (the same detector madge/dependency-tree use) and resolves them
 * with filing-cabinet (the same resolver). No edge is ever invented here.
 *
 * It differs from madge in that it keeps a per-specifier ledger instead of a
 * flat `skipped` array, so the caller can state exactly what was covered and
 * what was not.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cabinet = require('filing-cabinet');
const precinct = require('precinct');

const DEFAULT_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'];

const posix = (p) => p.split(path.sep).join('/');

/**
 * Read a tsconfig the way TypeScript 5 does, then make it usable by
 * filing-cabinet.
 *
 * TypeScript allows `paths` without `baseUrl` (relative to the tsconfig
 * directory). filing-cabinet 5.x only resolves `paths` when `baseUrl` is
 * present, so both madge and dependency-tree silently drop every alias edge in
 * such a project. Injecting baseUrl restores the documented TS semantics.
 */
function loadTsConfig(configPath, {injectBaseUrl = true} = {}) {
	const abs = path.resolve(configPath);
	const dir = path.dirname(abs);
	const file = ts.readJsonConfigFile(abs, ts.sys.readFile);
	const parsed = ts.parseJsonSourceFileConfigFileContent(file, ts.sys, dir);
	const compilerOptions = {...parsed.options};
	const patches = [];

	if (injectBaseUrl && compilerOptions.paths && !compilerOptions.baseUrl) {
		compilerOptions.baseUrl = dir;
		patches.push('tsconfig-paths-baseurl');
	}

	return {
		path: abs,
		dir,
		parsed,
		config: {...parsed.raw, compilerOptions},
		patches
	};
}

/**
 * Discover source files under the given roots, skipping node_modules and .git.
 */
function discover(roots, {extensions = DEFAULT_EXTENSIONS, exclude = []} = {}) {
	const allowed = new Set(extensions.map((e) => (e.startsWith('.') ? e.slice(1) : e)));
	const patterns = exclude.map((p) => (p instanceof RegExp ? p : new RegExp(p)));
	const files = [];
	const ignored = {byExtension: 0, byExclude: 0, byDirectory: 0};

	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, {withFileTypes: true});
		} catch (error) {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git') {
					ignored.byDirectory++;
					continue;
				}
				walk(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			const ext = path.extname(entry.name).replace('.', '');
			if (!allowed.has(ext)) {
				ignored.byExtension++;
				continue;
			}
			const rel = posix(path.relative(process.cwd(), full));
			if (patterns.some((re) => re.test(rel) || re.test(posix(full)))) {
				ignored.byExclude++;
				continue;
			}
			files.push(full);
		}
	};

	for (const root of roots) {
		const abs = path.resolve(root);
		const stat = fs.statSync(abs);
		if (stat.isDirectory()) {
			walk(abs);
		} else if (stat.isFile()) {
			files.push(abs);
		}
	}

	files.sort();
	return {files, ignored};
}

/**
 * Annotate specifiers with the syntactic form they appear in.
 *
 * precinct returns a flat list of strings. The TypeScript parser gives the same
 * strings plus a form (`import type` vs `import` vs `import()` vs `require`).
 * This only ever annotates specifiers that precinct already found; it never adds
 * an edge, so the authoritative edge set stays precinct's.
 */
function formsOf(filename, source) {
	const map = new Map();
	const ext = path.extname(filename);
	const kind = ext === '.tsx' || ext === '.jsx' ?
		ts.ScriptKind.TSX :
		ext === '.js' || ext === '.mjs' || ext === '.cjs' ?
			ts.ScriptKind.JS :
			ts.ScriptKind.TS;

	let sf;
	try {
		sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, false, kind);
	} catch (error) {
		return map;
	}

	const add = (spec, form) => {
		if (!map.has(spec)) {
			map.set(spec, new Set());
		}
		map.get(spec).add(form);
	};

	const visit = (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			add(node.moduleSpecifier.text, node.importClause && node.importClause.isTypeOnly ? 'type' : 'static');
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			add(node.moduleSpecifier.text, node.isTypeOnly ? 'type' : 're-export');
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
			add(node.moduleReference.expression.text, 'require');
		} else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				add(node.arguments[0].text, 'dynamic');
			} else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
				add(node.arguments[0].text, 'require');
			}
		}
		ts.forEachChild(node, visit);
	};

	visit(sf);
	return map;
}

const STRENGTH = {static: 4, 're-export': 4, require: 3, dynamic: 2, type: 1};

/**
 * Scan a project.
 *
 * @param {Object} options
 * @param {string[]} options.roots        Directories or files to scan.
 * @param {string} [options.baseDir]      Base for node ids (defaults to common root).
 * @param {string[]} [options.extensions]
 * @param {(string|RegExp)[]} [options.exclude]
 * @param {string} [options.tsConfig]     Path to a tsconfig.json.
 * @param {boolean} [options.injectBaseUrl=true]
 * @param {number} [options.maxFiles]     Safety valve for very large trees.
 */
function scan(options = {}) {
	const started = Date.now();
	const roots = (options.roots && options.roots.length ? options.roots : ['.']).map((r) => path.resolve(r));
	const extensions = options.extensions && options.extensions.length ? options.extensions : DEFAULT_EXTENSIONS;
	const maxFiles = options.maxFiles || 5000;

	const discovery = discover(roots, {extensions, exclude: options.exclude || []});
	if (discovery.files.length > maxFiles) {
		const error = new Error(`refusing to analyse ${discovery.files.length} files (maxFiles=${maxFiles})`);
		error.code = 'DEPMESH_TOO_MANY_FILES';
		throw error;
	}

	const baseDir = path.resolve(options.baseDir || commonDir(roots));
	const tsInfo = options.tsConfig ?
		loadTsConfig(options.tsConfig, {injectBaseUrl: options.injectBaseUrl !== false}) :
		null;

	const resolveConfig = {
		directory: baseDir,
		tsConfig: tsInfo ? tsInfo.config : undefined,
		webpackConfig: options.webpackConfig || undefined,
		nodeModulesConfig: options.nodeModulesConfig || undefined
	};

	const detectiveConfig = {ts: {mixedImports: true}, es6: {mixedImports: true}};
	const idOf = (abs) => posix(path.relative(baseDir, abs));

	// A resolved file counts as "external" only when it lives in node_modules and
	// outside every scanned root. Analysing a package that itself sits inside
	// node_modules must still produce internal edges.
	const rootDirs = roots.map((r) => {
		try {
			return fs.statSync(r).isDirectory() ? r : path.dirname(r);
		} catch (error) {
			return r;
		}
	});

	const nodes = new Map(); // id -> node record
	let edges = []; // {from, to, specifier, form}
	const edgeIndex = new Map(); // "from>to" -> edge
	const externals = new Map(); // package name -> {specifiers:Set, importers:Set}
	const ledger = {
		specifiers: 0,
		resolvedInternal: 0,
		resolvedExternal: 0,
		unresolved: [], // {file, specifier, reason, detail}
		byForm: {}
	};
	const queue = [];
	const seen = new Set();

	for (const file of discovery.files) {
		const id = idOf(file);
		nodes.set(id, nodeRecord(file, id));
		queue.push(file);
		seen.add(file);
	}

	while (queue.length) {
		const file = queue.shift();
		const id = idOf(file);
		const node = nodes.get(id);
		let source = '';
		try {
			source = fs.readFileSync(file, 'utf8');
		} catch (error) {
			node.parseError = `read failed: ${error.message}`;
			continue;
		}
		node.bytes = Buffer.byteLength(source);

		let specifiers;
		try {
			specifiers = precinct.paperwork(file, {includeCore: false, ...detectiveConfig});
			node.parsed = true;
		} catch (error) {
			node.parseError = error.message;
			ledger.unresolved.push({
				file: id,
				specifier: null,
				reason: 'parse-error',
				detail: error.message.split('\n')[0]
			});
			continue;
		}

		// precinct swallows parser failures and returns an empty list, which would
		// make a syntactically broken file look like a file with no imports. Ask the
		// TypeScript parser directly so a blind spot is reported as a blind spot.
		const syntaxErrors = countSyntaxErrors(file, source, node.ext);
		if (syntaxErrors > 0) {
			node.parseError = `${syntaxErrors} syntax error(s)`;
			node.parsed = false;
			ledger.unresolved.push({
				file: id,
				specifier: null,
				reason: 'parse-error',
				detail: `${syntaxErrors} syntax error(s) reported by the TypeScript parser`
			});
		}
		node.specifierCount = specifiers.length;

		const forms = formsOf(file, source);

		for (const specifier of specifiers) {
			ledger.specifiers++;
			const formSet = forms.get(specifier);
			const form = formSet ? [...formSet].sort((a, b) => STRENGTH[b] - STRENGTH[a])[0] : 'static';
			ledger.byForm[form] = (ledger.byForm[form] || 0) + 1;

			let resolved = '';
			try {
				resolved = cabinet({
					partial: specifier,
					filename: file,
					directory: baseDir,
					ast: precinct.ast,
					tsConfig: resolveConfig.tsConfig,
					webpackConfig: resolveConfig.webpackConfig,
					nodeModulesConfig: resolveConfig.nodeModulesConfig
				});
			} catch (error) {
				ledger.unresolved.push({file: id, specifier, reason: 'resolve-error', detail: error.message.split('\n')[0]});
				continue;
			}

			if (!resolved) {
				ledger.unresolved.push({file: id, specifier, reason: classifyMissing(specifier, tsInfo), detail: null});
				continue;
			}
			if (!fs.existsSync(resolved)) {
				ledger.unresolved.push({file: id, specifier, reason: 'resolved-to-missing-file', detail: posix(resolved)});
				continue;
			}
			if (isExternal(resolved, rootDirs)) {
				ledger.resolvedExternal++;
				const pkg = packageNameOf(resolved);
				if (!externals.has(pkg)) {
					externals.set(pkg, {specifiers: new Set(), importers: new Set()});
				}
				externals.get(pkg).specifiers.add(specifier);
				externals.get(pkg).importers.add(id);
				continue;
			}

			ledger.resolvedInternal++;
			const targetId = idOf(resolved);
			if (!nodes.has(targetId)) {
				nodes.set(targetId, nodeRecord(resolved, targetId));
				if (!seen.has(resolved)) {
					seen.add(resolved);
					queue.push(resolved);
				}
			}

			const key = `${id}>${targetId}`;
			const existing = edgeIndex.get(key);
			if (existing) {
				if (!existing.specifiers.includes(specifier)) {
					existing.specifiers.push(specifier);
				}
				existing.forms.add(form);
			} else {
				const edge = {from: id, to: targetId, specifiers: [specifier], forms: new Set([form])};
				edgeIndex.set(key, edge);
				edges.push(edge);
			}
		}
	}

	// Optional: drop edges that exist only as `import type`.
	let typeEdgesDropped = 0;
	let keptEdges = edges;
	if (options.includeTypeEdges === false) {
		keptEdges = edges.filter((edge) => {
			const onlyType = [...edge.forms].every((f) => f === 'type');
			if (onlyType) {
				typeEdgesDropped++;
			}
			return !onlyType;
		});
		for (const edge of keptEdges) {
			edgeIndex.delete(`${edge.from}>${edge.to}`);
		}
	}

	// Deterministic ordering: node ids sorted, edges sorted by (from, to).
	const sortedNodes = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	keptEdges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
	edges = keptEdges;

	const inDeg = new Map(sortedNodes.map((n) => [n.id, 0]));
	const outDeg = new Map(sortedNodes.map((n) => [n.id, 0]));
	for (const edge of edges) {
		outDeg.set(edge.from, (outDeg.get(edge.from) || 0) + 1);
		inDeg.set(edge.to, (inDeg.get(edge.to) || 0) + 1);
	}
	for (const node of sortedNodes) {
		node.in = inDeg.get(node.id) || 0;
		node.out = outDeg.get(node.id) || 0;
	}

	return {
		baseDir,
		roots: roots.map((r) => posix(path.relative(baseDir, r)) || '.'),
		extensions,
		tsConfig: tsInfo ? {path: posix(path.relative(baseDir, tsInfo.path)), patches: tsInfo.patches} : null,
		nodes: sortedNodes,
		edges,
		externals: [...externals.entries()]
			.map(([name, info]) => ({name, specifiers: [...info.specifiers].sort(), importers: info.importers.size}))
			.sort((a, b) => b.importers - a.importers || (a.name < b.name ? -1 : 1)),
		ledger: {
			...ledger,
			unresolved: ledger.unresolved.sort((a, b) => (a.file === b.file ?
				(String(a.specifier) < String(b.specifier) ? -1 : 1) :
				a.file < b.file ? -1 : 1))
		},
		discovery: {
			roots: discovery.files.length,
			ignored: discovery.ignored,
			scanned: discovery.files.length
		},
		timing: {scanMs: Date.now() - started},
		typeEdgesDropped
	};
}

function nodeRecord(absPath, id) {
	const ext = path.extname(absPath).replace('.', '');
	return {
		id,
		ext,
		dir: posix(path.dirname(id)),
		parsed: false,
		parseError: null,
		bytes: 0,
		specifierCount: 0,
		in: 0,
		out: 0
	};
}

/**
 * Count *syntax* errors (not type errors) with the TypeScript parser.
 * Only extensions the TypeScript parser can read are checked; for anything else
 * the answer is 0 rather than a guess.
 */
function countSyntaxErrors(filename, source, ext) {
	if (!['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) {
		return 0;
	}
	const kind = ext === 'tsx' || ext === 'jsx' ?
		ts.ScriptKind.TSX :
		['js', 'mjs', 'cjs'].includes(ext) ?
			ts.ScriptKind.JS :
			ts.ScriptKind.TS;
	try {
		const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, false, kind);
		return sf.parseDiagnostics ? sf.parseDiagnostics.length : 0;
	} catch (error) {
		return 1;
	}
}

function isExternal(resolved, rootDirs) {
	const normalised = resolved.split(path.sep).join('/');
	if (!normalised.includes('/node_modules/')) {
		return false;
	}

	// A root that itself lives inside node_modules (analysing an installed package)
	// owns everything below it; node_modules nested deeper inside such a root is
	// still external.
	const insideRoot = rootDirs
		.map((dir) => dir.split(path.sep).join('/').replace(/\/$/, ''))
		.filter((prefix) => normalised === prefix || normalised.startsWith(prefix + '/'))
		.sort((a, b) => b.length - a.length)[0];

	if (!insideRoot) {
		return true;
	}
	const rest = normalised.slice(insideRoot.length + 1);
	return rest.includes('/node_modules/') || rest.startsWith('node_modules/');
}

function classifyMissing(specifier, tsInfo) {
	if (specifier.startsWith('.') || specifier.startsWith('/')) {
		return 'missing-relative';
	}
	if (tsInfo && tsInfo.config.compilerOptions.paths) {
		const alias = aliasTarget(specifier, tsInfo);
		if (alias) {
			return 'alias-unresolved';
		}
	}
	return 'missing-package';
}

/** Best-effort explanation for an unresolved tsconfig alias (diagnostics only). */
function aliasTarget(specifier, tsInfo) {
	const {paths, baseUrl} = tsInfo.config.compilerOptions;
	for (const [pattern, targets] of Object.entries(paths || {})) {
		const star = pattern.indexOf('*');
		let captured = null;
		if (star === -1) {
			if (pattern !== specifier) {
				continue;
			}
		} else {
			const prefix = pattern.slice(0, star);
			const suffix = pattern.slice(star + 1);
			if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
				continue;
			}
			captured = specifier.slice(prefix.length, specifier.length - suffix.length);
		}
		for (const target of targets) {
			const filled = captured === null ? target : target.replace('*', captured);
			const abs = path.resolve(baseUrl || tsInfo.dir, filled);
			if (fs.existsSync(abs)) {
				return abs;
			}
		}
	}
	return null;
}

function packageNameOf(absPath) {
	const parts = absPath.split(/[\\/]/);
	const index = parts.lastIndexOf('node_modules');
	if (index === -1) {
		return null;
	}
	const name = parts[index + 1];
	if (name && name.startsWith('@')) {
		return `${name}/${parts[index + 2]}`;
	}
	return name;
}

function commonDir(paths) {
	const split = paths.map((p) => path.resolve(p).split(path.sep));
	const out = split[0].slice();
	for (const parts of split.slice(1)) {
		let i = 0;
		while (i < out.length && i < parts.length && out[i] === parts[i]) {
			i++;
		}
		out.length = i;
	}
	const joined = out.join(path.sep);
	return joined || path.parse(paths[0]).root;
}

module.exports = {scan, discover, loadTsConfig, DEFAULT_EXTENSIONS, commonDir, posix};
