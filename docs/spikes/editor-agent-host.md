# P4.0 Editor Agent Host Endpoint Spike

> 日期：2026-08-30<br>
> 环境：macOS arm64，VS Code `1.135.0`（commit `08d4889f9ec4a1685d257b9b95de036c8e1ce1e5`），Node `v24.12.0`<br>
> 目的：为 0.4.0 Peer Window Delegation 重设计提供事实依据<br>
> 结论：**用户正在运行的 VS Code 实例本身就是一个 AHP 1.0.0 服务端**，扩展可以作为
> AHP 客户端连接它，并在用户真实可见的 Chat Sessions 中创建会话。

本 Spike 只做只读探测。除 `initialize`/`subscribe`/`listSessions` 外没有对用户实例
执行任何写操作，没有创建会话，也没有派发任何 Turn。

## 1. 背景与待验证问题

0.3.0 的 Agent Host 集成通过 `AgentHostLauncher` 启动一个**隔离的无头实例**：

```
code agent host --new-instance --foreground \
  --host 127.0.0.1 --port 0 \
  --user-data-dir <临时目录>/user-data \
  --server-data-dir <临时目录>/server-data \
  --connection-token-file <临时目录>/connection-token
```

`--new-instance` 加上一次性 `--user-data-dir` 意味着：

- 该实例与用户已登录的 VS Code 完全隔离；
- 它需要独立完成 Copilot 认证（这正是既有文档中「专用认证 Profile」的由来）；
- 在其中创建的 Session **不可能**出现在用户交互窗口的 Chat Sessions 列表中；
- 临时目录随任务销毁，会话不可回溯。

0.4.0 需求要求「子窗口能看到被委派的任务」，因此必须回答四个问题：

| 编号 | 问题 |
| --- | --- |
| Q1 | 用户正在运行的 VS Code 是否对外暴露 AHP endpoint？ |
| Q2 | 该 endpoint 的传输与认证方式是什么？ |
| Q3 | 它协商的协议版本是否与我们锁定的 offer `1.0.0` 兼容？ |
| Q4 | 通过它看到/创建的 Session 是否就是用户 UI 中的真实会话？ |

## 2. Q1 — Endpoint 发现

`AgentHostLauncher` 已经在使用 `code agent endpoints --user-data-dir <dir>` 做基线
比对，但始终传入自己拥有的临时目录。改为传入**用户真实的 user-data 目录**：

```sh
code agent endpoints --user-data-dir "$HOME/Library/Application Support/Code"
```

实际输出（token、socket 路径与实例标识已脱敏，`pid` 为示意值）：

```json
{
  "userDataPath": "<用户 user-data 目录>",
  "endpoints": [
    {
      "schemaVersion": 2,
      "type": "editor",
      "pid": 12345,
      "instanceId": "<实例 ID>",
      "protocolVersion": "1.0.0",
      "connectionToken": "<32 字节随机 token>",
      "endpoint": { "type": "socket", "path": "<临时目录>/<instanceId>.sock" }
    }
  ]
}
```

**结论 Q1：是。** 正在运行的交互式 VS Code 注册了一个 `type: "editor"` 的 agent host
endpoint，与 0.3.0 启动的 standalone host 属于同一注册表格式（`schemaVersion: 2`）。

### 2.1 endpoint 的粒度是实例，不是窗口

用户当时打开了多个窗口，但注册表只有**一条** `editor` 记录，`pid` 与 `instanceId`
唯一。macOS 上一个 VS Code 应用是单一主进程、多窗口，因此：

> **一个 VS Code 实例 = 一个 `editor` endpoint = 全部窗口共用。**

这直接决定了 0.4.0 的路由设计：**目标窗口不能靠 endpoint 区分**，只能靠 Session 的
`workingDirectories` / `project` 归属到具体 Workspace，再由 Window Node 注册表把
Workspace 映射回窗口。既有的 Device Broker + Window Node + Workspace Claim 三层路由
因此仍然是必需的，不能被 endpoint 取代。

## 3. Q2 — 传输与认证

