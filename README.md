# config-merge-rehearsal-api

配置发布系统的**并发修改预演（dry-run rehearsal）服务**。客户端提交一份基准 JSON 文档和
A、B 两组 RFC 6902 补丁（仅支持 `add` / `remove` / `replace`），服务在**基准坐标系**下合并两组
补丁：以基准数组索引标识原元素、同一插入缝隙按 **A 后 B** 定序、自动重定位增删引起的索引漂移，
产出**确定的合并结果**；当两组补丁在同一元素/对象路径上发生「删除 vs 修改」或「不同值替换」等
冲突时，返回**结构化冲突**（含双方操作序号、规范化路径、原因）。

技术栈：Node.js 20+ · Fastify 5 · 纯内存存储（无外部依赖服务）。

---

## 快速开始

### 单条启动命令（Docker Compose，推荐）

```bash
docker compose up --build
```

依赖安装（`npm ci`）与初始化全部在镜像构建/启动阶段完成，无需额外步骤。

### 本地运行

```bash
npm ci && npm start
```

### 服务地址与端口

| 项 | 值 |
| --- | --- |
| 监听地址 | `0.0.0.0`（容器内） |
| 端口 | `3000` |
| 健康检查 | `http://localhost:3000/health` |
| 合并接口 | `POST http://localhost:3000/api/v1/merges` |

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LOG_LEVEL` | `info` | 日志级别（`debug` / `info` / `warn` / `error`） |
| `STORE_MAX` | `1000` | 内存中最多保留的预演记录数，超出后按 FIFO 淘汰 |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查（存活/就绪探针） |
| `GET` | `/` | 服务元信息与端点清单 |
| `GET` | `/api/v1/example` | 返回示例请求体（干净合并 + 冲突各一份） |
| `POST` | `/api/v1/merges` | 执行合并预演，结果落内存存储 |
| `GET` | `/api/v1/merges` | 列出全部预演记录（摘要） |
| `GET` | `/api/v1/merges/:id` | 查询单条预演（含输入与结果） |
| `GET` | `/api/v1/merges/:id/order-audit` | 对已保存输入按严格 RFC 6902 顺序重放 A→B 与 B→A，判定可交换性 |
| `POST` | `/api/v1/merges/:id/resolution-preview` | 对 status=conflict 的已保存记录按冲突序号提交 A/B 裁决，预览解决结果（不落库） |
| `DELETE` | `/api/v1/merges/:id` | 删除单条预演（`204`） |

### `POST /api/v1/merges`

请求体：

```json
{
  "base":   { "任意": "JSON 文档" },
  "patchA": [ { "op": "replace", "path": "/replicas", "value": 3 } ],
  "patchB": [ { "op": "remove",  "path": "/servers/0" } ]
}
```

- `base`：任意 JSON 文档（对象、数组、标量均可）。
- `patchA` / `patchB`：RFC 6902 操作数组，**仅接受 `add` / `remove` / `replace`**；
  其他操作（`move`/`copy`/`test`）返回 `400`。
- 两组补丁都针对**同一份基准文档**求值（模拟两个变更基于同一版本并发提出）。

响应：

- **合并干净 → `200`**：`{ id, status: "clean", merged, conflicts: [], stats, createdAt }`
- **存在冲突 → `409`**：`{ id, status: "conflict", merged: null, conflicts: [...], stats, createdAt }`
- **补丁不合法（路径不存在、越界、缺 `value` 等）→ `422`**：
  `{ statusCode, error, code: "INVALID_PATCH", message, details: { side, index } }`
- **请求体结构/操作类型不合法 → `400`**

无论 `200` 还是 `409`，记录都会存入内存存储，可凭 `id` 查询。

### `GET /api/v1/merges/:id/order-audit`（顺序审计）

对一条**已保存**的预演记录，把其 `patchA`、`patchB` 当作两组**严格按 RFC 6902 顺序执行**的
补丁，分别重放两种次序：

- `A->B`：先逐条应用 `patchA`，再逐条应用 `patchB`；
- `B->A`：先 `patchB`，再 `patchA`。

与 `POST /api/v1/merges` 的**基准坐标合并模型**不同，顺序审计里**每组补丁内部逐条作用于上一
条操作的结果**：路径中的数组下标始终相对**当前文档**解析，增删引起的下标漂移**不会**被重定位
回基准坐标（这正是 RFC 6902 的原生执行方式）。

- 每组补丁内部第 N 条操作作用于第 0..N-1 条执行后的文档；
- 数组下标不沿用基准坐标——先插入/删除后，后续操作按新下标求值；
- 审计是已保存输入的纯函数：同一记录重复查询返回**逐字节一致**的结果（服务端按记录缓存）；
- 记录不存在时返回 `404`。

#### 响应结构

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "verdict": "commutative | divergent | failed",
  "base": { /* 保存时的基准文档 */ },
  "orders": {
    "A->B": {
      "status": "applied | failed",
      "steps": [
        {
          "order": "A->B",
          "side": "A",            // 该操作来自哪组补丁
          "index": 0,             // 该操作在其原始补丁中的序号（0 起）
          "op": "add",
          "path": "/servers/1",
          "afterExists": true,    // 执行后该路径是否存在
          "afterValue": { }       // 执行后该路径上的值（remove 时为 null）
          // "removedValue" 仅在成功的 remove 步骤上出现：被删除的值
        }
        // …按执行顺序排列的逐条轨迹（路径 + 执行后值）
      ],
      "finalDocument": { /* 成功时为最终文档；失败时为 null */ },
      "failure": null // 或见下
    },
    "B->A": { /* 同上 */ }
  },
  "firstDifference": null
}
```

