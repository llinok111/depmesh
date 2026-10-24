# NOTICE - third-party code and data

depmesh is distributed under the MIT license (see `LICENSE`, which is the
original license of [pahen/madge](https://github.com/pahen/madge) and is kept
verbatim). This file lists everything third-party that ships in, or is required
by, this repository.

## 1. Upstream project (this repository is built on it)

| item | value |
| --- | --- |
| project | pahen/madge |
| version | 8.0.0 |
| commit | `456057b85c2d063dad9c10147d7686ded4fc5ce5` |
| license | MIT |
| copyright | Copyright (c) Patrik Henningsson |
| what was kept | the entire upstream history (534 commits), `lib/`, `bin/`, `test/`, `README.md`, `LICENSE`, `package.json` |
| what was added | `lib/depmesh/`, `bin/depmesh.js`, `test-depmesh/`, `scripts/`, `docs/`, `samples/`, `demo/`, `.eslintignore` |

The upstream README is preserved verbatim below the depmesh section in
`README.md`; the upstream CLI (`bin/cli.js`) and API (`require('madge')`) are
untouched and still work.

## 2. Runtime dependencies (not vendored, installed from npm)

| package | version | license | used for |
| --- | --- | --- | --- |
| precinct | 12.3.2 | MIT | extracting import specifiers (same detector madge uses) |
| filing-cabinet | 5.5.1 | MIT | resolving a specifier to a file path |
| typescript | 5.4.4 | Apache-2.0 | parsing tsconfig, syntax-form annotation, syntax-error detection |
| madge (this repo) | 8.0.0 | MIT | upstream parser entry point, used in the parity tests |

Transitive dependencies come from the npm registry under their own licenses; run
`npx license-checker --summary` for the full list after `npm install`.

## 3. Bundled analysis corpus (source code redistributed here)

`samples/vue-core/` contains unmodified source from **vuejs/core 3.5.44**.

| item | value |
| --- | --- |
| project | vuejs/core |
| tag / commit | `v3.5.44` / `bf5f0dd877dd3c23ce85c2cbc1dd771567e84c8c` |
| license | MIT |
| copyright | Copyright (c) 2018-present, Yuxi (Evan) You and Vue contributors |
| license text | `samples/vue-core/LICENSE` |
| provenance | `samples/vue-core/PROVENANCE.md` (tarball URL + sha256 + verification commands) |
| files | 234 `.ts` files under `packages/<pkg>/src`, plus the root `tsconfig.json` |

Nothing in this corpus was modified. It exists so the tests and the demo can run
offline against real code instead of synthetic fixtures.

The second corpus used by the tests is `node_modules/eslint/lib` (eslint 7.29,
MIT, installed as a dev dependency of upstream); it is not redistributed here,
only read at test time.

## 4. Demo output

`demo/vue-core.html` and `demo/eslint-lib.html` are generated artifacts. They
embed the analysis model (module ids and edges derived from the corpora above)
and the depmesh UI. They contain no third-party JavaScript.

## 5. Fonts, icons, assets

None. The UI uses system fonts only (`Segoe UI`, `Cascadia Mono`, `Consolas`,
`Menlo`) and draws everything else on a canvas.
