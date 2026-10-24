'use strict';

/**
 * Artifact freshness tests.
 *
 * `scripts/check-artifacts.js` is the gate CI runs, so its comparison logic is
 * itself worth testing: it must accept a correct file regardless of line ending
 * and reject a file whose content actually drifted. The Windows CI run proved
 * this matters - a byte comparison reported the report as stale purely because
 * Git checked it out with CRLF.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'check-artifacts.js');

const normalise = (s) => s.replace(/\r\n/g, '\n');

test('artifacts: the committed report and demo are current', () => {
	const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8'});
	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	assert.match(result.stdout, /ok\s+docs\/REPORT-vue-core\.md/);
	assert.match(result.stdout, /ok\s+demo\/vue-core\.html/);
	assert.match(result.stdout, /all artifacts are up to date/);
});

test('artifacts: the report comparison is line-ending agnostic', () => {
	// Simulate a CRLF checkout: rewriting the file with CRLF must not be
	// reported as staleness, because the content is identical.
	const report = path.join(root, 'docs', 'REPORT-vue-core.md');
	const original = fs.readFileSync(report, 'utf8');
	assert.equal(original.includes('\r\n'), false, 'the fixture starts as LF');

	fs.writeFileSync(report, original.replace(/\n/g, '\r\n'));
	try {
		const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8'});
		assert.equal(result.status, 0, `CRLF must not count as stale: ${result.stderr}`);
	} finally {
		fs.writeFileSync(report, original);
	}
});

test('artifacts: a real content change is detected', () => {
	const report = path.join(root, 'docs', 'REPORT-vue-core.md');
	const original = fs.readFileSync(report, 'utf8');
	const tampered = original.replace('| modules |', '| modules (tampered) |');
	assert.notEqual(tampered, original, 'the fixture contains the expected row');

	fs.writeFileSync(report, tampered);
	try {
		const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8'});
		assert.equal(result.status, 1, 'a changed number must fail the check');
		assert.match(result.stderr, /stale/);
	} finally {
		fs.writeFileSync(report, original);
	}
});

test('artifacts: the report generator itself is stable across runs', () => {
	const report = path.join(root, 'docs', 'REPORT-vue-core.md');
	const before = fs.readFileSync(report, 'utf8');
	execFileSync(process.execPath, [path.join(root, 'scripts', 'build-report.js')], {cwd: root, stdio: 'ignore'});
	const after = fs.readFileSync(report, 'utf8');
	assert.equal(normalise(after), normalise(before), 'regenerating produces identical content');
});
