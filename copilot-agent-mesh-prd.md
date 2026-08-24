# Copilot Agent Mesh 产品需求文档

> 工作名称：Copilot Agent Mesh  
> 文档版本：v0.3<br>
> 状态：Draft / 可用于创建项目  
> 日期：2026-08-24  
> 产品形态：个人使用的 VS Code Desktop 扩展  
> 支持平台：Windows、macOS、Linux

## 1. 产品摘要

Copilot Agent Mesh 是一个安装在多台开发设备上的 VS Code 扩展。它让用户在任意一台主设备的 VS Code Copilot Agent 中描述完整开发需求，并通过扩展提供的 Language Model Tools，把平台相关或仓库相关的子任务委派给其他设备上的 VS Code 内置 Copilot Agent 执行。

设备之间通过 Microsoft Dev Tunnels 建立点对点 WSS 通信。每台从设备可以启动监听服务、配置设备名、注册允许执行任务的本地 Workspace，并显示可分享的连接 URL。主设备通过输入连接 URL 注册从设备，在控制界面查看连接状态、可用 Workspace 和远程任务状态。

远端任务完成后，结果作为 Tool Result 返回主设备原始 Copilot Agent 会话，主 Agent 可以继续推理、执行本地任务并向用户汇总跨平台、跨仓库的最终结果。

## 2. 背景与典型场景

一个完整功能可能涉及多种开发环境和多个代码仓库：

- Windows 设备负责 Windows 客户端。
- macOS 设备负责 iOS/macOS 客户端和 Xcode 测试。
- Linux 设备负责服务端、容器或 Linux 专用构建。
- 客户端与服务端可能位于不同 Git 仓库。
- 用户当前只操作其中一台设备，其余设备持续在线但无人值守。

示例：

```text
用户在 Windows VS Code 中输入：
“实现账号登录功能，包括 Windows 客户端、iOS 客户端和服务端接口。”

Windows Copilot Agent：
1. 在本地实现 Windows 客户端。
2. 调用扩展 Tool，把 iOS 子任务发给 Mac。
3. 调用扩展 Tool，把服务端子任务发给 Linux。
4. 等待远程任务完成。
5. 汇总各设备的 Agent 结果、测试结果和未解决问题。
```

## 3. 产品目标

1. 打通不同设备上 VS Code 内置 Copilot Agent 的任务通信。
2. 用户只操作主设备，不需要远程桌面或直接操作从设备。
3. 支持 Windows、macOS、Linux 任意组合；任意设备都可作为主设备或从设备。
4. 支持同一仓库和不同仓库的任务委派。
5. 让主 Copilot Agent 能通过标准 Language Model Tool 自动发现设备、选择 Workspace、派发任务并获得结果。
6. 提供可视化控制界面，用于启动监听、显示连接 URL、管理设备和查看任务。
7. 复用 VS Code 内置 Copilot Agent，不在扩展中重新实现 Agent Loop。

## 4. 非目标

首个版本明确不包含：

- 多用户、团队级 RBAC 或企业策略管理。
- 自建云端调度服务；Microsoft Dev Tunnels 是唯一公网中继。
- 远程桌面、屏幕控制或键鼠模拟。
- 接管从设备上用户当前打开的任意 Copilot Chat 标签页。
- 自动把一个产品需求拆成完整 DAG；任务拆分主要由主 Copilot Agent 完成。
- 检查或改变 Workspace 的 Git 状态、当前分支、HEAD、worktree，或判断当前状态是否适合开始开发。
- 向远端 Agent 注入创建 Git worktree、切换或创建分支、Commit、Push、创建 PR 等操作要求；这些行为完全由 Agent 自主决定。
- 自动解决跨仓库合并冲突。
- 自动部署生产环境。
- 支持 vscode.dev Web Extension；首版仅支持桌面扩展宿主。

## 5. 核心概念

| 概念 | 定义 |
| --- | --- |
| Device | 安装并运行扩展的一台 Windows、macOS 或 Linux 设备。 |
| Coordinator | 用户当前操作的主设备，负责向其他设备派发任务。 |
| Worker | 接收并执行远程任务的从设备。一个设备可同时是 Coordinator 和 Worker。 |
| Workspace | Worker 明确注册并允许远程 Agent 使用的本地项目目录。 |
| Connection | Coordinator 根据连接 URL 保存的一条远程设备连接配置。 |
| Task | 发往指定 Device/Workspace 的一次 Copilot Agent 开发任务。 |
| Remote Agent Session | Worker 通过本地 Agent Host/AHP 创建的内置 Copilot Agent 会话。 |

