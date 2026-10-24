# Provenance - vuejs/core corpus

This directory contains **unmodified upstream source code** used as the bundled
analysis corpus. It is not a fork and it is not modified in any way; only the
`packages/<name>/src` trees plus the root `tsconfig.json` and `LICENSE` were
copied out of the release tarball.

| field | value |
| --- | --- |
| project | [vuejs/core](https://github.com/vuejs/core) |
| version | 3.5.44 |
| tag | `v3.5.44` |
| commit | `bf5f0dd877dd3c23ce85c2cbc1dd771567e84c8c` (2026-10-13) |
| archive | `https://codeload.github.com/vuejs/core/tar.gz/refs/tags/v3.5.44` |
| archive sha256 | `ddb6e5250aeb302eb682090422b85cf7c9f5b6e1e66d5722ee218f77a749e92d` |
| license | MIT (see `LICENSE` in this directory) |
| copyright | Copyright (c) 2018-present, Yuxi (Evan) You and Vue contributors |
| files copied | 234 `.ts` files under `packages/<pkg>/src`, plus `tsconfig.json` and `LICENSE` |

## Why this corpus

It exercises the cases the analyser has to get right, using code nobody wrote
for this tool:

- **tsconfig path aliases** (`@vue/*` -> `./packages/*/src`) *without* a
  `baseUrl`, which is legal in TypeScript 5 and which upstream madge silently
  fails to resolve (see `docs/UPSTREAM-FINDINGS.md`).
- **Real cycles**: 8 strongly connected components covering 128 modules,
  including a 62-module component in `runtime-core`.
- **Missing dependencies**: `@babel/types`, `entities`, `estree-walker` and
  friends are declared but not installed here, so 30 specifiers stay unresolved
  and must be reported as such rather than guessed.

## How to verify the copy is faithful

```bash
curl -sL -o /tmp/vue.tgz https://codeload.github.com/vuejs/core/tar.gz/refs/tags/v3.5.44
sha256sum /tmp/vue.tgz     # ddb6e5250aeb302eb682090422b85cf7c9f5b6e1e66d5722ee218f77a749e92d
tar -xzf /tmp/vue.tgz -C /tmp
diff -r /tmp/core-3.5.44/packages/runtime-core/src samples/vue-core/packages/runtime-core/src
```

The comparison should be empty for every package.
