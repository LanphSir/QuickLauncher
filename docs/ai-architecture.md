# AI 应用与插件 AI 协议（设计稿 + 实现校正）

> 状态：v0.6.0 → v0.6.4 全部落地。
> 决策日期 2026-11-02。本文回答三个问题：**放在哪、怎么调、出问题谁负责**。
> 第 2、4–6 节已按实际实现校正过（与设计稿不一致处均已标注原因）；
> 版本与验收见 [ROADMAP.md](ROADMAP.md)；每版交付后补 [DEVLOG.md](DEVLOG.md)。

## 0. 结论与已定决策

| 决策点 | 结论 | 一句话理由 |
|---|---|---|
| AI 界面 | 内置插件 `plugins/ai`（Vue + Vite，与 handbook 同构） | 复用加载/图标/快捷键/权限；UI 迭代不动核心；AI 自己是新协议的第一个用户 |
| AI 服务 | 主进程 `src/main/ai/*` | 密钥不进插件页；SSE 流式必须主进程；工具循环要跨插件、跨 MCP 统一调度 |
| 协议升级 | 纯增量（`apiVersion: 2` + 可选字段 + 新通道） | 现有 5 个插件零改动，v0.4.x 热修不受阻 |
| 工具执行 | 主进程 → 插件页 IPC（`callId` + 独立超时 + 取消） | 插件是纯网页、没有 Node 侧代码，这是唯一路径 |
| 授权 | 按 `risk` 分级（read 放行 / write 确认 / dangerous 每次确认）+ 审计 | 模型会被工具返回的内容骗，工具是实际伤害面 |
| MCP | v0.6.4 才做 | 先跑通进程内工具循环，RCE 面单独隔离 |

**非目标**（明确不做，避免范围失控）：图/视频生成、向量库 RAG、计费、跨设备同步、
自主长任务（v0.6 只做"单会话多轮工具调用"，不做后台无人工 Agent）。

## 1. 分层与职责

```
渲染层（面板）
  └─ plugins/ai  ← AI 对话界面（WebContentsView，plugin://com.launcher.ai）
        │  window.appapi.ai.*（契约通道）+ 主进程推送的事件流
主进程
  ├─ src/main/ai/*        会话、流式、工具循环、密钥、审计
  ├─ 工具注册表           内置工具 / 插件工具 / MCP 工具
  └─ plugin/gateway.ts    既有身份+权限+入参校验（不改结构）
外部
  ├─ 模型端点             OpenAI 兼容（DeepSeek / 通义 / Kimi / Ollama / LM Studio / 官方）
  └─ 插件页 / MCP 进程    真正执行工具的一方
```

三条边界不要含糊：

1. **插件页永远不碰密钥**：它只知道"当前模型名"，`apiKey` 只在主进程内存与
   `safeStorage` 密文里出现；设置页只显示末 4 位掩码。
2. **AI 服务不直接操作插件 DOM**：要插件做事一律走契约通道，与用户手动触发同一条路径。
3. **网关不认 AI**：`gateway.ts` 只加一个"内部通道"判定，不认识任何 `ai.*` 语义；
   具体能力全在 `plugin/api/ai.ts` 里。

## 2. 目录与文件规划（按 v0.6.3 实际落地）