#### 三种判定（`verdict`）

| `verdict` | 条件 |
| --- | --- |
| `commutative` | 两种顺序都成功，且最终文档深度相等（两组补丁可交换） |
| `divergent` | 两种顺序都成功但最终文档不同；`firstDifference` 递归给出 RFC 6901 **字典序最小**的差异路径及两侧值 |
| `failed` | 至少一种顺序失败 |

`divergent` 时的 `firstDifference`：

```json
{
  "path": "/servers/0/host",   // 字典序最小的差异指针（按转义后的 ~0/~1 比较）
  "aExists": true,             // A->B 结果在该路径是否存在
  "aValue": "a2.internal",     // A->B 一侧的值（不存在时为 null）
  "bExists": true,             // B->A 结果在该路径是否存在
  "bValue": "b.internal"       // B->A 一侧的值（不存在时为 null）
}
```

> 容器与非容器在同一路径上的类型变化（如对象 vs `null`、数组 vs 标量）即视为该路径上的叶子差异；
> 一侧缺失成员时以 `aExists`/`bExists` 区分，与「值恰好为 `null`」不相混淆。

`failed` 时，失败方的 `failure` 字段给出**失败方、原始操作序号和失败前文档**：

```jsonc
{
  "order": "A->B",
  "side": "B",                 // 失败的是哪组补丁
  "index": 0,                  // 失败操作在其原始补丁中的序号
  "op": "replace",
  "path": "/l/1/h",
  "code": "OUT_OF_BOUNDS",     // INVALID_PATH / INVALID_INDEX / OUT_OF_BOUNDS /
                               // PATH_NOT_FOUND / MISSING_VALUE /
                               // UNSUPPORTED_OP / TRAVERSAL_ERROR /
                               // ROOT_NOT_REMOVABLE / INVALID_OPERATION
  "message": "array index 1 out of bounds (length 1) at /l/1",
  "documentBefore": { "l": [ { "h": "b" } ] }  // 紧接失败操作之前的整份文档
}
```

失败方的 `steps` 只包含失败前已成功的操作（其副作用即体现在 `documentBefore` 中），
`finalDocument` 为 `null`；另一顺序若成功仍正常返回其轨迹与最终文档。

示例：

```bash
curl -s http://localhost:3000/api/v1/merges/<id>/order-audit | jq
```

