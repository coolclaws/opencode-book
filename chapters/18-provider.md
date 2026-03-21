# 第 18 章　Provider 抽象与多模型支持

OpenCode 的核心竞争力之一是对多种 LLM 提供商的统一支持。无论是 Anthropic Claude、OpenAI GPT、Google Gemini 还是开源模型，用户只需修改配置即可切换——底层的工具调用、消息格式和流式输出都由 Provider 抽象层自动适配。

## 18.1 Provider 注册表

> **源码位置**：packages/opencode/src/provider/provider.ts

OpenCode 基于 Vercel AI SDK 构建了 Provider 抽象层。所有 LLM 提供商统一为 `Provider.Model` 接口，上层代码（Session、Agent）完全不关心底层使用哪个模型。内置 20+ 个提供商通过 `BUNDLED_PROVIDERS` 映射表管理，键为 npm 包名，值为对应的 SDK 工厂函数：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L112-135
const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
  "@ai-sdk/amazon-bedrock": createAmazonBedrock,
  "@ai-sdk/anthropic":      createAnthropic,
  "@ai-sdk/azure":           createAzure,
  "@ai-sdk/google":          createGoogleGenerativeAI,
  "@ai-sdk/google-vertex":   createVertex,
  "@ai-sdk/openai":          createOpenAI,
  "@ai-sdk/openai-compatible": createOpenAICompatible,
  "@openrouter/ai-sdk-provider": createOpenRouter,
  "@ai-sdk/xai":             createXai,
  "@ai-sdk/mistral":         createMistral,
  "@ai-sdk/groq":            createGroq,
  "@ai-sdk/deepinfra":       createDeepInfra,
  "@ai-sdk/cerebras":        createCerebras,
  "@ai-sdk/cohere":          createCohere,
  "@ai-sdk/gateway":         createGateway,
  "@ai-sdk/togetherai":      createTogetherAI,
  "@ai-sdk/perplexity":      createPerplexity,
  "@ai-sdk/vercel":          createVercel,
  "gitlab-ai-provider":      createGitLab,
  "@ai-sdk/github-copilot":  createGitHubCopilotOpenAICompatible,
}
```

这些 SDK 包在编译时直接打包，避免运行时动态安装的延迟和不确定性。每个提供商的特殊行为则通过 `CUSTOM_LOADERS` 注册表管理，返回包含 `autoload`、`getModel`、`vars`、`options` 等字段的配置对象，控制模型发现和加载行为。

### 18.1.1 自定义加载器的精细控制

不同提供商需要不同的模型加载策略。例如 OpenAI 和 xAI 默认使用 Responses API，而 GitHub Copilot 根据模型版本动态选择：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L203-209
"github-copilot": async () => ({
  autoload: false,
  async getModel(sdk: any, modelID: string) {
    if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
    return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
  },
})
```

`shouldUseCopilotResponsesApi()` 通过正则 `/^gpt-(\d+)/` 判断模型版本号——GPT-5 及以上使用 Responses API，GPT-5-mini 除外。`autoload: false` 表示 Copilot 的模型列表不从 models.dev 自动加载，因为可用模型取决于用户的订阅级别。

Amazon Bedrock 的加载器更为复杂，需要处理跨区域推理前缀。根据 AWS 区域自动为模型 ID 添加 `us.`、`eu.`、`jp.`、`apac.` 或 `au.` 前缀，让用户无需关心这些底层细节。

## 18.2 模型解析与 SDK 实例化

### 18.2.1 多层模型解析管道

Provider 的核心初始化逻辑在 `Instance.state()` 中完成，这是一个复杂的多阶段管道，将来自不同数据源的模型信息合并为统一的 `Provider.Model` 对象。

