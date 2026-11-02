/**
 * AI 能力的线上契约：主进程、AI 插件页、设置页共用同一份定义。
 *
 * 与 shared/pluginApi.ts 的分工：
 * - pluginApi 定义「通道怎么走」（通道名、权限、入参/返回值类型）；
 * - 本文件定义「AI 数据长什么样」（消息、会话、模型、流式事件）。
 *
 * 本文件必须保持"纯数据与类型"：不 import electron / node，插件页能安全引用。
 */

/** 消息角色。system 只由主进程拼（用户看不到它，也不占会话消息） */
export type AiRole = 'user' | 'assistant' | 'system'

/** 正文；推理型模型（deepseek-reasoner 等）的思维链走 reasoning 另存 */
export interface AiTextPart {
  type: 'text'
  text: string
}

export interface AiReasoningPart {
  type: 'reasoning'
  text: string
}

/** 附件种类：图片走视觉通道，文本走抽取后拼进上下文 */
export type AiFileKind = 'image' | 'text'

/**
 * 一条附件。
 *
 * 图片只在磁盘上存一份（`userData/ai/files/<fileId>`），消息里留 `preview` 缩略图，
 * 否则一张 4MB 的图 base64 进会话文件就是 5MB，几十条就把会话拖成几兆。
 */
export interface AiFilePart {
  type: 'file'
  kind: AiFileKind
  name: string
  mime: string
  /** 原始字节数，界面显示用 */
  size: number
  /** 图片在 files 目录下的文件名；文本附件为空 */
  fileId?: string
  /** 图片缩略图（data URL），仅界面展示，不参与请求 */
  preview?: string
  /** 文本附件抽取出的正文（已按上限截断） */
  text?: string
  /** 正文被截断前的字符数，用于界面提示"已截断" */
  fullLength?: number
  /**
   * 抽取失败原因。有它时该附件不参与请求，界面上要给红字——
   * 静默跳过会让用户以为模型看过这个文件了。
   */
  error?: string
}

/**
 * 一次工具调用（v0.6.3）。
 *
 * `name` 是给界面看的可读名（`计算器 · 计算表达式`），`apiName` 是真正发给模型、
 * 也真正回传执行的那个函数名。为什么两者分开：OpenAI 的函数名只允许
 * `[A-Za-z0-9_-]{1,64}`，而插件工具的全局名是 `plugin:<id>:<name>`（带冒号与点），
 * 直接下发会被端点拒绝。改名只发生在「模型这一侧」，授权与执行仍按 fullName 反查。
 */
export interface AiToolCallPart {
  type: 'tool_call'
  /** 模型给的调用 id，工具结果要靠它配对 */
  callId: string
  /** 下发给模型的函数名（已合法化） */
  apiName: string
  /** 全局工具名，如 `plugin:com.launcher.calculator:calculate` 或 `launcher.search` */
  fullName: string
  /** 界面上的短标题 */
  title: string
  /** 参数原文（JSON 字符串，已截断） */
  args: string
  risk: AiToolRisk
  pluginId?: string
  pluginName?: string
}

/** 工具执行结果。ok=false 时 error 里是给模型看的原因，它据此决定重试还是换路 */
export interface AiToolResultPart {
  type: 'tool_result'
  callId: string
  ok: boolean
  /** 成功时的文本结果（已按上限截断） */
  text: string
  /** 失败原因（超时/被拒/插件报错/参数不合法） */
  error?: string
  durationMs?: number
}

export type AiMessagePart =
  | AiTextPart
  | AiReasoningPart
  | AiFilePart
  | AiToolCallPart
  | AiToolResultPart

export interface AiChatMessage {
  id: string
  role: AiRole
  /** 顺序即展示顺序；reasoning 不参与请求，只用于回看 */
  parts: AiMessagePart[]
  createdAt: number
  /** 生成这条回答用的模型（`providerId/model`），便于事后分辨 */
  model?: string
  /** 用户中途停止：内容保留、界面显示「已停止」，不是失败 */
  stopped?: boolean
  /** 请求失败的原因（有它时界面显示重试，而不是当成空回答） */
  error?: string
}

export interface AiSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 上次使用的模型；会话内可随时切换 */
  model?: string
}

