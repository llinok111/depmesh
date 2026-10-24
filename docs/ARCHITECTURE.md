# 架构说明

本文说明 depmesh 的数据流、模块职责与关键取舍。所有数字都可在
`docs/REPORT-vue-core.md` 与 `docs/VERIFICATION.md` 中复核。

## 1. 定位

depmesh 是 **madge 之上的分析与交互层**，不是 madge 的替代品，也不是 fork 出来的分叉实现。

- 解析与解析式（parser / resolver）**完全复用上游生态**：`precinct` 提取说明符，
  `filing-cabinet` 解析路径。这两个包正是 madge 自己用的同一套（见
  `node_modules/dependency-tree/index.js`）。因此边集与 madge **逐条一致**，这一点由
  `test-depmesh/real.test.js` 的 parity 用例断言（vue-core 语料：1185 vs 1185，双向差异 0）。
- depmesh 新增的是 madge 没有的四件事：**逐说明符账本**、**强连通分量级的环**、
  **依赖路径查询**、**变更影响闭包**，以及一个可离线打开的交互式图谱。

为什么不做成 madge 的补丁：上游 `lib/` 只有 1152 行，`obj()` 返回的是 `{文件: [依赖]}` 的浅表结构，
边上的说明符、解析状态、语法形态全部丢失。在那种结构上做覆盖度与审计是不可能的，
所以新增一层，把"这条边是怎么来的"保留下来。

## 2. 数据流

```
roots ──discover──▶ 文件清单（跳过 node_modules / .git，按扩展名与 exclude 过滤）
                      │
                      ├─ precinct.paperwork ──▶ 说明符列表（真实解析，不是正则）
                      ├─ typescript.createSourceFile ──▶ 语法形态（static / dynamic / require / type）
                      │                                   └─ 语法错误计数（precinct 会吞掉解析失败）
                      └─ filing-cabinet ──▶ 绝对路径 / 空
                              │
                              ├─ 内部（项目内文件）──▶ edge {from, to, specifiers, forms}
                              ├─ 外部（node_modules 且不在 roots 内）──▶ 计入 externals，不展开
                              └─ 空 ──▶ 计入 ledger.unresolved，带 reason 分类
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
              Graph（索引 + 算法）                     coverage（账本 → 报告）
              ├ Tarjan SCC（迭代实现）                  ├ 文件级：扫描/解析/失败
              ├ 最短环（每个分量一条，逐边校验）          ├ 说明符级：内部/外部/未解析
              ├ BFS 最短路径                            ├ 原因分类 + 样例
              ├ 有预算的简单路径枚举                     └ 保证与已知限制
              └ 反向闭包影响面（带距离分层与见证链）
```

## 3. 模块职责

| 文件 | 职责 | 不做什么 |
| --- | --- | --- |
| `lib/depmesh/scan.js` | 发现文件、提取说明符、解析、记账、生成节点与边 | 不做图算法 |
| `lib/depmesh/graph.js` | 邻接/反向索引、Tarjan、环、路径、影响面、统计 | 不读磁盘、不解析源码 |
| `lib/depmesh/coverage.js` | 把账本转成覆盖度报告与文本 | 不做推断，只汇总 |
| `lib/depmesh/index.js` | 编排 scan → graph → coverage，导出紧凑模型 | 不格式化输出 |
| `lib/depmesh/ui.js` | 生成单文件交互页面（内联 CSS/JS/JSON） | 不发网络请求、不依赖 CDN |
| `bin/depmesh.js` | CLI 六个子命令与退出码 | 不含算法 |
| `scripts/build-report.js` | 生成 `docs/REPORT-vue-core.md`，支持 `--check` | 不改语料 |

## 4. 算法与复杂度

| 问题 | 算法 | 复杂度 | 为什么不用更简单的 |
| --- | --- | --- | --- |
| 哪些模块在环上 | Tarjan SCC，**迭代**实现 | O(V+E) | 递归版在 2 万节点链上会爆栈（用例 `graph: SCC survives a 20k-node chain` 守住这一点） |
| 环长什么样 | 每个分量取一条"经过指定节点最短环"，BFS 求 | O(k·(V+E))，k 为采样数 | 枚举全部初等环是指数级；上游 madge 用 DFS 回边路径，既重复又会漏（见 findings） |
| 两个模块怎么连上 | BFS 最短路径 | O(V+E) | DFS 不保证最短 |
| 所有路径 | DFS 简单路径 + 预算（`maxLength` / `maxPaths` / `maxExpansions`） | 指数级，**必须设预算** | 稠密图里全路径不可枚举；宁可返回 `truncated: true` 也不假装完整 |
| 改一个文件影响谁 | 反向 BFS 闭包，记录距离与见证前驱 | O(V+E) | 只做一跳就是 madge 的 `depends()`，实际不够用 |

## 5. 边集的可审计性

每个 `edge` 保留 `specifiers`（原始说明符字符串）与 `forms`（语法形态集合）。这带来两个硬性质：

1. **可回溯**：`test-depmesh/scan.test.js` 逐边断言"该说明符在源文件里逐字出现"，1185 条边全部通过。
2. **不虚构**：目标文件必须 `existsSync` 为真；解析失败或不存在的说明符只进 `unresolved`，绝不进边集。

## 6. tsconfig 修复

TypeScript 5 允许只写 `paths` 不写 `baseUrl`（相对 tsconfig 所在目录解析）。`filing-cabinet` 5.x
在缺少 `baseUrl` 时不解析 `paths`，madge 与 dependency-tree 都把 tsconfig 转成对象时丢掉了它，
于是**整条别名边链静默消失**。

`scan.js` 的 `loadTsConfig()` 在注入 `baseUrl` 后记录 `patches: ['tsconfig-paths-baseurl']`，
报告里可见。实测影响（vue-core，454 节点口径）：

| 配置 | 边数 | 别名解析 |
| --- | --- | --- |
| 原样交给上游 | 1329 | 全部丢失，35 条说明符落进 skipped |
| 注入 baseUrl 后 | 1737 | 恢复 408 条跨包边 |

`injectBaseUrl: false` 保留为**对照开关**，测试用它与默认行为对比，证明修复不是空话。

## 7. 前端

- 单文件：模型以 `<script type="application/json">` 内联，`<` 转义为 `\u003c`，任何数据都无法闭合脚本标签（有专门用例）。
- 零依赖：Canvas 2D + 原生 DOM，无 CDN、无打包步骤，`file://` 直接打开即可。
- 布局确定性：初始位置由 id 的 FNV 哈希导出，同一模型每次布局一致，截图可比。
- 交互：拖拽节点、拖拽画布、滚轮缩放、搜索高亮、过滤器（环/入口/叶子）、
  点击节点显示直接依赖与反向闭包、A→B 路径查询（同样的预算语义）。

## 8. 已知取舍

- **只做静态导入**：`require(variable)`、`import(path)` 不可见，报告中作为已知限制写明。
- **只展开项目内文件**：`node_modules` 里的包计数但不展开，避免把第三方内部结构混进项目图。
- **不解析 `.vue` / `.svelte`**：这些需要额外检测器，未纳入；扩展名白名单在报告里可见。
- **语法错误用 TypeScript 解析器判定**：非 TS 支持的扩展名直接返回 0，不猜。