## 6. 核心用户流程

### 6.1 从设备启动监听

1. 用户在从设备打开项目和 Copilot Agent Mesh 控制界面。
2. 配置设备名，例如 `mac-ios`、`linux-server`。
3. 将当前 Workspace 注册为允许远程执行的 Workspace。
4. 点击“启动监听”。
5. 扩展启动本地 Gateway 服务并创建或恢复持久 Dev Tunnel。
6. 页面显示：
   - 监听状态
   - 本地端口
   - Tunnel 状态
   - 可复制的连接 URL
   - 已连接主设备数量

### 6.2 主设备注册连接

1. 用户在主设备打开控制界面。
2. 点击“添加设备”。
3. 粘贴从设备提供的连接 URL。
4. 扩展建立 WSS 连接并完成协议握手。
5. 界面显示设备名、操作系统、在线状态、延迟、Workspace 和当前任务。
6. 连接配置被持久化，后续启动自动重连。

### 6.3 Copilot Agent 委派任务

1. 用户在主设备 Copilot Agent 输入跨平台或跨仓库需求。
2. 主 Agent 调用 `mesh_list_workers` 获取可用设备和 Workspace。
3. 主 Agent 调用 `mesh_delegate_task`，传入目标设备、Workspace 和任务描述。
4. Coordinator 扩展通过 Dev Tunnel 将任务发送到 Worker。
5. Worker 使用本地 AHP 创建 Copilot Agent Session 并开始执行。
6. 进度实时显示在主设备控制界面。
7. `mesh_delegate_task` 在 Worker 接受后立即返回 `pending + taskId`，不等待完整编码任务。
8. 主 Agent 可调用 `mesh_get_task` 查询状态；用户也可在 Dashboard 查看进度。
9. 远端 Agent 完成后，`mesh_get_task` 返回受限的结构化结果，主 Agent 可在当前会话继续处理。

### 6.4 远程问题与审批

当远端 Agent 需要澄清或工具审批时：

1. Worker 将 `inputNeeded` 或工具确认事件转发给 Coordinator。
2. 主设备控制界面显示问题或审批请求。
3. 用户在主设备回答、允许或拒绝。
4. 结果返回 Worker 的 AHP Chat Channel。
5. 远端 Agent 继续执行。

## 7. 功能需求

### FR-1：设备身份与配置

- 扩展首次启动生成稳定的 `deviceId`。
- 用户可配置可读设备名。
- 自动采集并展示：操作系统、CPU 架构、VS Code 版本、扩展版本。
- 设备名可修改，`deviceId` 不随名称变化。
- 配置和非敏感状态存入 `globalState`。
- 配对密钥和访问令牌存入 VS Code `SecretStorage`。

### FR-2：Workspace 注册

- 用户可以注册当前打开的 Workspace。
- 每个 Workspace 包含：
  - `workspaceId`
  - 显示名称
  - 本地路径，仅保存在 Worker
  - 可编辑能力标签，例如 `ios`、`windows`、`linux`、`backend`、`docker`
- Workspace 可以是任意本地目录；扩展不要求它是 Git 仓库，也不读取 Git remote、分支、HEAD、worktree 或工作区状态。
- Coordinator 只能使用 `workspaceId`，不能提交任意绝对路径。
- 用户可以启用、禁用或删除 Workspace。
- MVP 每个 Workspace 同时只允许一个远程写任务。

### FR-3：监听服务

- Worker Gateway 仅绑定 `127.0.0.1`。首次使用随机可用端口并持久化，后续优先复用同一端口。
- 端口冲突时不得静默改变公开地址；由用户确认迁移 Tunnel Port，并明确要求已有 Coordinator 重新配对。
- Gateway 提供 HTTP 健康检查与 WebSocket JSON-RPC 端点。
- 用户可手动启动、停止、重启监听。
- 可配置随 VS Code 启动自动监听。
- VS Code 退出或扩展停用时，正确关闭 Gateway 和 Tunnel 子进程。
- 异常退出后，下次启动能够恢复持久 Tunnel。

### FR-4：Microsoft Dev Tunnels 集成

MVP 使用 `devtunnel` CLI 子进程，而不是直接集成 SDK。