export interface AiSessionDetail extends AiSessionMeta {
  messages: AiChatMessage[]
  /**
   * 早期对话的滚动摘要：历史超出上下文预算时生成，下轮请求作为额外 system 注入。
   * 只覆盖 `summaryUpTo` 之前的消息，之后的部分仍然原样带上。
   */
  summary?: string
  /** 摘要覆盖到哪条消息（该 id 及之前，不含之后） */
  summaryUpTo?: string
}

/** 模型条目：id 是 "providerId/model"，全程用它定位，避免模型重名 */
export interface AiModelOption {
  id: string
  providerId: string
  providerName: string
  model: string
  /** 本地/免密钥端点（Ollama、LM Studio）：不需要 apiKey */
  keyless: boolean
}

/** provider 的只读视图：永远不含 apiKey 明文，只有掩码与"是否已配" */
export interface AiProviderView {
  id: string
  presetId: string
  name: string
  baseURL: string
  models: string[]
  hasKey: boolean
  /** 形如 `sk-…a1b2`；没配时为空串 */
  apiKeyHint: string
  keyless: boolean
  contextWindow: number
  visionModels: string[]
}

export interface AiPreset {
  id: string
  name: string
  /** API 根地址，要写到 /v1 这一级 */
  baseURL: string
  /** 只是填表建议，用户可改 */
  models: string[]
  keyless: boolean
  hint?: string
  /** 该端点常见的上下文窗口，作为表单默认值 */
  contextWindow?: number
  /** 能读图的模型名（子串匹配），空表示不支持图片 */
  visionModels?: string[]
}

export interface AiSettingsView {
  providers: AiProviderView[]
  /** "providerId/model"；空串表示还没配 */
  defaultModel: string
  presets: AiPreset[]
}

/** 主进程内保存的 provider 配置（含密钥引用，不含密钥本身） */
export interface AiProviderConfig {
  id: string
  presetId: string
  name: string
  baseURL: string
  models: string[]
  /** secrets.bin 里的键名；keyless 时为空串 */
  apiKeyRef: string
  keyless: boolean
  /**
   * 上下文窗口（token）。OpenAI 兼容端点没有统一的查询接口，
   * 只能由用户填或按预设兜底——填小了会白白截断，填大了服务端照样 400。
   */
  contextWindow?: number
  /** 该 provider 下能读图的模型（子串匹配模型名）；空表示都不支持 */
  visionModels?: string[]
}

/** 主进程内保存的整体配置 */
export interface AiConfig {
  providers: AiProviderConfig[]
  defaultModel: string
  /** 会话上限，超过后按最旧删除 */
  maxSessions: number
  systemPrompt: string
  /** 未填 contextWindow 的 provider 用这个值 */
  defaultContextWindow: number
}

/**
 * 流式事件：主进程推给 AI 插件页。
 * 用 seq 单调递增，渲染层按它拼接——本地 IPC 不丢包，seq 主要用来丢弃重启前的旧流。
 */
export type AiStreamEvent =
  | { type: 'start'; sessionId: string; messageId: string; model: string }
  | { type: 'text'; sessionId: string; messageId: string; delta: string }
  | { type: 'reasoning'; sessionId: string; messageId: string; delta: string }
  | { type: 'usage'; sessionId: string; messageId: string; input: number; output: number }
  | {
      type: 'done'
      sessionId: string
      messageId: string
      stopped?: boolean
      error?: string
      /** 这次请求丢掉了多少条早期消息（超预算时 > 0） */
      dropped?: number
      /** 最后一条被截断（附件或正文过长） */
      truncated?: boolean
    }
  /**
   * 模型决定调用工具（已通过参数校验，等待执行）。
   * 界面据此插入一行「正在调用 X」——用户必须看得见"它现在在动你的东西"。
   */
  | { type: 'tool-call'; sessionId: string; messageId: string; call: AiToolCallPart }
  /** 工具执行结束（成功或失败都发） */
  | { type: 'tool-result'; sessionId: string; messageId: string; result: AiToolResultPart }
  /** 需要用户确认才能继续：界面必须弹出确认框，没回应就按超时拒绝处理 */
  | { type: 'tool-confirm'; sessionId: string; messageId: string; request: AiConfirmRequest }
  /** 确认框已关闭（超时/被同一请求的其他动作收尾），界面据此收起 */
  | { type: 'tool-confirm-close'; sessionId: string; messageId: string; requestId: string }
  /** 后台生成完滚动摘要：界面据此提示"更早的对话已压缩" */
  | { type: 'summary'; sessionId: string; text: string }