第一阶段从 models.dev 加载基础数据库，通过 `fromModelsDevProvider()` 将外部格式转换为内部 `Info` 结构。第二阶段处理用户配置（`opencode.json` 中的 `provider` 字段），将用户自定义的模型与数据库模型合并。合并逻辑使用 `mergeDeep()` 确保用户配置可以覆盖数据库中的任何字段：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L949-960
function mergeProvider(providerID: ProviderID, provider: Partial<Info>) {
  const existing = providers[providerID]
  if (existing) {
    providers[providerID] = mergeDeep(existing, provider)
    return
  }
  const match = database[providerID]
  if (!match) return
  providers[providerID] = mergeDeep(match, provider)
}
```

第三阶段加载环境变量中的 API Key。代码遍历每个提供商的 `env` 数组（如 Anthropic 的 `["ANTHROPIC_API_KEY"]`），只要找到一个非空的环境变量，就将该提供商标记为 `source: "env"` 并加入活跃列表。第四阶段从 `Auth` 模块加载通过 `opencode auth` 命令保存的凭据。第五阶段执行 `CUSTOM_LOADERS`，每个加载器可以注册自定义的 `getModel`、`vars`、`discoverModels` 函数。

最后一个阶段是过滤：移除 deprecated 模型、alpha 模型（除非启用实验特性）、配置黑名单/白名单中的模型，以及 `disabled_providers` 和 `enabled_providers` 列表控制的提供商。

### 18.2.2 SDK 实例化与 fetch 包装

`getSDK()` 函数负责为每个模型创建对应的 AI SDK 实例。它使用 Hash 缓存策略——将 providerID、npm 包名和选项序列化后哈希，相同配置的模型共享同一个 SDK 实例：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L1235-1237
const key = Hash.fast(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
const existing = s.sdk.get(key)
if (existing) return existing
```

所有 SDK 实例的 `fetch` 函数都被包装，注入了超时控制和信号合并逻辑。当用户配置了 `timeout` 选项时，通过 `AbortSignal.timeout()` 创建超时信号；当配置了 `chunkTimeout` 时，SSE 流式响应的每个 chunk 读取都有独立超时。多个信号通过 `AbortSignal.any()` 合并，任一信号触发都会中断请求：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L1247-1256
const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
const signals: AbortSignal[] = []
if (opts.signal) signals.push(opts.signal)
if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
  signals.push(AbortSignal.timeout(options["timeout"]))
const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
```

一个有趣的细节是 OpenAI 的 `itemId` 处理。对于 `@ai-sdk/openai` 的 POST 请求，代码会解析请求体 JSON 并删除 `input` 数组中每个元素的 `id` 字段——这是参照 OpenAI Codex 的行为，避免旧的 item ID 导致的冲突。只有 Azure 提供商且 `store: true` 时才保留 ID：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L1262-1273
if (model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST") {
  const body = JSON.parse(opts.body as string)
  const isAzure = model.providerID.includes("azure")
  const keepIds = isAzure && body.store === true
  if (!keepIds && Array.isArray(body.input)) {
    for (const item of body.input) {
      if ("id" in item) { delete item.id }
    }
    opts.body = JSON.stringify(body)
  }
}
```

### 18.2.3 baseURL 变量替换

模型的 API 端点 URL 可能包含动态变量占位符，如 Azure 的 `https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1`。`getSDK()` 中的 baseURL 解析分两步完成：首先通过 `varsLoaders`（由 CUSTOM_LOADERS 注册）替换已知变量，然后用正则匹配剩余的 `${...}` 占位符并从环境变量中查找对应值。

## 18.3 models.dev 动态模型元数据

模型元数据从 models.dev 动态获取，首次启动时同步拉取，后续每小时在后台异步刷新：

```typescript
// 文件: packages/opencode/src/provider/models.ts L106-132
export async function refresh() {
  const result = await fetch(`${url()}/api.json`, {
    headers: { "User-Agent": Installation.USER_AGENT },
    signal: AbortSignal.timeout(10 * 1000),
  })
  if (result && result.ok) {
    await Filesystem.write(filepath, await result.text())
    ModelsDev.Data.reset()
  }
}

setInterval(async () => { await ModelsDev.refresh() }, 60 * 1000 * 60).unref()
```

`Data` 使用 `lazy()` 模式加载：优先从本地缓存文件读取，其次尝试编译时内嵌的快照（`models-snapshot`），最后才从网络拉取。`reset()` 清除内存缓存使下次访问重新从文件加载。这种三级回退确保即使完全离线也能正常使用。`setInterval` 末尾的 `.unref()` 避免定时器阻止 Node.js 进程退出。

当 Anthropic 发布新版 Claude 或 Google 推出新 Gemini 模型时，models.dev 的数据会在数小时内更新，而 OpenCode 用户只需等待下一次自动刷新即可看到新模型，无需升级应用。

## 18.4 消息格式适配

> **源码位置**：packages/opencode/src/provider/transform.ts