- 启动前检测 `devtunnel` 是否可执行。
- 检测用户是否已通过 `devtunnel user login` 登录。
- 缺少 CLI 或登录状态时，在 UI 中显示平台对应安装/登录指引。
- 首次监听时创建持久 Tunnel，并在后续启动复用。
- Tunnel 使用 HTTP 协议转发本地 Gateway，远端以 WSS 连接。
- MVP 默认使用 Port-scoped、有限期 Anonymous Access，同时由插件自己的高熵配对邀请和 Peer Credential 保护 Gateway。
- Tunnel-wide `--allow-anonymous` 只能由用户每次显式选择，并显示更大暴露面的 Preview 警告。
- 使用 `devtunnel show --json` 获取结构化 Tunnel 信息；按已验证 CLI Build 使用版本化 Decoder 发现目标 Port 的 HTTPS Forwarding URI，不硬编码单一字段名。未知结构明确报错，不解析自然语言输出。
- 支持重新生成 Tunnel、连接 URL 和配对密钥。

参考命令流程：

```bash
devtunnel user show
devtunnel create <tunnel-id> --tags copilot-agent-mesh
devtunnel port create <tunnel-id> -p <gateway-port> --protocol http
devtunnel access create <tunnel-id> --port <gateway-port> --anonymous --expiration <duration>
devtunnel host <tunnel-id>
devtunnel show <tunnel-id> --json
```

### FR-5：连接 URL

从设备显示一个可复制的连接 URL。连接 URL 至少携带：

- 协议版本
- Dev Tunnel WSS Endpoint
- `deviceId`
- 一次配对所需的高熵密钥

建议格式：

```text
https://<tunnel-port-uri>/agent-mesh/connect?v=1&device=<device-id>#secret=<pairing-secret>
```

`secret` 放在 URI fragment 中，避免浏览器或代理在普通 HTTP 请求中发送它。主设备粘贴后由扩展解析，并在 WebSocket 建连后的首个认证消息中使用。

### FR-6：连接管理

主设备控制界面支持：

- 输入连接 URL 添加设备。
- 自动握手并读取远端设备信息。
- 显示状态：`connecting`、`online`、`busy`、`offline`、`authFailed`、`incompatible`。
- 显示最近心跳时间和延迟。
- 手动连接、断开、重连、删除。
- 自动重连，使用带上限的指数退避。
- 扩展升级后通过协议版本协商检测兼容性。
- 不在日志或 UI 明文展示完整配对密钥。

### FR-7：Copilot Agent Tools

扩展在 Coordinator 侧贡献以下 Language Model Tools：

| Tool | 用途 |
| --- | --- |
| `mesh_list_workers` | 返回在线设备、能力标签、Workspace 和忙闲状态。 |
| `mesh_delegate_task` | 向指定设备和 Workspace 创建异步开发任务，Worker 接受后立即返回 `taskId`。 |
| `mesh_get_task` | 查询任务状态、阶段和已产生的结果。 |
| `mesh_cancel_task` | 取消远端任务。 |
| `mesh_answer_task` | 回答远端 Agent 的问题或审批请求。 |

`mesh_delegate_task` 的建议输入：

```ts
interface DelegateTaskInput {
  deviceId: string;
  workspaceId: string;
  title: string;
  prompt: string;
  acceptanceCriteria?: string[];
  timeoutMinutes?: number;
}
```

要求：

- Tool 的 `modelDescription` 明确告诉模型何时应委派远程任务。
- Tool 只选择目标设备与 Workspace，并传递主 Agent 给出的任务意图；不得添加 Git、分支或 worktree 操作策略。
- Tool 不检查 Workspace 的 Git 状态，也不因分支、HEAD、未提交修改或 worktree 状态阻止任务。
- 是否开始开发以及是否执行任何 Git 操作由远端内置 Agent 自主判断；扩展尤其不得提示 Agent 创建 Git worktree。
- Tool 执行前显示目标设备、Workspace 和任务摘要确认。
- Tool 支持 VS Code `CancellationToken`。
- 成功、失败、超时、离线必须返回不同的结构化结果。
- Tool API 是一次性结果；`mesh_delegate_task` 不等待完整任务，返回 `pending + taskId`，由 `mesh_get_task` 查询。
- Tool 调用取消或确认超时不等于远端任务取消；已接受任务继续由 Dashboard 和 `mesh_get_task` 管理。
- 远程输出过大时只返回摘要和引用，避免占满主 Agent 上下文。

### FR-8：Worker 任务执行

Worker 接收任务后：