/** 风险确认请求：主进程 → AI 插件页 */
export interface AiConfirmRequest {
  requestId: string
  /** 全局工具名，界面用于展示"哪个插件的哪个工具" */
  fullName: string
  title: string
  pluginName?: string
  risk: AiToolRisk
  /** 参数原文（已截断），用户要能看清"它到底要传什么进去" */
  args: string
  /** 多久没有回应就按拒绝处理 */
  timeoutMs: number
  /** 该工具本次会话内已被放行过：界面可提示"这次不再问" */
  rememberable: boolean
}

/** 发一条消息：sessionId 缺省表示新建会话 */
export interface AiSendRequest {
  sessionId?: string
  text: string
  /** 覆盖会话默认模型；空则用 defaultModel */
  model?: string
  /**
   * 待发附件（主进程暂存表的 id）。不直接传解析结果，是为了让
   * 「附件长什么样」只由主进程决定，插件页无法伪造一条文本塞进上下文。
   */
  attachIds?: string[]
}

/** 附件在哪一刻被主进程接收，返回给插件页展示 */
export interface AiAttachResult {
  ok: boolean
  /** 暂存表 id，发送时回传 */
  attachId?: string
  part?: AiFilePart
  message?: string
}

/**
 * 拖拽进来的文件：渲染层只能拿到 File 对象，读成字节后以 base64 过 IPC。
 * 不用 ArrayBuffer 直传是因为 contextBridge 对不同类型的行为不一致，
 * base64 字符串是四端都不会有歧义的形态。
 */
export interface AiAttachBytesRequest {
  name: string
  /** base64（不含 data: 前缀） */
  data: string
}

export interface AiSendResult {
  ok: boolean
  sessionId: string
  messageId: string
  /** ok=false 时的原因（未配置模型 / 缺密钥 / 请求失败） */
  message?: string
}

/**
 * 内置预设。baseURL 都写到 /v1（OpenAI 兼容端点的统一约定），
 * models 只是给表单填空用，用户可自行增删。
 */
export const AI_PRESETS: AiPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyless: false,
    hint: 'API Key 在 platform.deepseek.com 创建',
    contextWindow: 65536,
    visionModels: []
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyless: false,
    hint: '用百炼的 API Key，走 OpenAI 兼容模式',
    contextWindow: 32768,
    visionModels: ['qwen-vl', 'qwen2-vl', 'qwen-omni']
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyless: false,
    contextWindow: 32768,
    visionModels: ['vision']
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
    keyless: true,
    hint: '本机已运行 ollama serve 即可，不需要密钥',
    contextWindow: 32768,
    visionModels: ['llava', 'qwen2-vl', 'minicpm-v', 'moondream']
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    keyless: false,
    contextWindow: 131072,
    visionModels: ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo']
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseURL: '',
    models: [],
    keyless: false,
    hint: 'vLLM / LM Studio / one-api 等任何 OpenAI 兼容端点',
    contextWindow: 32768,
    visionModels: []
  }
]

export const DEFAULT_SYSTEM_PROMPT =
  '你是 QuickLauncher 桌面启动器内置的 AI 助手。回答直接、具体，先给结论再给理由；' +
  '代码用围栏并标注语言。不确定的事情直说不确定，不要编造。'

/** 会话里最多保留的消息条数。存档可以很长，进上下文的由 token 预算决定 */
export const MAX_SESSION_MESSAGES = 400

/** provider 没填上下文窗口时的兜底值 */
export const DEFAULT_CONTEXT_WINDOW = 32768

/** 给输出预留的 token：留不够会让模型答到一半被服务端截断 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

/** 单次消息最多带几个附件 */
export const MAX_ATTACHMENTS = 6

/** 单个附件原始字节上限。图片另有一套（见 MAX_IMAGE_BYTES） */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** 图片上限更紧：base64 后体积 ×1.33，多数端点请求体卡在 5–10MB */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 文本附件进上下文的字数上限。再长的日志该让用户先截取，而不是整本灌进去 */
export const MAX_ATTACHMENT_TEXT = 60_000