`endpoint.type` 是 `socket`（Unix domain socket），而 0.3.0 的 standalone host 是
`ws://127.0.0.1:<port>`。对该 Unix socket 发起标准 WebSocket Upgrade：

```
GET /?tkn=<connectionToken> HTTP/1.1
Host: localhost
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <base64 nonce>
Sec-WebSocket-Version: 13
```

响应：

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: <accept>
```

**结论 Q2：** 是「Unix socket 之上的普通 WebSocket」，认证沿用 endpoint 注册表里的
`connectionToken`，通过查询参数 `?tkn=` 传递——与 standalone host 完全一致，只是
传输层从 TCP 换成 Unix socket。

AHP TypeScript client 的 `AhpTransport` 明确声明是可插拔的（注释原文：
_"Any framed message stream — a WebSocket, a Unix socket, stdio, or an in-memory pair
for tests"_），因此现有 `WebSocketTransport.fromSocket(socket)` 可以直接复用，只需要
一个能对 Unix socket 建立 WebSocket 的连接器。

> **实现约束：** VS Code Extension Host 提供的全局 `WebSocket` 只接受 `ws:`/`wss:` URL，
> 无法拨号 Unix socket。0.4.0 需要一个 Node 侧连接器（`net.connect(path)` +
> WebSocket 握手）。本 Spike 使用仓库既有依赖 `ws@8.21.3` 的 `ws+unix://<path>:/<query>`
> 形式完成握手，证明该路径可行且无需新增依赖。

## 4. Q3 — 协议版本协商

首次尝试用错误的参数形状调用 `initialize`，服务端返回了明确的版本错误，反而精确
确认了服务端能力：

```json
{
  "code": -32005,
  "message": "Client offered protocol versions [], none of which are compatible with this server's version 1.0.0 (server accepts ^1.0.0).",
  "data": { "supportedVersions": ["^1.0.0"] }
}
```

使用正确的 `InitializeParams` 形状重试：

```jsonc
// 请求
{ "channel": "ahp-root://", "protocolVersions": ["1.0.0"],
  "clientId": "<uuid>", "clientInfo": { "name": "mesh-research-probe", "version": "0.0.0" } }
// 结果
{ "protocolVersion": "1.0.0", ... }
```

**结论 Q3：兼容。** 服务端接受 `^1.0.0`，选定 `1.0.0`，与本仓库锁定的 AHP
submodule（`f19dd8b3942d029744a3bdd31d830f9428e8ea47`，TypeScript client 0.9.0，
protocol offer 1.0.0）完全一致。这同时再次印证了不跟随 upstream `60706330`
（AHP 0.9.0 offer）的既定决策：那会与 VS Code 1.135.0 的 `^1.0.0` 要求不兼容。

## 5. Q4 — Session 可见性与 Provider 目录

### 5.1 `listSessions` 返回的是用户真实会话

```jsonc
{
  "items": [
    {
      "resource": "copilotcli:/<uuid>",
      "provider": "copilotcli",
      "title": "G0 authentication unblock",
      "status": 33,
      "createdAt": "...", "modifiedAt": "...",
      "project": { "uri": "<仓库根>", "displayName": "copilot-agent-mesh" },
      "workingDirectories": ["<worktree 路径>"],
      "_meta": { "vscode.external": true }
    },
    { "resource": "copilotcli:/<uuid>", "title": "Multi-project collaboration", ... }
  ]
}
```

返回的条目就是用户此刻在 VS Code 中真实存在的 Copilot 会话（其中第二条正是产生本
文档的会话）。每条都带 `project` 与 `workingDirectories`。

**结论 Q4：是。** 通过 `editor` endpoint 观察到的 Session 与用户 UI 中的 Chat
Sessions 是同一份数据。因此**在该 endpoint 上创建的 Session 有充分理由出现在用户
对应 Workspace 窗口的 Chat Sessions 列表中**。

> **仍需 E2E 证明：** 本 Spike 只读，未创建 Session。「新建 Session 出现在目标窗口
> Sessions 列表」必须由 0.4.0 的真实 E2E 断言，在此之前只能记为 *预期可行*，不得
> 在文档中标记为 Pass。