```
src/main/ai/
  index.ts         initAi()：注册 panel:ai-* 通道、装配工具注册表、启动时迁移旧配置
  provider.ts      provider 预设与解析（baseURL/apiKey/model/headers/params），buildChatRequest
  client.ts        SSE 流式请求、分片回调、中止
  sse.ts           增量解析器（半包/多行 data/注释行）
  chunk.ts         OpenAI delta 归一化（含 delta.tool_calls → ToolCallDelta）
  secrets.ts       safeStorage 加解密的密钥存取（userData/ai/secrets.bin）
  store.ts         会话持久化（userData/ai/sessions/<id>.json + index.json）
  sessionModel.ts  会话 → ChatTurn 的转换（工具调用/结果成对带出、失败措辞）
  tokens.ts        token 估算、预算、fitTurns 截断
  summary.ts       长对话摘要（触发条件 + keptStart 计算）
  chat.ts          流式对话主循环（工具轮次、AbortController、事件出口）
  audit.ts         工具调用审计（userData/ai/audit.jsonl，2MB 轮转）
  toolsSpec.ts     ai/tools.json 解析 + ajv 校验器（坏一项只丢一项）
  tools.ts         grantedToolList()：按授权/启用状态现算下发给模型的工具
  toolNames.ts     全局名 ↔ API 名互转（[A-Za-z0-9_-]{1,64}，超长用 FNV-1a 短哈希）
  toolCatalog.ts   合并内置 + 插件工具，排序、防撞名、byApiName 反查
  builtinTools.ts  7 个内置工具：launcher_search/open、clipboard_read/write、docs_search/read、skill_read
  toolExec.ts      统一执行流水：校验 → 确认 → 执行 → 审计 → 出错折成 tool-result.error
  confirm.ts       风险分级、会话级放行、确认等待与超时、cancelConfirms
  toolCalls.ts     ToolCallCollector：按 index 归并流式 tool_calls 分片
  toolHost.ts      把调用送进插件页并等回执（懒建、10s 就绪、空闲 60s 回收、崩溃重试一次）
  attach.ts / extract.ts / pdf.ts   附件抽取与编码回退
  settings.ts      AI 设置（模型、授权开关、确认模式）
  mcpSpec.ts       ai/mcp.json 解析、命令指纹、MCP 工具命名与风险推断
  mcpClient.ts     最小 stdio JSON-RPC 客户端（initialize / tools/list / tools/call）
  mcpManager.ts    审批状态、懒启动、崩溃计数、工具清单、退出收尸
plugins/ai/        AI 对话界面（独立 vite 工程，自带样式，不引 naive-ui）
```

设计稿原计划拆成 `tools/` 子目录（registry/builtin/pluginTools/toolHost），
实际落在 `ai/` 平铺——这些文件都只服务 AI 主循环，多一层目录只增加 import 噪音。

核心渲染层只改四处：设置页新增「AI」分组、`AppTile`/`AppManage` 的 AI 徽标、
`PluginDetail` 的能力展示、`env.d.ts` 的 `window.panel.ai*` 类型。

## 3. 数据模型

```ts
// userData/ai/config.json —— 不含任何密钥明文
interface AiConfig {
  providers: AiProvider[]        // 可多份，OpenAI 兼容为主
  defaultModel: string           // "providerId/model"
  tools: {
    confirmMode: 'risk' | 'always' | 'never'
    enabledPluginIds: string[]   // 逐插件开关，默认空 = 全部关闭
    maxRounds: number            // 工具循环上限，默认 6
    maxTools: number             // 下发给模型的工具数上限，默认 32
  }
  attachments: { maxFileBytes: number; maxTotalBytes: number; maxTextChars: number }
}

interface AiProvider {
  id: string; name: string
  kind: 'openai-compatible'      // v0.6 只做这一种，其余等真实需求
  baseURL: string
  apiKeyRef: string              // 指向 secrets.bin 的键名，不是密钥本身
  apiKeyHint: string             // "sk-…a1b2"，仅用于界面回显
  models: string[]
  headers?: Record<string, string>
  params?: { temperature?: number; topP?: number; maxTokens?: number }
}

// 会话：一个文件一个会话，避免像旧版 store.json 那样每次写全量
interface AiSession { id, title, createdAt, updatedAt, modelId, usage: { input, output }, messages: AiMessage[] }
interface AiMessage { id, role: 'user' | 'assistant' | 'tool', parts: Part[], createdAt, error?: string }
type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'attachment'; name: string; kind: 'text' | 'image'; bytes: number; preview: string }
  | { type: 'tool-call'; callId: string; name: string; args: unknown; risk: ToolRisk; source: string }
  | { type: 'tool-result'; callId: string; ok: boolean; result?: string; error?: string; ms: number }
```