1. 校验协议版本、任务 ID 和 Workspace。
2. 确保没有违反 Workspace 并发限制。
3. 连接或启动本地 VS Code Agent Host。
4. 通过 AHP Root State 动态发现 Copilot provider；不得永久硬编码 provider ID。
5. 在目标 Workspace 上创建 Session/Chat。
6. 发送任务 Prompt 并订阅 Chat、Tool、Terminal 和 Changeset 事件。
7. 持续更新任务状态。
8. 完成后生成结构化结果并回传 Coordinator。

任务开始前，扩展不得检查或修改 Git 状态、分支、HEAD 或 worktree，也不得把相关策略注入 Prompt。远端 Agent 根据任务、本地环境和自身能力自主决定是否开始开发及是否执行 Git 操作；如需用户决策，沿用任务输入与审批转发机制。

### FR-9：任务状态

任务状态机：

```text
created → accepted → startingAgent → running
                         ↘ needsInput ↗
running → completed | failed | cancelled | timedOut
```

- `taskId` 由 Coordinator 生成并保证幂等。
- Worker 重复收到相同 `taskId` 时返回已有任务，不重复执行。
- Worker 将任务最小状态持久化，扩展重启后可恢复展示。
- Tool 确认等待超时或取消不等同于远端任务失败；任务可继续运行并通过 `mesh_get_task` 查询。

### FR-10：任务结果

```ts
interface RemoteTaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timedOut';
  summary: string;
  deviceId: string;
  workspaceId: string;
  agentSessionUri?: string;
  validations?: Array<{
    command: string;
    success: boolean;
    summary?: string;
  }>;
  artifacts?: Array<{
    label: string;
    uri: string;
  }>;
  error?: {
    code: string;
    message: string;
  };
}
```

分支、worktree、Commit、Push 和 PR 不属于 Mesh 结构化协议字段。若远端 Agent 在结果中主动提供相关信息，扩展只把它作为普通摘要、输出或 Artifact 透传，不解析、不校验，也不据此控制后续任务。

### FR-11：跨仓库支持

- 一个 Worker 可以注册多个 Workspace；它们可以属于不同仓库，也可以不是 Git 仓库。
- Coordinator 可连接多个设备，并查看所有 Workspace。
- 每次任务只绑定一个目标 Workspace；跨仓库功能由主 Copilot Agent拆成多个任务。
- 插件不通过聊天消息复制整套源码。
- 插件协议不携带 Git 基线、目标分支、交付模式或 worktree 策略。
- 远端 Agent 根据用户任务和本地环境自主处理所有 Git 操作；插件不得要求或暗示 Agent 创建 worktree 或分支。

### FR-12：任务与连接控制界面

扩展贡献一个 Activity Bar 容器和 Webview View，建议布局：

```text
COPILOT AGENT MESH

This Device
  Name: mac-ios
  Platform: macOS arm64
  Listener: Running
  Tunnel: Connected
  [Copy Connection URL] [Stop]

Shared Workspaces
  ● iOS Client      ios
  ● Shared Client   cross-platform
  [+ Add Current Workspace]

Remote Devices
  ● linux-server    Online   42 ms   2 workspaces
  ○ win-client      Offline  last seen 15:32
  [+ Add Connection]

Tasks
  ▶ Implement login API      linux-server   Running
  ! Implement Face ID        mac-ios        Needs input
  ✓ Update Windows UI        win-client     Completed
```

控制界面至少支持：

- 配置本设备名称。
- 启停监听和 Tunnel。
- 复制连接 URL。
- 添加和管理远程连接。
- 展示设备状态、延迟、Workspace 和活动任务。
- 查看任务详情、进度、输出摘要、审批和错误。
- 取消任务。
- 打开对应 Agent Session 或 Agent 返回的文件与链接。

详细日志写入独立 `OutputChannel`，不把调试日志全部塞入 Webview。

## 8. 技术架构

```text
┌──────────────── Coordinator VS Code ────────────────┐
│ User → Built-in Copilot Agent                       │
│                 │ Language Model Tool               │
│                 ▼                                   │
│ ToolProvider → TaskCoordinator → PeerConnection     │
│                                      │ WSS          │
└──────────────────────────────────────┼──────────────┘
                                       │
                          Microsoft Dev Tunnels
                                       │
┌────────────────── Worker VS Code ────┼──────────────┐
│ GatewayServer ◀──────────────────────┘              │
│      │                                              │
│ TaskRunner → AgentHostAdapter → local AHP           │
│                                  │                  │
│                         VS Code Agent Host           │
│                                  │                  │
│                       Built-in Copilot Agent         │
│                                  │                  │
│                          Local Workspace             │
└─────────────────────────────────────────────────────┘
```

