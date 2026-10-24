# 上游实测结论（pahen/madge 8.0.0）

本文记录本仓库在真实项目上测得的四类缺口。每条都有可复现命令与数字，
不是从 README 推测，也不是从 issue 抄来的。

所有数字由 `node scripts/measure-upstream.js` 一次跑出，原始输出存档在
`docs/MEASUREMENTS.json`。改动检测链或升级依赖后，重跑该脚本即可发现数字漂移。

上游信息（`gh api repos/pahen/madge`，2026-10-24 核实）：

| 项 | 值 |
| --- | --- |
| 仓库 | `pahen/madge` |
| 版本 | 8.0.0（`package.json`） |
| HEAD | `456057b85c2d063dad9c10147d7686ded4fc5ce5`（2024-08-05） |
| 提交数 | 534 |
| Star | 10,177 |
| 许可证 | MIT |
| 核心代码量 | `lib/*.js` + `bin/cli.js` = 1152 行 |

## 1. 环检测不完整：会漏掉确实在环上的模块

`lib/cyclic.js` 的算法是 DFS 走到底，遇到"仍在未解析栈里"的节点就把栈片段当环路返回。
它返回的是**某次 DFS 恰好走过的路径**，不是强连通分量，也不是全部初等环。

在 vue-core 语料（234 模块 / 1185 边）上：

| 指标 | 上游 `circular()` | depmesh SCC |
| --- | --- | --- |
| 输出条数 | 262 条路径 | 8 个分量 |
| 覆盖的模块数 | 117 | **128** |
| 漏掉的环上模块 | **11** | 0 |

漏掉的 11 个（部分）：`compiler-sfc/src/rewriteDefault.ts`、
`compiler-sfc/src/script/defineEmits.ts`、`compiler-sfc/src/script/defineExpose.ts`、
`compiler-sfc/src/script/defineOptions.ts`……

复现：

```bash
node -e "const m=require('./lib/api.js');m('samples/vue-core/packages',{fileExtensions:['ts'],tsConfig:require('./lib/depmesh/scan.js').loadTsConfig('samples/vue-core/tsconfig.json').config}).then(r=>console.log(r.circular().length))"
node bin/depmesh.js analyse samples/vue-core/packages --tsconfig samples/vue-core/tsconfig.json --ext ts | head -12
```

测试用独立判据复核：某节点是否在环上 = 从它出发能否回到它（BFS）。
`test-depmesh/real.test.js` 里对 11 个"漏网"节点逐个再走一次，全部确实可达自身。

**外部佐证**：上游 issue
[#447 "Inconsistencies in circular dependency detection"](https://github.com/pahen/madge/issues/447)
（2025-05-07 提出，至今 open）用两个最小用例说明了同一根因 —— `cyclic.js` 的 DFS
"遇到未解析节点就截一段栈"的算法，同一个环从不同入口进入会得出不同结果，甚至完全不报。
另有 #382「index 文件内的环不报」、#395「Angular 项目结果难以理解」指向同一处。

也就是说：这不是本仓库"挑出来的边角问题"，而是上游已知、长期未修的核心算法缺口。

## 2. 环报告大量冗余：一条环会以"超集"形式重复出现

同一份 262 条输出里，**213 条（81.3%）包含另一条已输出的路径作为连续子路径**，
即它不是自己的最小代表：

- 8 个强连通分量被拆成 262 条互相包含的路径；
- 一条 17 模块的分量（compiler-sfc）单独就贡献了数十条前缀不同的写法。

也就是说输出既不是最小环基，也不是无重复集合。depmesh 的取舍是：
**分量用 SCC 精确给出**，每个分量再给最多 3 条"经过不同节点最短环"，按旋转归一化去重，
并逐边校验（`verified: true`）。

## 3. `depends()` 只回答一跳

`lib/api.js` 第 129–135 行：

```js
depends(id) {
  const tree = this.obj();
  return Object.keys(tree).filter((dep) => tree[dep].indexOf(id) >= 0);
}
```

过滤条件就是"直接 import 过我"，没有传递闭包，也没有距离分层。
"改这个文件会影响谁"在真实项目里几乎总要多跳：vue-core 里
`shared/src/index.ts` 是入度最高的模块（133 个直接依赖者），而**传递依赖者是 205 个模块**
（占全图 87.6%）。上游 `depends()` 在这个模块上只能回答 133，其余 72 个"两跳以上会受影响"的
模块不会被报告。depmesh 的 `impact` 给出闭包、距离分层与每条见证链。

## 4. tsconfig `paths` 在没有 `baseUrl` 时整链丢失

TypeScript 5 允许只写 `paths`（相对 tsconfig 目录解析）。`filing-cabinet` 5.5.1 需要
`baseUrl` 才解析 `paths`，而 madge（`lib/api.js` 第 50–58 行）与 dependency-tree
（`lib/config.js`）在转成对象时都没有注入它。

vue-core `packages/<pkg>/src`（234 模块）实测：

| 配置 | 边数 | skipped 说明符 |
| --- | --- | --- |
| 原样（`tsConfig` 传未经修复的对象） | 931 | 13（含 `@vue/shared` 等别名） |
| 注入 `baseUrl` | **1185** | 10（只剩真正没安装的包） |

差值是 **254 条边（+27.3%）**，全部是 `@vue/*` 跨包依赖。这属于"静默失效"：
不报错，只是图小了一圈。

depmesh 的修法只有一处（`loadTsConfig` 注入 `baseUrl` 并记录 `patches`），
并且保留 `injectBaseUrl: false` 作为对照，测试里正反两向都断言。

**外部佐证（不是我从零发现）**：上游 issue
[#463 "TypeScript v6: aliased imports skipped when tsconfig has no baseUrl"](https://github.com/pahen/madge/issues/463)
（2026-06-02 提出，至今 open）由另一位用户独立报告了同一现象，并给出了同样的
临时修法 —— "injecting a runtime `baseUrl` into the object madge uses for its
tsconfig brought us back to the previous dependency counts"。

本仓库的贡献不是"发现这个问题"，而是：把它变成一个**默认开启、可验证、且可关闭对照**
的修复，并且把"修了多少条边"写成报告里的一个数字，而不是留在 issue 讨论里。

## 5. 附带发现：上游测试在本机不是全绿

`npx mocha test/*.js` 在 Windows 上是 **52 passing / 6 failing**：

- 5 条依赖 Graphviz 二进制（本机没有 `gvpr`），属环境缺失；
- 1 条 `test/api.js:155` 用 `/test\/cjs\/b\.js$/` 断言路径，Windows 反斜杠不匹配，属用例不可移植。

depmesh 的新增测试不依赖 Graphviz，也不写死路径分隔符。

## 6. 上游值得保留的部分

- 解析链（precinct + filing-cabinet + dependency-tree）是这套生态里最成熟的一环，直接复用；
- `obj()` 的浅表树与 depmesh 的边集在真实语料上**逐条一致**（parity 用例），
  说明"复用解析、自己算图"这条路是稳的；
- 上游的 MIT 许可证与版权声明完整保留（见根目录 `LICENSE` 与 `NOTICE.md`）。