/**
 * 一次丢弃超过这么多条历史时，才值得多花一次请求做摘要。
 * 丢一两条就摘要等于每次都在烧钱，而省下的上下文几乎没有意义。
 */
export const SUMMARY_TRIGGER_MESSAGES = 6

/** 摘要正文的字数上限（不是 token），控制它别把预算又吃回去 */
export const SUMMARY_MAX_CHARS = 800

/* ------------------------------------------------------------------ *
 * 插件 AI 协议（v0.6.2）
 * ------------------------------------------------------------------ */

/**
 * 工具风险等级。
 *
 * 分级的目的是「把确认花在真正会造成后果的操作上」：读一下剪贴板就弹窗，
 * 用户两天就会养成无脑点确定的习惯，那时确认等于没有。
 */
export type AiToolRisk = 'read' | 'write' | 'dangerous'

/** 插件 `ai/tools.json` 里的一个工具声明（校验后的形态） */
export interface AiToolSpec {
  /** 插件内唯一短名：只允许小写字母、数字、下划线 */
  name: string
  title: string
  /** 给模型看的一句话：什么时候该用它、返回什么。写含糊了模型就不会调 */
  description: string
  risk: AiToolRisk
  /** 单次调用超时（毫秒），已夹取到 [1000, 60000] */
  timeoutMs: number
  /** 参数的 JSON Schema（ajv 已编译通过，否则这个工具在加载时就被丢掉） */
  parameters: Record<string, unknown>
}

/**
 * 工具条目：下发给模型时用全局名，避免两个插件都叫 `search` 时打架。
 * 模型看到的是 `plugin:com.launcher.calculator:calculate`，
 * 授权与执行都按它反查插件，不接受模型自己拼的名字。
 */
export interface AiToolEntry extends AiToolSpec {
  fullName: string
  pluginId: string
  pluginName: string
}

/** manifest 的 `ai` 段（校验后剩下的部分）：都是插件目录内的相对路径 */
export interface PluginAiMeta {
  tools?: string
  skill?: string
  /** v0.6.4 才读；现在只做「存在且是相对路径」的校验 */
  mcp?: string
}

/** 设置页「AI 工具」分组里的一行 = 一个插件的 AI 能力 */
export interface AiToolPluginView {
  pluginId: string
  pluginName: string
  disabled: boolean
  /** 用户是否授权（未授权时这些工具不下发给模型） */
  granted: boolean
  tools: { name: string; title: string; risk: AiToolRisk }[]
  /** 有 SKILL.md 时的一句话说明，界面用来解释「这个插件还会教模型怎么用它」 */
  skill?: { name: string; description: string }
  /** 解析中被丢掉的内容（坏一个工具只丢一个，插件照常加载） */
  errors: string[]
}

/** 单个插件最多声明多少个工具：多了既撑爆上下文，也说明该拆插件了 */
export const MAX_TOOLS_PER_PLUGIN = 32

export const DEFAULT_TOOL_TIMEOUT_MS = 8000
export const MIN_TOOL_TIMEOUT_MS = 1000
export const MAX_TOOL_TIMEOUT_MS = 60_000

/** 工具 description 的字数上限：模型每轮都要读它，几十个工具就是几千 token */
export const MAX_TOOL_DESCRIPTION = 500

/** 技能一句话说明的上限（正文按需读取，不进上下文） */
export const MAX_SKILL_DESCRIPTION = 300

/* ------------------------------------------------------------------ *
 * 工具执行（v0.6.3）
 * ------------------------------------------------------------------ */

/**
 * 主进程 → 插件页的一次工具调用。
 * 插件真正执行的是自己声明过的工具，`name` 是插件内短名（不是全局名）。
 */
export interface AiToolCallRequest {
  callId: string
  /** 插件内工具短名，与 tools.json 里的 name 一致 */
  name: string
  /** 已通过 schema 校验的参数对象 */
  args: Record<string, unknown>
}

/**
 * 插件 → 主进程的执行结果。
 * `result` 可以是任意可 JSON 序列化的值：字符串原样给模型，
 * 对象会被序列化（模型读 JSON 没问题，但插件最好自己给一段可读文本）。
 */