### 8.1 为什么增加 Gateway，而不是直接暴露 AHP

Worker Gateway 是必要的产品边界：

- 提供设备名称、能力和 Workspace 白名单。
- 隐藏本地 Agent Host connection token。
- 将外部协议与快速演进的 AHP 版本隔离。
- 提供任务 ID、幂等、状态持久化和审计。
- 防止 Coordinator 直接指定 Worker 任意绝对路径。
- 以后可以替换 Tunnel 实现而不改变 AgentHostAdapter。

### 8.2 Gateway 协议

采用 JSON-RPC 2.0 over WSS，协议版本从 `1` 开始。

建议方法：

```text
mesh.hello
mesh.ping
device.getInfo
workspace.list
task.start
task.get
task.cancel
task.answer
```

建议通知：

```text
task.stateChanged
task.progress
task.output
task.inputRequired
task.completed
connection.draining
```

所有消息必须包含 `requestId` 或 `taskId`，未知字段向前兼容忽略。

### 8.3 Agent Host/AHP 集成

Worker 使用 `code agent host` 启动专用本地 Agent Host：

```bash
code agent host \
  --new-instance \
  --foreground \
  --host 127.0.0.1 \
  --port 0 \
  --connection-token <random-token>
```

Worker 不解析 Agent Host stdout Readiness 文本。使用 Mesh-owned `user-data-dir` 启动后，通过以下命令读取并严格验证 Endpoint JSON：

```bash
code agent endpoints --user-data-dir <mesh-user-data-dir>
```

从启动前后 Endpoint 集合中唯一识别 Mesh-owned Standalone Endpoint，再使用其本地 WebSocket 地址和 Token 连接：

```text
ws://127.0.0.1:<port>?tkn=<connection-token>
```

之后使用 `@microsoft/agent-host-protocol`：

1. `initialize` 并订阅 `ahp-root://`。
2. 发现 Copilot Agent provider。
3. 在本机完成 Copilot/GitHub 身份认证并发送 AHP `authenticate`。
4. `createSession`，使用已注册 Workspace 的 `workingDirectories`。
5. 订阅 Session，应用 Snapshot 并等待 `session/ready`。
6. 从 Session State 获取并订阅默认 Chat。
7. 发送 `chat/turnStarted`。
8. 聚合 `chat/responsePart`、`chat/delta`、Tool Call、输入请求和 `chat/turnComplete`。
9. 将结构化结果映射为 Mesh Task Result。

发送给 Agent 的 Prompt 只包含主 Agent 提供的任务描述、验收条件和必要的传输上下文。扩展不得追加 Git 状态检查、分支管理、worktree、Commit、Push 或 PR 策略。

连接 URL、Agent Host token 和 GitHub token必须彼此隔离；GitHub/Copilot token不得发送给 Coordinator。

## 9. 技术选型

| 模块 | 推荐技术 |
| --- | --- |
| 扩展 | TypeScript + VS Code Extension API |
| 控制界面 | Webview View；React 可选，MVP 可使用轻量 TypeScript UI |
| 本地 Gateway | Node `http` + `ws`，仅绑定 `127.0.0.1` |
| 外部传输 | Microsoft Dev Tunnels，HTTP/WSS 转发 |
| Peer 协议 | JSON-RPC 2.0 over WSS |
| Agent 控制 | `@microsoft/agent-host-protocol` |
| 输入校验 | JSON Schema 或 Zod |
| 非敏感存储 | `ExtensionContext.globalState` |
| 密钥存储 | `ExtensionContext.secrets` / SecretStorage |
| 日志 | VS Code OutputChannel + 可选滚动文件日志 |
| Workspace 与 Git 操作 | 完全由远端内置 Agent 自主处理；扩展不检查、不控制，也不注入操作策略 |

建议目录结构：

```text
src/
  extension.ts
  ui/
    AgentMeshViewProvider.ts
  tunnel/
    DevTunnelCliManager.ts
  gateway/
    GatewayServer.ts
    GatewayProtocol.ts
  peer/
    PeerConnectionManager.ts
    ConnectionProfileStore.ts
  agentHost/
    AgentHostProcessManager.ts
    AhpAgentClient.ts
  tasks/
    TaskCoordinator.ts
    RemoteTaskRunner.ts
    TaskStore.ts
  tools/
    ListWorkersTool.ts
    DelegateTaskTool.ts
    GetTaskTool.ts
    CancelTaskTool.ts
  workspaces/
    WorkspaceRegistry.ts
  storage/
    SecretStore.ts
shared/
  protocol.ts
  schemas.ts
```