以 `examples/merge-request.json` 为例，`POST` 的基准坐标合并是干净的，但严格 RFC 6902
顺序重放得到 `divergent`：同一下标缝隙的插入在两种次序下落点不同，最小差异路径为
`/servers/0/host`（`A->B` 为 `a2.internal`，`B->A` 为 `b.internal`）。

### `POST /api/v1/merges/:id/resolution-preview`（冲突解决预览）

对一条**已保存且 `status=conflict`** 的预演记录，按 `POST /api/v1/merges` 返回的冲突数组
**序号**（从 0 起，顺序与该记录 `conflicts` 数组一致）逐项提交保留方（`winner` 为 `A` 或
`B`），服务把败方原始操作从保存的 `patchA` / `patchB` 中剔除后，**重新调用同一套基准坐标
合并逻辑**给出预览结果。预览是已保存输入与裁决的纯函数：

- **不修改任何存储记录**——冲突记录保持 `status: "conflict"`、`merged: null`，原始
  `patchA` / `patchB` 原样保留；
- 相同请求重复提交结果**逐字节一致**；裁决数组中各项的先后次序不影响结果（按冲突序号对应）。

请求体：

```json
{
  "resolutions": [
    { "conflict": 0, "winner": "A" },
    { "conflict": 1, "winner": "B" }
  ]
}
```

约束与状态码：

| 情况 | 状态码 | 说明 |
| --- | --- | --- |
| 记录不存在 | `404` | — |
| 记录存在但不是 `conflict` 状态 | `409` | `code: "NOT_CONFLICTED"` |
| 请求体结构不合法（非数组、`winner` 非 A/B 等） | `400` | schema 校验 |
| 未**恰好**覆盖全部冲突（缺项、重复项、越界序号） | `422` | `code: "INCOMPLETE_RESOLUTION"`，`details` 列出 `missing` / `duplicate` / `outOfRange` 序号 |
| 同一原始操作在不同冲突中被同时要求保留和丢弃 | `422` | `code: "CONTRADICTORY_RESOLUTION"`，`details.conflicts` 列出操作（`side`、`index`）及 `retainedIn` / `droppedIn` 的冲突序号 |
| 过滤后重新合并仍有冲突 | `409` | 返回 `status: "conflict"` 与**剩余冲突**（可能由补丁内 last-wins 等规则在败方剔除后暴露） |
| 过滤后合并成功 | `200` | `status: "clean"` 与预览合并结果 |

> 同一操作可同时出现在多条冲突中（例如 A 的 `remove /o` 与 B 对 `/o/x`、`/o/y` 的两处修改
> 各产生一条冲突）。若这些冲突的裁决要求该操作的角色一致（同为保留或同为丢弃）则合法，
> 列表中该操作只出现一次，`conflictIndices` 给出全部相关冲突序号；角色互相矛盾时返回
> `422` 并列出操作与各自的冲突序号。

成功（`200`）响应：

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "resolutions": [ { "conflict": 0, "winner": "A" } /* 回显请求裁决 */ ],
  "status": "clean",
  "merged": { /* 剔除败方后的基准坐标合并文档 */ },
  "conflicts": [],
  "retained": [
    {
      "side": "A", "index": 0, "op": "remove", "path": "/database",
      "conflictIndices": [0]          // 该操作作为胜方出现的冲突序号
    }
  ],
  "dropped": [
    {
      "side": "B", "index": 0, "op": "replace", "path": "/database/host",
      "value": "db2.internal",        // 非 remove 操作带 value
      "conflictIndices": [0]          // 该操作作为败方出现的冲突序号
    }
  ],
  "stats": { /* 对过滤后补丁重新运行合并得到的统计；received 为过滤后的操作数 */ }
}
```

过滤后仍有冲突时（`409`）响应结构相同，但 `status` 为 `"conflict"`、`merged` 为 `null`、
`conflicts` 为重新检测出的剩余冲突；`retained` / `dropped` 仍如实反映本次裁决。

示例：

```bash
# 1) 制造冲突并取得记录 id
ID=$(curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/conflict-request.json | jq -r .id)