### 5.2 方法命名

只有非前缀形式存在，root 通道方法**不带** `root/` 前缀：

| 调用 | 结果 |
| --- | --- |
| `listSessions` | ✅ 返回目录 |
| `root/listSessions` | ❌ `-32601 Method not found` |
| `listAgents` / `root/listAgents` | ❌ `-32601`（agents 不是命令，见下） |

### 5.3 Agent 目录来自 root 通道快照

`subscribe { channel: "ahp-root://" }` 返回 64 KiB 快照，state key 为
`['agents', 'activeSessions', 'config', '_meta']`。`agents[0]` 摘要：

```jsonc
{
  "provider": "copilotcli",
  "displayName": "Copilot",
  "description": "Copilot SDK agent running in the local agent host process",
  "models": [
    { "id": "auto", "name": "Auto" },
    { "id": "claude-sonnet-5", "name": "Claude Sonnet 5", "policyState": "enabled",
      "maxContextWindow": 1000000, "supportsVision": true, "configSchema": { /* thinkingLevel, contextSize */ } },
    { "id": "claude-opus-5", "name": "Claude Opus 5", "policyState": "enabled", ... }
  ]
}
```

**结论：** 用户实例中的 `copilotcli` provider 已就绪且 `policyState: "enabled"`，
即**沿用用户已登录的 Copilot 身份，无需再走独立设备码认证**。

## 6. 对 0.4.0 设计的直接影响

| 事项 | 0.3.0 现状 | 0.4.0 依据本 Spike 的结论 |
| --- | --- | --- |
| Agent Host 来源 | 自行 spawn 隔离 standalone 实例 | 优先连接用户实例的 `editor` endpoint |
| 认证 | 需要专用 Profile + 设备码 | 复用用户已登录身份，无额外认证 |
| 子窗口可见性 | 不可能（隔离实例） | 预期可行，须由 E2E 证明 |
| 传输 | `ws://127.0.0.1:<port>` | Unix socket + WebSocket Upgrade，`?tkn=` 认证 |
| 协议 | offer `1.0.0` | 不变，服务端 `^1.0.0` 已确认 |
| 窗口路由 | Device → Node → Workspace | **保持不变**，endpoint 只到实例粒度 |
| 会话生命周期 | 随临时目录销毁 | 落在用户实例中，可回溯、可打开 |

### 6.1 新增风险

1. **写入用户真实实例。** 从「隔离沙箱」变成「用户的真实会话空间」，误创建、未清理
   或标题泄漏的后果更严重。所有创建的 Session 必须有明确标题前缀、明确归属
   Workspace，并在任务终止时被明确处置。
2. **endpoint 注册表可能为空。** 若用户使用自定义 `--user-data-dir`、Remote 场景或
   实例尚未注册，`code agent endpoints` 可能返回空数组。必须保留 standalone
   launcher 作为回退路径，并让降级在 UI 中显式可见。
3. **token 与 socket 路径是敏感值。** `connectionToken` 与 socket 绝对路径绝不能进入
   Webview、日志、任务输出或错误消息，须纳入既有脱敏边界。
4. **`--user-data-dir` 的解析。** 需要正确推导当前 VS Code 的 user-data 目录（不同
   平台、Insiders、便携模式、自定义参数均不同），不能硬编码 macOS 路径。

## 7. Language Model Tool 面的补充结论

同批调研核对了 `@types/vscode` 的 Tool API（用于 0.4.0 的委派 Tool 设计）：

- `LanguageModelTool.invoke(options, token: CancellationToken)` 返回
  `ProviderResult<LanguageModelToolResult>`；**稳定 API 未声明任何调用时长上限**，
  取消完全由 `CancellationToken` 驱动。长时等待在 API 层面没有被禁止，但也没有被
  保证，必须自带预算与超时。