## 10. Dev Tunnels 技术调研结论

1. Dev Tunnels 支持 Windows、macOS、Linux。
2. Host 和 Client 都只需要向 Azure Relay 建立出站连接，不要求设备开放入站端口。
3. Web forwarding 原生支持 HTTP(S) 和 WS(S)，不安全连接会升级为 HTTPS/WSS。
4. 可以创建持久 Tunnel 并复用 Port，从而在资源仍存在时保持连接 URL；Persistent 不代表永久，Tunnel 和 Access 都可能过期。
5. 默认 Tunnel 私有；MVP 选择有限期 Port-scoped Anonymous Access + 插件配对凭据，以降低个人插件的登录和跨设备授权复杂度。
6. CLI 登录凭据缓存于系统安全钥匙串。
7. `devtunnel` CLI 和服务仍处于 Public Preview，无 SLA，命令和行为可能变化。
8. 官方 TypeScript SDK支持 Management、Client、Host 和重连；后续可替换 CLI 子进程方案。

MVP 采用 CLI 的原因：

- 跨平台安装方式成熟。
- 登录流程由 CLI 管理。
- 避免扩展自行实现 Microsoft/GitHub OAuth。
- 更快完成第一版验证。

需要通过 `DevTunnelProvider` 接口隔离实现，以便未来替换为以下 SDK：

- `@microsoft/dev-tunnels-management`
- `@microsoft/dev-tunnels-contracts`
- `@microsoft/dev-tunnels-connections`

## 11. VS Code 与 Copilot 技术调研结论

| 能力 | 结论 |
| --- | --- |
| 主 Agent 自动调用扩展能力 | Language Model Tool API 正式支持，但稳定 API 只有一次性 Result，没有持久 Tool Progress。 |
| 扩展自建 Chat Participant | 可行，但会变成自定义 Agent，不符合复用内置 Agent 的目标。 |
| 通过 Language Model API 直接调用模型 | 只能调用模型，不包含完整 Agent Loop。 |
| `workbench.action.chat.open` | 可做原型，但属于内部命令，不能稳定获取完整结构化结果。 |
| 控制内置 Copilot Agent | 通过 Agent Host/AHP 实现。 |
| 远程获取输出与工具状态 | AHP Chat、Tool、Terminal、Changeset channel 支持。 |
| 控制界面 | Webview View API适合设备和任务仪表板。 |

AHP 的 Root、Session、Chat 和 Terminal channel 在当前规范中标记为 Stable，但 VS Code Agent Host 本身仍在持续演进。实现必须使用协议版本协商与 capability detection，不依赖内部对象结构。

`mesh_delegate_task` 必须采用异步 `pending + taskId` 语义。扩展不能依赖长时间保持 Tool Invocation，也不能在旧 Copilot Turn 结束后主动追加结果。

## 12. 简化安全模型

本项目是个人插件，不设计企业级安全体系，但必须提供最低保护：

- Dev Tunnel 可匿名访问，但 Gateway 必须要求 256-bit 随机配对密钥。
- 配对密钥只显示一次，并存入 SecretStorage。
- Gateway 不接受未注册的 Workspace 路径。
- GitHub、Copilot 和 Agent Host token 永不离开 Worker。
- 控制界面提供“旋转密钥”和“撤销设备”操作。
- 日志必须脱敏连接 URL fragment、token 和 Authorization 信息。
- Worker UI 明确显示监听中和当前连接设备。
- 第一次远程写任务需要本机一次性授权；之后可配置为允许已配对设备。
- 默认转发远端 Agent 审批，不默认无条件批准危险操作。

此安全模型仅适用于个人、可信设备之间的开发使用，不宣称适用于企业或不可信网络环境。

## 13. 非功能需求

### 兼容性

- 支持 Windows x64/arm64、macOS x64/arm64、Linux x64；实际打包矩阵由依赖验证决定。
- 要求桌面版 VS Code。
- MVP 仅支持本机 `file:` Workspace；不支持 SSH、WSL、Dev Containers、Codespaces 或其他 VS Code Remote Workspace。
- 每台 Worker 均需要有效 Copilot 权限并完成登录。
- `devtunnel` 与 `code` CLI 路径可自动发现，也允许用户手动配置。

### 可用性

- 已登录情况下，启动监听至显示 URL 目标小于 10 秒。
- 在线设备心跳间隔建议 10 秒，30 秒无响应标记 Offline。
- 任务派发后 3 秒内返回 Accepted 或明确错误。
- 网络恢复后 30 秒内自动重连。