`ProviderTransform.message()` 是 Provider 抽象中最复杂的部分。它依次执行三个转换步骤：过滤不支持的输入模态（`unsupportedParts`）、规范化消息格式（`normalizeMessages`）、以及为 Anthropic 模型添加缓存标记（`applyCaching`）。

**toolCallId 规范化** 是跨提供商切换时的关键问题。Claude 模型要求 ID 只含字母、数字、下划线和连字符，Mistral 则要求 9 位纯字母数字：

```typescript
// 文件: packages/opencode/src/provider/transform.ts L78-82
// Claude: 替换非法字符
toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_")

// 文件: packages/opencode/src/provider/transform.ts L103-107
// Mistral: 严格 9 位字母数字
const normalizedId = part.toolCallId
  .replace(/[^a-zA-Z0-9]/g, "")
  .substring(0, 9)
  .padEnd(9, "0")
```

Mistral 还有消息序列约束——tool 消息不能直接跟 user 消息，`normalizeMessages` 会在两者之间插入一条 `"Done."` 的 assistant 消息来满足 API 要求。

### 18.4.1 不支持模态的优雅降级

`unsupportedParts()` 函数在消息格式适配的最前端执行，它检查每个用户消息中的文件和图片部分，验证模型是否支持对应的输入模态。如果模型不支持某种模态（如纯文本模型不支持图片），该部分会被替换为一条错误提示文本而非直接报错：

```typescript
// 文件: packages/opencode/src/provider/transform.ts L239-244
const name = filename ? `"${filename}"` : modality
return {
  type: "text" as const,
  text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
}
```

对于图片数据，还有一个额外的检查——空的 base64 数据。如果图片的 data URI 中 base64 部分为空或长度为零，会被替换为 "Image file is empty or corrupted" 的错误提示。这个检查防止了因文件读取失败导致的空图片被发送给 LLM，避免浪费 token 和产生令人困惑的响应。

### 18.4.2 Anthropic 空消息过滤

Anthropic API 对空内容有严格限制——空字符串的消息会导致 API 错误。`normalizeMessages()` 针对 Anthropic 和 Bedrock 提供商特别处理：过滤空字符串消息，移除 text 和 reasoning 部分中文本为空的项，并在所有 content 被过滤后丢弃整条消息：

```typescript
// 文件: packages/opencode/src/provider/transform.ts L54-72
if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
  msgs = msgs
    .map((msg) => {
      if (typeof msg.content === "string") {
        if (msg.content === "") return undefined
        return msg
      }
      if (!Array.isArray(msg.content)) return msg
      const filtered = msg.content.filter((part) => {
        if (part.type === "text" || part.type === "reasoning") {
          return part.text !== ""
        }
        return true
      })
      if (filtered.length === 0) return undefined
      return { ...msg, content: filtered }
    })
    .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
}
```

### 18.4.3 interleaved 推理内容处理

对于支持 interleaved thinking 但使用非标准字段名的提供商（如某些 OpenAI-compatible 后端），`normalizeMessages()` 会将 assistant 消息中的 reasoning 部分提取出来，通过 `providerOptions` 以提供商期望的字段名（`reasoning_content` 或 `reasoning_details`）注入，同时从原始 content 中移除 reasoning 部分：

```typescript
// 文件: packages/opencode/src/provider/transform.ts L136-169
if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
  const field = model.capabilities.interleaved.field
  return msgs.map((msg) => {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
      const reasoningText = reasoningParts.map((part: any) => part.text).join("")
      const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")
      if (reasoningText) {
        return {
          ...msg,
          content: filteredContent,
          providerOptions: {
            ...msg.providerOptions,
            openaiCompatible: {
              ...(msg.providerOptions as any)?.openaiCompatible,
              [field]: reasoningText,
            },
          },
        }
      }
      return { ...msg, content: filteredContent }
    }
    return msg
  })
}
```

### 18.4.4 缓存控制策略

对于 Anthropic 和兼容提供商，`applyCaching()` 在系统提示词的前两条和对话的最后两条消息上标记 `cacheControl`。不同提供商的缓存标记格式各异：

```typescript
// 文件: packages/opencode/src/provider/transform.ts L178-194
const providerOptions = {
  anthropic:        { cacheControl: { type: "ephemeral" } },
  openrouter:       { cacheControl: { type: "ephemeral" } },
  bedrock:          { cachePoint: { type: "default" } },
  openaiCompatible: { cache_control: { type: "ephemeral" } },
  copilot:          { copilot_cache_control: { type: "ephemeral" } },
}
```