# 2) 冲突 0（/database）保留 A，冲突 1（/mode）保留 B
curl -s -X POST "http://localhost:3000/api/v1/merges/$ID/resolution-preview" \
  -H 'Content-Type: application/json' \
  -d '{"resolutions":[{"conflict":0,"winner":"A"},{"conflict":1,"winner":"B"}]}' | jq
```

## 示例请求

干净合并（也见 `examples/merge-request.json`，或 `GET /api/v1/example`）：

```bash
curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/merge-request.json | jq
```

该示例中：A 把 `replicas` 改为 `3`、在 `servers` 索引 1 处插入一台机器、开启 `tracing`；
B 删除 `servers[0]`、在**同一插入缝隙**（索引 1）插入另一台机器、新增 `features.retries`、
同样开启 `tracing`。合并结果：

```json
{
  "status": "clean",
  "merged": {
    "app": "payment-service",
    "replicas": 3,
    "servers": [
      { "host": "a2.internal", "port": 8080 },
      { "host": "b2.internal", "port": 9090 },
      { "host": "b.internal",  "port": 8080 }
    ],
    "features": { "cache": true, "tracing": true, "retries": 3 },
    "tags": ["stable"]
  },
  "stats": { "received": { "A": 3, "B": 4 }, "normalized": { "A": 3, "B": 4 },
             "deduplicated": 1, "conflicts": 0, "applied": 6 }
}
```

可以看到：同一缝隙的插入按 **A 后 B** 排列；`servers[0]` 被删除后其余元素按基准身份
重新定位；双方对 `/features/tracing` 的相同修改被去重（`deduplicated: 1`）。

冲突示例（`examples/conflict-request.json`）：

```bash
curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/conflict-request.json | jq
```

返回 `409`：

```json
{
  "status": "conflict",
  "merged": null,
  "conflicts": [
    {
      "reason": "delete-vs-modify",
      "path": "/database",
      "operations": [
        { "side": "A", "index": 0, "op": "remove",  "path": "/database" },
        { "side": "B", "index": 0, "op": "replace", "path": "/database/host", "value": "db2.internal" }
      ],
      "message": "one patch deletes this element while the other modifies it (A#0 vs B#0)"
    },
    {
      "reason": "replace-mismatch",
      "path": "/mode",
      "operations": [
        { "side": "A", "index": 1, "op": "replace", "path": "/mode", "value": "single" },
        { "side": "B", "index": 1, "op": "replace", "path": "/mode", "value": "readonly" }
      ],
      "message": "both patches replace the same target with different values (A#1 vs B#1)"
    }
  ]
}
```

其他常用命令：

```bash
curl -s http://localhost:3000/health | jq                 # 健康检查
curl -s http://localhost:3000/api/v1/merges | jq          # 预演记录列表
curl -s http://localhost:3000/api/v1/merges/<id> | jq     # 单条记录（含输入）
curl -s http://localhost:3000/api/v1/merges/<id>/order-audit | jq  # 顺序审计 A→B / B→A
curl -s -X POST http://localhost:3000/api/v1/merges/<id>/resolution-preview \
  -H 'Content-Type: application/json' \
  -d '{"resolutions":[{"conflict":0,"winner":"A"}]}' | jq          # 冲突解决预览（不落库）