export interface AiToolReply {
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * 一轮用户消息里最多来回几轮工具调用。
 * 不设上限时，模型完全可能「调工具 → 再调同一个工具 → …」把额度烧穿；
 * 4 轮足够覆盖「读剪贴板 → 打开翻译 → 总结」这类真实链路。
 */
export const MAX_TOOL_ROUNDS = 4

/** 一轮用户消息里最多执行多少次工具（模型可能一次要求并行调用很多个） */
export const MAX_TOOL_CALLS = 8

/** 单条工具结果进入上下文的字数上限（再多就把这轮对话挤没了） */
export const MAX_TOOL_RESULT_CHARS = 4000

/** 工具参数原文落档/展示的字数上限 */
export const MAX_TOOL_ARGS_CHARS = 2000

/**
 * 确认弹窗的等待上限。超时按「拒绝」处理而不是「同意」：
 * 用户走开了、面板被藏起来了都不能变成一次静默授权。
 */
export const TOOL_CONFIRM_TIMEOUT_MS = 60_000

/** 工具页面被拉起后等它就绪的上限（插件是本地页面，慢到这个程度基本是坏了） */
export const TOOL_HOST_READY_MS = 10_000

/** 工具宿主空闲多久后回收插件视图（用户没在看它，没必要占一个渲染进程） */
export const TOOL_HOST_IDLE_MS = 60_000

// ---------------------------------------------------------------- MCP（v0.6.4）

/**
 * 单个插件最多声明几个 MCP server。
 *
 * 每个 server 都是一个长期的子进程，还会带来一批工具占上下文；
 * 5 个足够覆盖「文件 + 数据库 + 搜索 + 浏览器 + 自定义」这类真实组合。
 */
export const MAX_MCP_SERVERS_PER_PLUGIN = 5

/** 命令行参数个数与单个参数长度上限（防呆，不是安全边界——安全靠 spawn 不经 shell） */
export const MAX_MCP_ARGS = 32
export const MAX_MCP_ARG_CHARS = 512

/** 单个 server 的 env 项数上限 */
export const MAX_MCP_ENV = 32

/** tools/call 的默认超时：MCP 服务器常要起子进程或查网络，比内置工具宽一些 */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000
export const MIN_MCP_TIMEOUT_MS = 1000
export const MAX_MCP_TIMEOUT_MS = 120_000

/** 建连（spawn + initialize + tools/list）的总预算。超过就当作这个 server 暂时不可用 */
export const MCP_CONNECT_TIMEOUT_MS = 20_000

/**
 * 每次发消息前给 MCP 建连的时间预算。
 *
 * 只影响「刚打开应用/刚批准」的第一次：连上之后进程就常驻了，后续是 0 等待。
 * 3 秒是权衡——再长就开始像卡住了，再短则 npx 安装依赖那种慢启动永远赶不上。
 */
export const MCP_CHAT_BUDGET_MS = 3000

/** 连续崩溃多少次后停用该 server（本会话内不再拉起，避免「崩-拉-崩」烧 CPU） */
export const MCP_MAX_CRASHES = 3

/** server 的 stdout/stderr 各留多少字节用于排错（只保留尾部） */
export const MCP_LOG_TAIL_BYTES = 64 * 1024

/** 设置页「MCP 服务」里一行 = 一个插件声明的 server */
export interface AiMcpServerView {
  pluginId: string
  pluginName: string
  /** 插件内唯一名 */
  server: string
  /** 完整命令行（已按 shell 习惯加引号，仅供展示） */
  commandLine: string
  command: string
  args: string[]
  /** 只列键名：值里可能含 token，设置页不该把它们写进 DOM */
  envKeys: string[]
  /** 相对插件目录，空串表示用插件目录本身 */
  cwd: string
  timeoutMs: number
  /**
   * pending   —— 还没问过用户
   * approved  —— 已确认且指纹一致
   * rejected  —— 用户明确拒绝
   * stale     —— 曾经批准过，但命令改了（指纹不一致），需要重新确认
   * disabled  —— 崩溃次数超限，本会话停用
   */
  state: 'pending' | 'approved' | 'rejected' | 'stale' | 'disabled'
  /** 已连上并列出过工具时，工具的数量 */
  toolCount: number
  running: boolean
  /** 上一次失败/崩溃的原因，展示给用户 */
  error?: string
  /** 声明被丢掉的原因（坏一个丢一个） */
  errors: string[]
}