系统提示词在多轮对话中每次都重复发送，启用缓存后首次处理即缓存，后续请求直接命中，对长对话可节省 80% 以上的输入 token 成本。

## 18.5 推理模式与参数配置

不同模型有不同的最佳温度配置。`temperature()` 函数根据模型 ID 返回推荐值——Qwen 系列 0.55、Gemini 系列 1.0、Claude 系列不设置（让 API 使用默认值）。`topP()` 和 `topK()` 同样按模型定制。

推理模式（thinking/reasoning）的配置是 `variants()` 函数最复杂的部分。每个提供商有完全不同的 API 格式：Anthropic 使用 `thinking.type` + `budgetTokens`，OpenAI 使用 `reasoningEffort`，Google 使用 `thinkingConfig.thinkingBudget`，Bedrock 使用 `reasoningConfig`。新一代 Anthropic 模型（Opus 4.6、Sonnet 4.6）还支持 adaptive 模式，根据 effort 级别动态调整推理深度：

```typescript
// 文件: packages/opencode/src/provider/transform.ts L524-536
if (isAnthropicAdaptive) {
  return Object.fromEntries(
    adaptiveEfforts.map((effort) => [
      effort,
      { thinking: { type: "adaptive" }, effort },
    ]),
  )
}
```

`options()` 函数为每个请求生成提供商特定参数。OpenAI 默认设置 `store: false` 避免数据存储，OpenRouter 要求 `usage.include: true` 以获取用量统计，Google 默认启用 `includeThoughts`。GPT-5 系列还会设置 `textVerbosity: "low"` 以减少冗长输出。

## 18.6 providerOptions 路由与 Gateway 支持

`providerOptions()` 函数负责将模型参数路由到正确的 SDK 命名空间。`sdkKey()` 将 npm 包名映射为 AI SDK 期望的 key——例如 `@ai-sdk/anthropic` 映射为 `"anthropic"`、`@ai-sdk/amazon-bedrock` 映射为 `"bedrock"`。对于 AI Gateway 提供商，路由逻辑更加精细：gateway 原生参数（如路由和缓存控制）放在 `gateway` 命名空间下，而模型特定参数根据 API ID 前缀（如 `anthropic/`、`google/`）路由到对应的上游提供商命名空间，实现单一 Gateway 配置访问多个后端模型。

`schema()` 函数处理工具参数的 JSON Schema 差异。Google/Gemini 不支持整数类型的枚举值，`sanitizeGemini()` 递归遍历 schema 树，将整数枚举转为字符串枚举并修正类型声明，同时移除非 object 类型节点上的 `properties` 和 `required` 字段。这些细微的格式差异是跨提供商兼容性中最容易被忽视但最容易引发运行时错误的部分。

## 18.7 API 错误处理与上下文溢出检测

> **源码位置**：packages/opencode/src/provider/error.ts

`ProviderError` 命名空间实现了一套全面的 API 错误解析系统。不同提供商的错误格式千差万别，但 OpenCode 需要统一识别两类关键错误：上下文窗口溢出和可重试的 API 错误。

上下文溢出是 LLM 应用中最常见的运行时错误。`isOverflow()` 函数通过 15 个正则表达式匹配来自不同提供商的溢出错误消息：

```typescript
// 文件: packages/opencode/src/provider/error.ts L10-26
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,                       // Anthropic
  /input is too long for requested model/i,    // Amazon Bedrock
  /exceeds the context window/i,               // OpenAI
  /input token count.*exceeds the maximum/i,   // Google (Gemini)
  /maximum prompt length is \d+/i,             // xAI (Grok)
  /reduce the length of the messages/i,        // Groq
  /maximum context length is \d+ tokens/i,     // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i,                 // GitHub Copilot
  /exceeds the available context size/i,       // llama.cpp server
  /greater than the context length/i,          // LM Studio
  /context window exceeds limit/i,             // MiniMax
  /exceeded model token limit/i,               // Kimi For Coding, Moonshot
  /context[_ ]length[_ ]exceeded/i,            // Generic fallback
  /request entity too large/i,                 // HTTP 413
  /context length is only \d+ tokens/i,        // vLLM
]
```