上限：单会话 200 条消息 / 8MB；超限在 v0.6.1 做滚动摘要（把前 N 条压成一段
"历史摘要"存进 `session.summary`，原消息落 `truncated.jsonl` 便于回溯）。

## 4. 插件协议扩展（纯增量）

### 4.1 manifest

```json
{
  "apiVersion": 2,
  "features": ["inline", "ai"],
  "permissions": ["ai"],
  "ai": { "tools": "ai/tools.json", "skill": "ai/SKILL.md", "mcp": "ai/mcp.json" },
  "window": { "width": 1040, "height": 740 }
}
```

- `apiVersion` 缺省视为 1；`2` 只是"认识新字段"的声明，不影响加载。
- `features: ["ai"]` = 参与 AI 能力（功能声明，与 inline 同级）；
  `permissions: ["ai"]` = 允许被 AI 调用（权限，缺失即拒绝执行）。
- `window` 是建议尺寸（与 `hotkey` 同类：提示性、不强制），插件页默认 980×720。
- 校验规则：`ai.tools` / `ai.skill` / `ai.mcp` 必须是插件目录内的相对路径且存在，
  **不存在只丢该子能力**（与 `hosts` / `features` 的"坏一项丢一项"一致），不整插件拒载。

### 4.2 `ai/tools.json`

```json
{
  "version": 1,
  "tools": [
    {
      "name": "translate_text",
      "title": "翻译文本",
      "description": "把文本翻译为目标语言，返回译文。适合短段落。",
      "risk": "read",
      "timeoutMs": 8000,
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" }, "target": { "type": "string" } },
        "required": ["text"]
      }
    }
  ]
}
```

- 工具名在插件内唯一，全局命名空间为 `plugin:<pluginId>:<name>`，模型看到的是短名 +
  插件名，避免多个插件都叫 `search` 时打架。
- `parameters` 用 JSON Schema（`ajv` 校验），模型给的参数必须先过硬校验再执行。
- `risk`：`read`（只读信息）自动放行；`write`（改用户数据/发外部请求）需确认；
  `dangerous`（执行命令、删文件、发消息）每次确认，且不允许被"总是允许"记住。

### 4.3 `ai/SKILL.md` —— 渐进披露

```markdown
---
name: 翻译
description: 中英互译、术语对照；用户提到翻译/英文/多语言时使用
---
（这里写详细用法、示例、注意事项，全文只在需要时才读）
```

工具列表里只放 `name + description`（几十个插件也只占几百 token）；
模型需要细节时调内置工具 `load_skill(pluginId)` 拉全文。
**不要**把 SKILL.md 直接拼进 system prompt——多插件时上下文会被文档挤满。

