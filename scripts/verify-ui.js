#!/usr/bin/env node
'use strict';

/**
 * Browser verification for a generated depmesh page.
 *
 * Drives the real file in a real browser and asserts on observable state:
 * model/DOM agreement, canvas actually painted, click -> selection -> blast
 * radius agreeing with an independent recount from the raw edge list, filters,
 * search, path finder, zoom, and that no exception escaped during any of it.
 *
 * playwright-core is an optional dev dependency; set NODE_PATH or install it
 * next to this repo. Nothing here is needed to use depmesh.
 *
 *   node scripts/verify-ui.js demo/vue-core.html
 *   node scripts/verify-ui.js demo/vue-core.html --out shots/verify
 */

const fs = require('node:fs');
const path = require('node:path');

function loadPlaywright() {
	const candidates = ['playwright-core', 'playwright'];
	for (const name of candidates) {
		try {
			return require(name);
		} catch (error) {
			/* try next */
		}
	}
	try {
		// Workspace-local install used during development on this machine.
		return require(path.join(__dirname, '..', '..', '_uiverify', 'node_modules', 'playwright-core'));
	} catch (error) {
		return null;
	}
}

function main() {
	const args = process.argv.slice(2);
	const pagePath = path.resolve(args.find((a) => !a.startsWith('-')) || path.join(__dirname, '..', 'demo', 'vue-core.html'));
	const outIndex = args.indexOf('--out');
	const shots = path.resolve(outIndex === -1 ? path.join(__dirname, '..', 'shots', 'verify') : args[outIndex + 1]);

	const pw = loadPlaywright();
	if (!pw) {
		console.error('playwright-core is not installed; skipping browser verification');
		return 2;
	}
	if (!fs.existsSync(pagePath)) {
		console.error(`page not found: ${pagePath}`);
		return 2;
	}
	fs.mkdirSync(shots, {recursive: true});

	const checks = [];
	const record = (name, ok, detail = '') => {
		checks.push({name, ok: Boolean(ok), detail: String(detail)});
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
	};
	const guard = async (name, fn) => {
		try {
			await fn();
		} catch (error) {
			record(name, false, `threw: ${error.message.split('\n')[0]}`);
		}
	};

	(async () => {
		const browser = await pw.chromium.launch({channel: 'msedge', headless: true, timeout: 30000});
		const page = await browser.newPage({viewport: {width: 1600, height: 950}});
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => {
			if (m.type() === 'error') {
				errors.push(m.text());
			}
		});

		await page.goto(`file:///${pagePath.replace(/\\/g, '/')}`, {waitUntil: 'load', timeout: 30000});
		await page.waitForTimeout(1200);

		record('no page errors on load', errors.length === 0, errors.slice(0, 3).join(' | '));

		await guard('model and DOM agree', async () => {
			const model = await page.evaluate(() => ({
				nodes: DATA.nodes.length,
				edges: DATA.edges.length,
				cycles: DATA.cycles.components.length,
				unresolved: DATA.coverage.specifiers.failed,
				statsNodes: Number(document.querySelector('#stats .kv b').textContent)
			}));
			record('model embedded', model.nodes > 0 && model.edges > 0, JSON.stringify(model));
			record('stats panel matches model', model.statsNodes === model.nodes, `${model.statsNodes} vs ${model.nodes}`);
		});

		await guard('canvas paint', async () => {
			const painted = await page.evaluate(() => {
				const cv = document.getElementById('cv');
				const ctx = cv.getContext('2d');
				const {data} = ctx.getImageData(0, 0, cv.width, cv.height);
				let nonEmpty = 0;
				for (let i = 3; i < data.length; i += 4 * 97) {
					if (data[i] > 8) {
						nonEmpty++;
					}
				}
				return {nonEmpty, total: Math.floor(data.length / (4 * 97))};
			});
			record('canvas has painted pixels', painted.nonEmpty / painted.total > 0.02, `${painted.nonEmpty}/${painted.total}`);
		});

		await page.screenshot({path: path.join(shots, '01-initial.png')});

		const target = await page.evaluate(() => {
			// Highest fan-in module: the click target exists in any corpus.
			const node = DATA.nodes.slice().sort((a, b) => b.in - a.in || (a.id < b.id ? -1 : 1))[0];
			const p = pos.get(node.id);
			const rect = document.getElementById('cv').getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			return {
				id: node.id,
				x: rect.left + (p.x * state.scale + state.ox) + rect.width / 2,
				y: rect.top + (p.y * state.scale + state.oy) + rect.height / 2,
				scale: state.scale,
				ox: state.ox,
				oy: state.oy,
				px: p.x,
				py: p.y,
				dpr
			};
		});

		await guard('click selects node', async () => {
			await page.mouse.click(target.x, target.y);
			await page.waitForTimeout(400);
			const detail = await page.evaluate(() => ({
				selected: state.selected,
				impact: state.impact.size,
				text: document.querySelector('#detail').textContent.replace(/\s+/g, ' ').slice(0, 200)
			}));
			record('click selects the intended node', detail.selected === target.id, `${detail.selected} (wanted ${target.id})`);
			record('blast radius computed in UI', detail.impact > 0, String(detail.impact));
			record('detail panel filled', /blast radius/i.test(detail.text), detail.text.slice(0, 70));

			const expected = await page.evaluate((id) => {
				const inn = new Map();
				for (const e of DATA.edges) {
					if (!inn.has(e.t)) {
						inn.set(e.t, []);
					}
					inn.get(e.t).push(e.s);
				}
				const seen = new Set();
				const queue = [id];
				while (queue.length) {
					const node = queue.shift();
					for (const parent of inn.get(node) || []) {
						if (parent !== id && !seen.has(parent)) {
							seen.add(parent);
							queue.push(parent);
						}
					}
				}
				return seen.size;
			}, target.id);
			record('UI blast radius equals independent recount', detail.impact === expected, `${detail.impact} vs ${expected}`);
		});

		await page.screenshot({path: path.join(shots, '02-selected.png')});

		await guard('cycle filter', async () => {
			await page.click('[data-filter="cycle"]');
			await page.waitForTimeout(300);
			const purple = await page.evaluate(() => {
				const cv = document.getElementById('cv');
				const {data} = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
				let count = 0;
				// Cycle nodes are #c792ea (199,146,234); accept the antialiased band.
				for (let i = 0; i < data.length; i += 4 * 31) {
					if (data[i + 3] > 8 && data[i] > 150 && data[i + 1] < 175 && data[i + 2] > 195 && data[i + 2] > data[i]) {
						count++;
					}
				}
				return count;
			});
			// A corpus without cycles must paint nothing purple; asserting >0 there
			// would be a test bug, not a product bug.
			const cyclicCount = await page.evaluate(() => DATA.cycles.componentCount);
			record('cycle filter paints cyclic nodes',
				cyclicCount === 0 ? purple === 0 : purple > 0,
				`${purple} purple px, ${cyclicCount} cyclic component(s)`);
			await page.screenshot({path: path.join(shots, '03-cycles.png')});
			await page.click('[data-filter="all"]');
			await page.waitForTimeout(150);
		});

		await guard('search', async () => {
			const needle = await page.evaluate(() => {
				const id = DATA.nodes[0].id;
				return id.split('/').pop().replace(/\.[^.]+$/, '').slice(0, 6);
			});
			await page.fill('#search', needle);
			await page.waitForTimeout(300);
			const matches = await page.evaluate(() => matched.size);
			record('search matches modules', matches > 0, `${matches} for "${needle}"`);
			await page.screenshot({path: path.join(shots, '04-search.png')});
			await page.fill('#search', '');
			await page.waitForTimeout(150);
		});

		await guard('path finder', async () => {
			const pair = await page.evaluate(() => {
				const from = DATA.nodes.find((n) => n.out > 0).id;
				const edge = DATA.edges.find((e) => e.s === from);
				return {from, to: edge.t};
			});
			await page.fill('#pathFrom', pair.from);
			await page.fill('#pathTo', pair.to);
			await page.click('#pathGo');
			await page.waitForTimeout(300);
			const text = await page.evaluate(() => document.querySelector('#pathResult').textContent);
			record('path finder returns a direct path', text.includes(pair.from) && text.includes(pair.to), text.slice(0, 90));
		});

		await guard('zoom', async () => {
			const before = await page.evaluate(() => state.scale);
			await page.mouse.move(700, 500);
			await page.mouse.wheel(0, -400);
			await page.waitForTimeout(250);
			const after = await page.evaluate(() => state.scale);
			record('wheel zoom changes scale', after !== before, `${before.toFixed(3)} -> ${after.toFixed(3)}`);
		});

		await guard('ledger panels', async () => {
			const panels = await page.evaluate(() => ({
				unresolvedText: document.querySelector('#unresolvedList').textContent.trim(),
				coverageRows: document.querySelectorAll('#coverage .kv').length,
				coverageText: document.querySelector('#coverage').textContent.replace(/\s+/g, ' '),
				findings: DATA.coverage.unresolved.findings.length
			}));
			record('unresolved panel reflects the model',
				panels.findings === 0 ? /Every internal import resolved/.test(panels.unresolvedText) : panels.unresolvedText.length > 0,
				`${panels.findings} finding(s)`);
			record('coverage ledger rendered', panels.coverageRows >= 7, `${panels.coverageRows} rows`);
			record('coverage ledger states limits', /Not covered/.test(panels.coverageText), panels.coverageText.slice(0, 80));
		});

		await page.screenshot({path: path.join(shots, '05-final.png')});

		record('still no page errors after interaction', errors.length === 0, errors.slice(0, 3).join(' | '));

		const failed = checks.filter((c) => !c.ok);
		fs.writeFileSync(path.join(shots, 'result.json'), `${JSON.stringify({page: pagePath, target: target.id, checks}, null, 2)}\n`);
		console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
		await browser.close();
		process.exitCode = failed.length ? 1 : 0;
	})().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

main();