- `prepareInvocation` 返回的 `PreparedToolInvocation.confirmationMessages` 只有
  `title` 与 `message` 两个字段，文档明确说明「These messages will be shown with
  buttons that say **"Continue" and "Cancel"**」。
  **因此不存在「Allow once / Allow all / Deny」三按钮的原生确认 UI。** 0.4.0 的授权
  模型必须折叠为二元确认（Continue = 按本次任务已声明的范围授权；Cancel = 拒绝），
  授权范围写进确认正文，而不是依赖第三个按钮。
- `PreparedToolInvocation.invocationMessage` 可自定义运行期进度文案，是长时委派任务
  唯一可用的原生「正在进行」提示。

## 8. 复现方式

上述探测由一次性脚本完成，未落入仓库。复现步骤：

1. 保持一个已登录 Copilot 的 VS Code 1.135.0 实例运行。
2. `code agent endpoints --user-data-dir "$HOME/Library/Application Support/Code"`
   （其他平台替换为对应 user-data 目录），确认存在 `type: "editor"` 条目。
3. 用 `ws` 对 `endpoint.path` 发起 `ws+unix://<path>:/?tkn=<connectionToken>`。
4. 依次调用 `initialize`（`channel: "ahp-root://"`、`protocolVersions: ["1.0.0"]`、
   `clientId`）、`subscribe`（`channel: "ahp-root://"`）、`listSessions`。

> 复现时请勿把 `connectionToken` 或 socket 路径写入任何持久文件或提交内容。

## 9. Gate 状态

| 项 | 状态 |
| --- | --- |
| Q1 endpoint 存在 | ✅ 已证明 |
| Q2 传输与认证 | ✅ 已证明（101 Switching Protocols） |
| Q3 协议 `1.0.0` 兼容 | ✅ 已证明 |
| Q4 Session 即用户真实会话（读） | ✅ 已证明 |
| Q4' 新建 Session 出现在目标窗口 Sessions 列表 | ⛔ 未验证，须 0.4.0 真实 E2E |
| Tool 长时调用在真实 Copilot UI 下的表现 | ⛔ 未验证，须 0.4.0 真实 E2E |
| 非 macOS / Insiders / 便携模式的 endpoint 发现 | ⛔ 未验证，超出当前支持范围 |

### P6 后续实验（2026-08-31）

P6 使用实现中的严格 locator 在另一台 macOS arm64 开发环境执行了相同只读发现边界。
Stable user-data 存在且命令成功，但 endpoint/editor 计数均为 0；Insiders user-data
不存在。因此 Unix-socket AHP initialize 与写入 Session 实验没有可连接对象，均记录为
**unverified**，未创建 Session、未消费模型配额，也未留下 token、socket 或 Workspace
路径证据。该环境结果不推翻本 Spike 的已证明结果，只说明 P8 必须在一个正在运行并注册
editor endpoint 的普通 VS Code 实例内完成 O1。

### P8 自动化边界（2026-08-31）

P8 已实现可重复的两个普通窗口 Harness。它在窗口启动后用相同的严格 Locator 连接本次
唯一 live `editor` endpoint；`createSession` acknowledgement 后，E2E-only lifecycle
observer 只记录 Host 在 subscribed Session snapshot 或 Session-channel action 中回显的
created Session channel 事实及 Session/source/endpoint domain-separated 截断 Hash，作为
AC-5.9 的客观 runtime 证据。与 recovery 共用同一本地 URI 的 hash 相等不算独立证据。另有 bounded
post-task `listSessions` 只服务 O1 catalog/UI 可见性判断；原始 task handle 只有在 subscription
关闭、unsubscribe 与 AHP connection shutdown 成功后才记录 `session/clientDetached`，诊断收到
该事件后才建立新连接，并且通过有页数上限、cursor 循环检测的分页扫描，只把 Idle/Error、
非 InProgress、Archived 的 Session 纳入 hash 匹配。任何
路径都不保存 resource URI、socket 路径或 token。