### 4.4 `ai/mcp.json`（v0.6.4，已落地）

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/notes"],
      "env": { "LOG_LEVEL": "error" },
      "cwd": "tools",
      "timeoutMs": 30000
    }
  ]
}
```

也接受裸数组。字段：`name`（小写字母开头，`a-z0-9_-`，≤32，用于工具命名空间）、
`command`（必填）、`args`（字符串数组，≤32 项、单项 ≤512 字符）、`env`（≤32 项，
键名合法即可，值里可以放 token——设置页**只显示键名**）、`cwd`（插件目录内的相对路径，
`..`/绝对路径一律拒）、`timeoutMs`（缺省 30s，夹在 1–120s）。坏一条丢一条。

插件自带 MCP 声明等于「让启动器执行任意命令」，因此：

1. **默认一条都不执行**。`state: pending`，设置页列出完整 argv，用户逐条点允许。
2. **确认绑定到指纹**（`command+args+env+cwd` 的 sha256/32 位，落 `config.aiMcpApprovals`）。
   改了参数 → `stale` → 必须重新确认。只存布尔等于「允许这个插件以后执行任何命令」。
3. **不经 shell**：`spawn(cmd, args, {shell:false})`，参数里的 `;`/`&&` 只是普通字符。
   `env` 与 `process.env` **合并**（`npx`/`node` 靠 PATH 找到）。
4. **插件级授权同样生效**：命令批了但插件在「AI 工具」里被关掉，工具仍不下发；
   批准命令时顺手打开该插件开关，避免用户在两处各开一次。
5. **进程可控**：懒启动（批准时建连 + 每次对话前 3s 预算补齐）、连续失败 3 次本会话停用、
   退出时 `taskkill /T /F` 收整棵进程树。

实现选择：**自写最小 stdio 客户端**（`mcpClient.ts`），不引官方 SDK——只用
`initialize`/`tools/list`/`tools/call`，而崩溃计数、stderr 归因、杀进程树这些恰恰是
SDK 藏起来的部分。代价是不支持 resources/prompts/sampling，http 传输也未做。

### 4.5 新通道与权限

> 下表为**实际落地**的通道（v0.6.3 收尾时按代码校正；设计稿原来的 `toolResult` /
> `toolStatus` / `toolCall` 三个名字改成了下面的点分命名）。

| 通道 | 方向 | 用途 | 权限 |
|---|---|---|---|
| `plugin:ai.tools` | 设置页 → 主进程 | 列出识别到的工具（含被丢弃项的原因） | — |
| `plugin:ai.tool.reply` | 插件 → 主进程 | 回 `{callId, ok, result\|error}`，`jsonValue` 上限 64KB | `ai` |
| `plugin:ai.tool.confirm` | AI 页 → 主进程 | 回答确认框 `{requestId, allow, remember}`（`internalOnly`） | `ai` |
| `plugin:ai.chat.send` | AI 插件 → 主进程 | 发消息（`internalOnly`） | `ai` |
| `plugin:ai.chat.stop` | AI 插件 → 主进程 | 中断当前生成（`internalOnly`） | `ai` |
| `plugin:ai.session.*` | AI 插件 → 主进程 | 列表/读取/改名/删除（`internalOnly`） | `ai` |
| `plugin:ai.tool-call`（事件） | 主进程 → 插件页 | `{callId, name, args}`，`AI_TOOL_CALL_CHANNEL` | — |
| `plugin:ai.delta`（事件） | 主进程 → AI 页 | `{messageId, seq, kind, …}` | — |

没有单独的「就绪上报」通道：就绪由宿主侧判定——`warmPluginContents()` 拿到视图后
轮询 `wc.isLoading()`（预算 `TOOL_HOST_READY_MS`=10s），加载完就发；
插件不需要主动报活，也不该假设自己是常驻的。

**`internalOnly`**：网关新增一个布尔判定（3 行），只有 `source === 'builtin'` 且
`manifest.id === 'com.launcher.ai'` 的调用方能过。理由：模型调用是花用户的钱，
不能让任何第三方插件偷偷发起对话。

事件流复用 `plugin:inline-query` 那套（`wc.send` + preload 缓冲 + seq 丢弃过期），
`kind` 取值：`text` / `reasoning` / `tool-call` / `tool-result` / `tool-confirm` /
`tool-confirm-close` / `usage` / `done` / `error`。

> `onDelta` 踩过的坑：contextBridge 传过来的回调在两侧是不同函数对象，
> `offDelta(cb)` 按引用删不掉（`ipcRenderer.off` 永远匹配不上）。已改为
> **多订阅者集合 + 返回退订闭包**，否则「后来者顶掉前者」会让 AI 页收不到确认事件。

## 5. 工具调用时序

实际实现（`main/ai/chat.ts` → `toolExec.ts` → `toolHost.ts`）：

```
模型流式返回 delta.tool_calls（按 index 分片）
  → ToolCallCollector 归并（id 只取首帧，无 name 的槽丢弃）
  → 名字反查：api 名（[A-Za-z0-9_-]{1,64}）→ fullName，如
     plugin_com_launcher_calculator_calculate → plugin:com.launcher.calculator:calculate
  → executeToolCall()：
      a. 参数 JSON.parse 失败 → 直接回 error，不执行
      b. ajv 校验 parameters → 失败回 error，不执行
      c. needsConfirm(risk)：read 直通；write 查会话放行；dangerous 必问
      d. askConfirm()：主进程推 tool-confirm 给 AI 页 → 等 tool.confirm 回执
         （TOOL_CONFIRM_TIMEOUT_MS=60s，超时按 denied；取消对话即全部 cancelConfirms）
      e. 执行（超时统一取 tool.timeoutMs，缺省 8s、夹在 1–60s；MCP 缺省 30s、1–120s）
         builtin：主进程内直调，withTimeout(timeoutMs)
         plugin ：toolHost → warmPluginContents → waitReady(10s)
                  → send 'plugin:ai.tool-call' → 等 'plugin:ai.tool.reply'
                  → 崩溃/被回收 retryable 重建重试一次
         mcp    ：mcpManager.callMcpTool → 进程不在就先重连一次（记一次失败）
                  → stdio JSON-RPC 'tools/call'（新行分帧，客户端自己计时）
      f. writeAudit()：无论成功/失败/被拒都写一行，source 区分 builtin/plugin/mcp
  → 结果归一化：单条 ≤4000 字（MAX_TOOL_RESULT_CHARS），preload 侧先按 16000 字截
  → 回填 role:'tool' 消息 → 继续循环
     （MAX_TOOL_ROUNDS=4 轮 / MAX_TOOL_CALLS=8 次，超限补「未执行」结果再收尾）