这套模式覆盖了从云端 API（Anthropic、OpenAI、Google）到本地推理引擎（llama.cpp、LM Studio、vLLM）的广泛场景。还有一个特殊处理：Cerebras 和 Mistral 经常返回空 body 的 400/413 状态码，通过 `/^4(00|13)\s*(status code)?\s*\(no body\)/i` 单独匹配。

错误消息的提取同样需要跨提供商适配。`message()` 函数尝试多种策略获取可读的错误消息：优先使用原始消息，如果消息为空则尝试响应体，再尝试 HTTP 状态码对应的标准描述。对于 JSON 响应体，还会尝试解析 `body.message`、`body.error` 或 `body.error.message` 字段。如果响应体是 HTML（常见于反向代理或 API 网关的错误页面），则根据状态码返回人类可读的提示。

流式响应中的错误通过 `parseStreamError()` 单独处理，它从 SSE 数据中解析 JSON 错误对象，识别 `context_length_exceeded`、`insufficient_quota` 和 `usage_not_included` 等错误码。

`parseAPICallError()` 是最终的错误分类器，将 `APICallError` 转换为 `context_overflow` 或 `api_error` 类型。对于 OpenAI 提供商有一个特殊的重试策略——404 错误也被标记为可重试，因为 OpenAI 有时对实际可用的模型返回 404。

## 18.8 SSE 流式超时保护

`wrapSSE()` 函数解决了一个在生产环境中极为常见但难以诊断的问题——API 网关或代理服务器静默挂起导致的无限等待。当 LLM 提供商的响应通过 SSE（Server-Sent Events）流式传输时，TCP 连接保持打开状态，但可能因为网关超时、服务器内部错误或网络波动而停止发送数据。

`wrapSSE()` 的实现是一个精巧的 ReadableStream 包装器。它只对 `content-type` 为 `text/event-stream` 的响应生效，对普通 HTTP 响应直接透传：

```typescript
// 文件: packages/opencode/src/provider/provider.ts L64-110
function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new Error("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, ms)
        reader.read().then(
          (part) => { clearTimeout(id); resolve(part) },
          (err) => { clearTimeout(id); reject(err) },
        )
      })
      if (part.done) { ctrl.close(); return }
      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })
  return new Response(body, { headers: new Headers(res.headers), status: res.status, statusText: res.statusText })
}
```

每次 `pull` 调用（即消费者请求下一个 chunk）时，都会启动一个独立的 `setTimeout` 计时器。如果在超时时间内没有收到新数据，计时器触发后做三件事：abort 整个请求的 AbortController（阻止后续网络操作）、cancel 底层 reader（释放资源）、reject Promise（通知上层错误）。如果数据及时到达，`clearTimeout` 取消计时器，数据被正常转发。

这里的关键设计是超时计时器是 per-chunk 而非 per-request 的——只要 Server 持续发送数据（哪怕间隔较长），连接就不会被断开。只有完全停止发送数据时才会超时。

## 18.9 LiteLLM 代理与特殊处理

企业用户通过 LiteLLM 代理统一管理 LLM 访问时，会遇到一个已知限制：消息历史包含工具调用记录时，请求必须携带 tools 参数。OpenCode 通过注入 `_noop` 占位工具解决此问题。

## 18.10 本章要点

- Provider 抽象层通过统一的 `Model` schema 屏蔽底层差异，`BUNDLED_PROVIDERS` 内置 20+ 个提供商
- 模型解析管道分五阶段：models.dev 数据库 -> 用户配置合并 -> 环境变量/Auth 凭据 -> CUSTOM_LOADERS 定制 -> 过滤清理
- SDK 实例通过 Hash 缓存复用，`fetch` 包装注入超时控制和 OpenAI itemId 清理
- 模型元数据从 models.dev 动态获取，三级回退（缓存文件 -> 编译快照 -> 网络），每小时自动刷新
- 消息格式适配包括：Anthropic 空消息过滤、不支持模态的优雅降级、interleaved 推理内容字段映射
- 上下文溢出检测覆盖 15+ 个提供商的错误模式，OpenAI 404 错误特殊标记为可重试
- `wrapSSE()` 实现 per-chunk 超时保护，防止 API 网关静默挂起导致的无限等待
- 推理模式通过 `variants()` 为 Anthropic、OpenAI、Google、Bedrock 等提供商独立配置不同 API 格式
- LiteLLM 代理兼容性通过 `_noop` 占位工具解决