### 可靠性

- Tunnel、Gateway、AHP 三层状态分别展示，避免统一显示为模糊的“失败”。
- 所有任务具有持久 taskId。
- Peer 重连后可以重新查询尚未完成的任务。
- 扩展停用时不得遗留无主子进程。
- 错误不得伪装成成功结果。

### 可观察性

- 输出通道分别记录 Tunnel、Peer Protocol、AHP 和 Task 日志。
- 支持导出经过脱敏的诊断信息。
- UI 显示最近错误和建议处理方式。

## 14. 错误场景

必须覆盖：

- `devtunnel` 未安装。
- Dev Tunnel 用户未登录或凭据过期。
- Tunnel 创建、端口注册或 host 失败。
- 配对 URL 无效或协议版本不兼容。
- Worker 离线或 VS Code 已关闭。
- Workspace 被删除、未启用或本地路径不可访问。
- Copilot 未登录、无权限、配额不足。
- Agent Host 启动失败或 Provider 不存在。
- Agent 请求用户输入但 Coordinator 断线。
- 任务超时或被用户取消。
- 同一 Workspace 已有写任务。
- 扩展升级过程中协议不兼容。

每个错误必须有稳定错误码、用户可读说明和建议动作。

## 15. MVP 范围

### MVP 必须完成

1. 单一 VSIX 可安装在 Windows、macOS、Linux。
2. 配置设备名。
3. 注册当前 Workspace。
4. 启停本地 Gateway 和持久 Dev Tunnel。
5. 显示并复制连接 URL。
6. 主设备通过 URL 添加、保存和删除连接。
7. 连接状态、心跳和 Workspace 列表 UI。
8. `mesh_list_workers`、`mesh_delegate_task`、`mesh_get_task`、`mesh_cancel_task`。
9. Worker 通过 AHP 调用内置 Copilot Agent。
10. 主设备 UI 显示任务状态和输出摘要。
11. 任务完成结果可通过 `mesh_get_task` 在当前 Copilot 会话中查询。
12. 一台设备可注册多个 Workspace，但每个 Workspace 同时只执行一个任务。
13. 插件不检查或管理 Git 状态、分支和 worktree，也不向 Agent 注入相关操作要求。

### MVP 后续

- 多任务并行和任务队列优先级。
- 文件、截图和构建产物传输。
- 更完整的远程 Terminal/Changeset 展示。
- 直接使用 Dev Tunnels TypeScript SDK。
- 多主设备协同控制。
- 任务模板、设备能力自动匹配和历史统计。

## 16. 验收标准

### AC-1：监听与连接

- 在 Mac 或 Linux 点击启动监听后，UI 显示有效连接 URL。
- Windows 粘贴 URL 后，15 秒内看到设备 Online。
- 停止 Worker Tunnel 后，Coordinator 在 30 秒内显示 Offline。
- 重启 Worker 后，持久 Tunnel URL 不变且自动恢复连接。

### AC-2：Agent 委派

- 用户在 Windows Copilot Agent 要求执行 iOS 任务。
- Copilot Agent 可以调用 `mesh_delegate_task`。
- Mac 创建内置 Copilot Agent Session，在注册的 Workspace 中执行。
- 创建 Session 前，扩展不检查或修改 Git 状态、分支与 worktree，也不向 Agent 注入 Git 操作提示。
- Mac 的文本输出和状态可在 Windows 控制界面查看。
- `mesh_delegate_task` 先返回 `pending + taskId`；完成后 Windows Copilot Agent 可通过 `mesh_get_task` 取得结果并继续回复。

### AC-3：多平台与多仓库

- Coordinator 同时连接一个 macOS Worker 和一个 Linux Worker。
- macOS 和 Linux 分别暴露不同仓库 Workspace。
- 主 Agent 能向两个 Workspace 分别派发任务并正确关联结果。

### AC-4：失败与取消

- 目标设备离线时 Tool 返回明确的 `DEVICE_OFFLINE`。
- 目标 Workspace 忙时返回 `WORKSPACE_BUSY`。
- 用户取消任务后，远端 AHP Turn 被取消并返回 `cancelled`。
- 协议版本不匹配时连接状态显示 `incompatible`。

## 17. 开发阶段

### Phase 0：技术 Spike

必须先验证：