VS Code 1.135.0 的 Host 会在 `createSession` 时先注册 Session，但 provider 可以返回
provisional Session；`chat/turnComplete` 与 response 已可见时，provider 的
`onDidMaterializeChat`/catalog metadata 仍可能尚未完成。此时立即 unsubscribe/disconnect
会让 Chat Sessions UI 留在最后收到的 `Working…` 状态，并让未 materialize 的 draft 进入
Host GC。仅跳过 `disposeSession` 因此不是 persistence proof。客户端现在只接受当前 `turnId`
的终止 action。两次真实诊断分别证明保持 Session subscription、以及只
`unsubscribe(session)` 但保留同一连接时，catalog 都可能继续为空；因此同一 handle 的
`listSessions` 不能作为 terminal readiness barrier。AHP 1.0 的 `session/ready` 是 provisional
Session 完成 materialization 的明确生命周期信号；客户端在权威终止后有界等待 exact Session
ready，再依次 dispatch `session/isArchivedChanged { isArchived: true }` 和自身
`session/activeClientRemoved`，分别等待 Host 权威 echo，之后 unsubscribe Session；completion
随后发布，权威 cancel/error 即使 preparation 失败也随后发布
原 Host-confirmed 终态。任一 exact Host-authoritative terminal 都会先停止仍在运行的 cancellation
timer。正常 handle disposal 关闭其余订阅和连接。这样不会依赖
Host 对 unsubscribe/disconnect 的 SHOULD 级隐式清理，且 active-client tools/customizations
明确移除；read metadata 不由 Mesh 伪造。只有 disposal 完成后，诊断才从新的独立连接进行
有界分页，并要求 exact Session 为 Idle/Error、非 InProgress、Archived。连接 shutdown
只给 WebSocket 有界的 graceful-close 时间，随后强制关闭本地 socket，避免 Host close handshake
不结束时永久卡住 handle disposal。所有已启动 pump 的清理路径（包括 Terminal prune 和 startup
handoff）必须先 unsubscribe，再关闭 iterator；固定 SDK 的 iterator `return()` 会先 detach
cursor 且不会唤醒已经等待中的 `next()`，反向顺序会永久死锁。pump settlement 另有硬上限，
超时在 connection/Host shutdown 后显式失败。exact Host-authoritative terminal 会在 history
preparation 前停止 cancellation timer；provisional never-ready 或 detach 失败会 dispose orphan
并在 cleanup 报错，但不会把 Host-confirmed cancelled/error 改写成 failure/cancel-timeout。

真实运行 `1cf32269…` 进一步否定了“ready + active-client removal 足以结束 UI 状态”的假设：
该运行在 post-detach window 已有 exact `chat/turnComplete`、Host Session echo、
`session/clientDetached` 和全零资源清理，但用户仍看到 exact row 长期显示 `Working…`。
VS Code 1.135 的 Chat Sessions controller 将 archive flag 映射到 Done/history；AHP 1.0 又明确将
`session/isArchivedChanged` 定义为客户端在 task complete 时触发的 action。因此 Mesh 只在 exact
authoritative terminal 且 materialized 后自动 archive，等待同源 acknowledgement 后才移除
active client。`needsInput`、startup/provisional/orphan 路径不会 archive；后者仍由
`disposeSession` 清除。最终 UI 证据区分 `retained-done`、`retained-working` 与 `absent`。
VS Code 1.135 在有真实 summary 时可能对带 schema-optional `limit` 的 `listSessions` 返回
`-32603`；scanner 仅在这个精确错误上省略 `limit` 重试，cursor/page/cycle 上限保持不变。

稳定 Extension API 不提供读取 Chat Sessions UI 或向内置 Copilot Agent 自动发送并确认
消息的接口。P8 在 VS Code 1.135.0 观察到无 Chat context 的
`vscode.lm.invokeTool` 会执行 `prepareInvocation` 并显示独立 modal，但这个 modal 没有
父 Chat 身份，不能证明用户在 Copilot 侧边栏接受委派。P8 的人工阶段保留两个真实窗口并
给出精确 Agent-mode 操作；若没有人工可见观察，Q4' 继续记为 **unverified**，不从
`listSessions` 或独立 modal 推断为 Pass。