```

失败路径必须显式，不许静默：`插件未就绪`、`工具超时`、`插件返回错误`、`用户拒绝`
四种都作为 `tool-result.error` 回给模型，让模型自己决定换个办法。

**成对约束**：`assistant.tool_calls` 与 `role:'tool'` 必须一一对应，否则下一次请求
会被端点 400。所以触上限、用户停止、请求失败这三种收尾路径都要先把「未执行」结果补上
再发请求。只调工具不说话的 assistant 消息用 `content: null`（空串同样会 400）。

**工具宿主（toolHost）**：插件工具执行需要页面在场。设计稿原打算单独建一组隐藏
webContents，实际实现改为**复用 `pluginHost` 的视图**（`warmPluginContents`）——
同一插件双实例会踩存储与生命周期，代价是占 LRU 里的名额（上限 5）。
用完空闲 60s 回收（用户正开着该插件则不动），崩溃重建一次再失败就如实回报。

## 6. 安全模型

| 面 | 措施（v0.6.4 实际实现） |
|---|---|
| API Key | `safeStorage.encryptString` 密文落盘；渲染层/插件层只拿掩码；日志与审计里脱敏 |
| 工具越权 | 四重门：manifest `permissions:["ai"]` + `ai.tools` 声明有效 + 设置页开关（默认全体关闭）+ 每次下发现算授权（撤销立即生效） |
| 用户确认 | 确认框渲染在 **AI 页内**（插件页是原生 `WebContentsView`，会盖住 `OverlayHost`）；默认焦点在「拒绝」、Esc 拒绝；`dangerous` 不给「本次会话不再询问」；60s 超时按拒绝 |
| 提示注入 | 工具返回内容一律作为 `role:'tool'` 的 data 消息回填，不拼进 system；`shell.openExternal`、写入类归 `dangerous`；绝不执行模型给出的原样命令 |
| 名字伪造 | 模型只能用 api 名（`[A-Za-z0-9_-]{1,64}`），主进程用 `byApiName` 反查真实工具；反查不到的调用直接失败，不接受模型自己拼的 `plugin:` 名 |
| 回执伪造 | `toolHost` 用 `getCaller(sender)` 核对回执来源必须等于目标插件，且 `callId` 必须在 pending 里；迟到的回执按 callId 找不到等待者即丢弃（不能污染下一轮） |
| MCP | 命令 argv 人工确认 + **指纹绑定**（改任一字符即失效）；`spawn(shell:false)` 不经 shell；`env` 与 `process.env` 合并而非替换；`cwd` 限制在插件目录内；stdout/stderr 各留 64KB 尾部；连续 3 次失败本会话停用；退出时 `taskkill /T` 收进程树 |
| 成本 | 会话级 token 预算 + 用量显示；单轮 `MAX_TOOL_ROUNDS=4` / `MAX_TOOL_CALLS=8`；工具结果截断到 4000 字（长结果最容易烧 token）；MCP 工具数量随 server 走，单个插件最多 5 个 server |
| 审计 | `userData/ai/audit.jsonl` 每次调用一行：时间、会话、来源、工具、参数摘要、结果摘要、耗时、`confirm`（`allowed`/`denied`/`timeout`/`not-required`）；2MB 轮转 |
| 数据 | 会话与审计都在 `userData/ai/`，与插件 `data/<pluginId>/` 平级、互不可见 |

## 7. 与现有代码的接缝

| 文件 | 改动 |
|---|---|
| `src/shared/pluginApi.ts` | 新权限 `ai`、新 feature `ai`、`ai.*` 通道 + 类型、`PluginApiSurface.ai` |
| `src/main/plugin/api/define.ts` | `internalOnly?: boolean` |
| `src/main/plugin/gateway.ts` | 身份校验里加 internalOnly 判定（约 3 行，仍不认识通道名） |
| `src/main/plugin/api/ai.ts`（新） | chat/session/toolResult/toolStatus 的实现与入参校验 |
| `src/main/plugin/manager.ts` | manifest 校验 `apiVersion` / `ai` 段 / `window`；`PluginRecord.ai` 元信息 |
| `src/main/index.ts` | `initAi()`、`panel:ai-*`（模型配置、授权、MCP）通道、`getPlugins` 下发 `ai` 字段 |
| `src/preload/plugin.ts` | 暴露 `appapi.ai.*` 与 `appapi.onAiDelta` |
| `src/renderer/src/components/{AppTile,AppManage,PluginDetail}.vue` | AI 徽标（右上角常显，pin 悬停时让位）与能力展示 |
| `src/renderer/src/components/SettingsView.vue` | 新增「AI」分组（模型 / 工具授权 / MCP / 用量） |
| `tests/*` + `scripts/smoke.mjs` | 工具计划纯函数、协议解析、授权拒绝、流式中断的断言 |

## 8. 未决与观察项

1. **流式 IPC 的粒度**：先按 chunk 直发（每 token 一次 `send`），若 profile 显示占比可观
   再改 `MessageChannelMain` 传 port；不预先优化。
2. **推理型模型**（DeepSeek-R1 等）的 `reasoning` 字段形态各家不同，v0.6.0 先做"有就展示、
   没有就空着"，不做结构归一。
3. **工具结果长文**：截断策略（16KB/4000 字）可能会切掉关键行，观察真实使用后再决定
   是否加"分段读取"工具。
4. **多插件工具重名**：命名空间解决调用歧义，但模型看到的短名仍可能混淆，考虑在
   描述前缀插件名（等有 5 个以上插件工具再定）。
5. **跨平台**：Windows 优先；macOS 的 MCP stdio 路径与托盘行为留到 v0.7 盘点。
6. **MCP 首次启动慢**：`npx -y` 要下载依赖，20s 建连预算可能不够。真接入社区 server
   后按实际耗时决定：是放宽预算、还是把「安装」与「建连」拆成两步（先预热再对话）。
7. **MCP 停用后无法恢复**：连续 3 次失败 → 本会话禁用，只能重启应用。等有人真的踩到
   再加「设置页重新启用」按钮。
8. **MCP 进程常驻**：批准后进程活到应用退出，没有空闲回收。重启成本（可能几十秒）
   比省下的内存贵，暂定如此；如果用户装了多个重型 server 再考虑按空闲回收。