curl -s -X DELETE http://localhost:3000/api/v1/merges/<id> # 删除记录
```

## 合并语义

> 本节描述 `POST /api/v1/merges` 的**基准坐标合并模型**。
> `GET /api/v1/merges/:id/order-audit` 不使用该模型，而是按 **RFC 6902 原生顺序执行**
> 重放（补丁内逐条作用于上一条结果、数组下标不重定位），详见上文「顺序审计」。

### 基准坐标模型

两组补丁中的所有路径都相对**基准文档**解释：数组索引标识的是基准数组中的**原元素**，
而非某个中间结果。服务据此重定位增删造成的索引漂移——例如 A 在 `/servers/0` 前插入、
B 修改 `/servers/2/host`，合并后 B 的修改仍落在基准第 2 号元素上（其新下标可能已变化）。

### 数组

- `add /arr/i`：在**缝隙 i**（基准第 i 号元素之前）插入；`i == 数组长度` 或 `-` 表示追加。
- 同一缝隙的多个插入：先 A 后 B，同侧保持补丁内顺序。
- `remove /arr/i`、`replace /arr/i`：作用于基准第 i 号元素，与其最终下标无关。
- 元素内部的深层修改（如 `/arr/1/host`）跟随元素身份漂移。

### 去重（不产生冲突）

- 双方 `replace` 同一目标且值深度相等 → 应用一次。
- 双方 `remove` 同一目标 → 应用一次。
- 一方删除祖先路径、另一方删除其内部后代 → 后代删除被祖先覆盖，丢弃。
- 双方 `add` 同一个新对象成员且值相等 → 应用一次。

### 冲突类型（返回 `409`）

| `reason` | 含义 |
| --- | --- |
| `delete-vs-modify` | 一方删除某元素/子树，另一方对同一路径或其内部做 `replace`/`add` |
| `replace-mismatch` | 双方 `replace` 同一目标但值不同 |
| `add-mismatch` | 双方 `add` 同一个（基准中不存在的）对象成员但值不同 |
| `replace-overlap` | 一方整体替换某子树，另一方修改其子树内部 |

每条冲突包含：`reason`（原因）、`path`（规范化后的争议路径，RFC 6901 转义）、
`operations`（双方操作的 `side`、`index`（操作序号）、`op`、`path`、`value`）、`message`。

### 补丁内规则（同一补丁）

- 同一路径的多个非插入操作：**后者覆盖前者**（last-wins）；数组插入不去重，按序累积。
- 不允许一个操作的路径是另一个 `add`/`remove`/`replace` 目标的**后代**（返回 `422`），
  数组插入除外（插入不占有子树）。
- 对象成员上的 `add` 若键已存在，按 RFC 6902 规范化为 `replace`。
- 不支持删除文档根（`remove ""`）；`replace ""` 允许整体替换文档。

## 测试

```bash
npm test
```

覆盖：指针转义、索引漂移重定位、同缝隙 A/B 定序、去重规则、全部冲突类型、
非法补丁（`422`）、schema 校验（`400`）、存储的增删查、健康检查，以及顺序审计的
可交换 / 发散（RFC 6901 字典序最小差异）/ 失败（失败方、原始序号、失败前文档）判定与
重复查询确定性；冲突解决预览的恰好覆盖（`422`）、矛盾裁决（`422`，同一操作跨冲突既保留
又丢弃）、过滤后剩余冲突（`409`）、非冲突记录（`409`）、不存在（`404`）、不落库与
重复请求确定性等。

## 项目结构

```
.
├── server.js                  # 进程入口：读取环境变量、启动与优雅退出
├── src/
│   ├── app.js                 # Fastify 应用：路由、schema 校验、错误处理
│   ├── merge.js               # 合并引擎：规范化 → 补丁内解析 → 跨补丁冲突检测 → 应用
│   ├── audit.js               # 顺序审计：严格 RFC 6902 顺序重放 A→B / B→A、失败捕获、字典序最小差异
│   ├── resolution.js          # 冲突解决预览：按冲突序号剔除败方后复用基准坐标合并逻辑（纯函数）
│   ├── store.js               # 内存存储（FIFO 淘汰）
│   └── example.js             # 内置示例请求
├── test/                      # node:test 单元 + 集成测试
├── examples/                  # 可直接 curl 的示例请求体
├── Dockerfile                 # 多阶段构建（npm ci 在构建期完成）
└── docker-compose.yml         # 单服务编排 + 健康检查
```

## 说明与限制

- 存储为进程内存，重启即清空；如需持久化可在 `src/store.js` 替换实现。
- 合并是确定性的：同一输入永远产生同一输出（冲突列表按路径与原因排序）。
- 单补丁内操作按基准坐标解释，不做补丁内顺序重放；同路径多操作按 last-wins 处理（见上）。
  若需要「补丁内逐条作用于上一条结果、下标随当前文档漂移」的严格 RFC 6902 语义，
  使用 `GET /api/v1/merges/:id/order-audit`；其结果按记录缓存，重复查询完全一致。