- VS Code 扩展中跨平台启动 `code agent host`。
- 使用 AHP TypeScript SDK创建 Copilot Session并得到 `turnComplete`。
- 使用 `vscode.authentication` 完成本机 AHP Copilot认证。
- `devtunnel host` 能稳定转发 Gateway WebSocket。
- `devtunnel show --json` 在目标平台能通过版本化 Decoder 唯一发现目标 Port 的 HTTPS URI。
- 一个 Language Model Tool 能创建异步任务并返回 `pending + taskId`，随后可通过另一个 Tool 查询结果。

### Phase 1：设备连接

- Workspace 注册。
- Gateway 协议。
- Dev Tunnel CLI 管理。
- 控制界面和连接状态。

### Phase 2：远程 Copilot 任务

- AgentHostProcessManager。
- AHP Session/Chat 适配。
- Task 状态、取消和结果聚合。

### Phase 3：Copilot Tools

- 注册四个核心 Language Model Tools。
- Tool 输入输出 Schema。
- 与控制界面任务列表联动。

### Phase 4：恢复与完善

- 自动重连、持久任务、审批转发。
- 三平台 E2E。
- 文档、诊断和 VSIX 打包。

## 18. 主要风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Dev Tunnels 仍是 Public Preview | CLI 或服务行为变化 | 封装 `DevTunnelProvider`；锁定最低版本；保留 SDK 替换路径。 |
| Agent Host持续演进 | AHP 集成可能随 VS Code 变化 | 使用正式 AHP SDK、版本协商和 capability detection。 |
| Language Model Tool 是一次性调用 | 不能持续推送远端任务进度或写回旧 Turn | Delegate 仅等待 accepted，立即返回 pending + taskId，并允许 `mesh_get_task` 查询。 |
| Worker 睡眠或 VS Code 关闭 | 远程任务中断 | 状态持久化、自动重连、明确 Offline；后续支持系统 keep-awake。 |
| 远端 Workspace 状态不适合执行任务 | Agent 可能无法开始或需要用户决策 | 由远端 Agent 自主判断并通过现有输入/审批通道反馈；扩展不做 Git 预检或策略注入。 |
| 远程执行风险 | 从设备文件或命令被误操作 | Workspace 白名单、任务确认、审批转发、可取消。 |
| CLI 路径差异 | macOS/Linux 找不到 `code` 或 `devtunnel` | 自动发现 + 配置项 + 明确安装指引。 |

## 19. 项目创建建议

项目初始化时建议采用：

- TypeScript VS Code Extension 模板。
- Desktop extension host，禁止声明为 Web Extension。
- Core 与 Webview UI 分包但保持单仓库。
- 协议类型放在 `shared/`，客户端和服务端共同使用。
- 首先实现 FakeAgentHost 与 InMemory Peer Transport，确保核心状态机可测试。
- E2E 测试再接真实 Dev Tunnel 和 Copilot，避免普通单元测试消耗模型额度。

第一批开发 Issue 建议：

1. Scaffold VS Code extension and Activity Bar view。
2. Implement device identity and workspace registry。
3. Implement local Gateway JSON-RPC server。
4. Implement Dev Tunnel CLI detection and lifecycle。
5. Implement connection URL generation and parsing。
6. Implement peer connection manager and heartbeat。
7. Implement Agent Host process manager。
8. Implement AHP Copilot session spike。
9. Implement remote task state machine。
10. Implement `mesh_list_workers` and `mesh_delegate_task` tools。
11. Implement task dashboard and cancellation。
12. Add Windows/macOS/Linux integration tests。

## 20. 调研资料

- [Microsoft Dev Tunnels Overview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview)
- [Dev Tunnels CLI Reference](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)
- [Create and Host a Dev Tunnel](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
- [Dev Tunnels Security](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security)
- [Microsoft Dev Tunnels SDK](https://github.com/microsoft/dev-tunnels)
- [VS Code Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Agent Host Architecture](https://code.visualstudio.com/docs/agents/concepts/agent-host)
- [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/)
- [Agent Host Protocol GitHub Repository](https://github.com/microsoft/agent-host-protocol)

## 21. 最终产品定义

Copilot Agent Mesh 是一个个人使用的 VS Code 多设备 Agent 桥接扩展。它通过 Microsoft Dev Tunnels 连接 Windows、macOS 和 Linux 设备，通过标准 Language Model Tools 接收主 Copilot Agent 的委派，并通过本机 Agent Host/AHP 驱动远端设备上的内置 Copilot Agent。用户在一个 VS Code 中即可发起、观察和管理跨平台、跨仓库的开发任务，并将远端结果自动带回原始 Copilot Agent 会话。
