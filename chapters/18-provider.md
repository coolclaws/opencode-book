# 第 18 章　Provider 抽象与多模型支持

OpenCode 的核心竞争力之一是对多种 LLM 提供商的统一支持。无论是 Anthropic Claude、OpenAI GPT、Google Gemini 还是开源模型，用户只需修改配置即可切换——底层的工具调用、消息格式和流式输出都由 Provider 抽象层自动适配。

## 18.1 Provider 无关设计

> **源码位置**：packages/opencode/src/provider/provider.ts

OpenCode 基于 Vercel AI SDK 构建了 Provider 抽象层。核心思路是：将所有 LLM 提供商统一为 `Provider.Model` 接口，上层代码（Session、Agent）完全不关心底层使用哪个模型。

```typescript
export const Model = z.object({
  id: z.string(),              // 如 "claude-sonnet-4-5"
  providerID: z.string(),      // 如 "anthropic"
  api: z.object({
    id: z.string(),            // API 层面的模型标识
    url: z.string(),           // API 端点
    npm: z.string(),           // SDK 包名，如 "@ai-sdk/anthropic"
  }),
  name: z.string(),            // 人类可读名称
  capabilities: z.object({
    temperature: z.boolean(),  // 是否支持温度参数
    reasoning: z.boolean(),    // 是否支持推理模式
    attachment: z.boolean(),   // 是否支持文件附件
    toolcall: z.boolean(),     // 是否支持工具调用
    input: z.object({          // 输入模态
      text: z.boolean(), audio: z.boolean(),
      image: z.boolean(), video: z.boolean(), pdf: z.boolean(),
    }),
    output: z.object({         // 输出模态
      text: z.boolean(), audio: z.boolean(),
      image: z.boolean(), video: z.boolean(), pdf: z.boolean(),
    }),
  }),
  limit: z.object({
    context: z.number(),       // 上下文窗口大小
    output: z.number(),        // 最大输出 token 数
  }),
  cost: z.object({             // 价格信息
    input: z.number(),
    output: z.number(),
  }),
  // ...
})
```

这个 schema 统一描述了所有模型的能力边界，上层代码可以据此做出决策——例如判断模型是否支持图片输入、是否支持推理模式等。

## 18.2 支持的 Provider

OpenCode 内置了对 20+ 个 LLM 提供商的支持，通过 `BUNDLED_PROVIDERS` 注册表管理：

```typescript
const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
  "@ai-sdk/anthropic":              createAnthropic,
  "@ai-sdk/openai":                 createOpenAI,
  "@ai-sdk/google":                 createGoogleGenerativeAI,
  "@ai-sdk/google-vertex":          createVertex,
  "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
  "@ai-sdk/amazon-bedrock":         createAmazonBedrock,
  "@ai-sdk/azure":                  createAzure,
  "@openrouter/ai-sdk-provider":    createOpenRouter,
  "@ai-sdk/xai":                    createXai,
  "@ai-sdk/mistral":                createMistral,
  "@ai-sdk/groq":                   createGroq,
  "@ai-sdk/deepinfra":              createDeepInfra,
  "@ai-sdk/cerebras":               createCerebras,
  "@ai-sdk/openai-compatible":      createOpenAICompatible,
  "@ai-sdk/cohere":                 createCohere,
  "@ai-sdk/gateway":                createGateway,
  "@ai-sdk/togetherai":             createTogetherAI,
  "@ai-sdk/perplexity":             createPerplexity,
  "@ai-sdk/vercel":                 createVercel,
  "@gitlab/gitlab-ai-provider":     createGitLab,
  "@ai-sdk/github-copilot":         createGitHubCopilotOpenAICompatible,
}
```

模型元数据从 [models.dev](https://models.dev) 动态获取，每小时自动刷新：

```typescript
export namespace ModelsDev {
  export async function refresh() {
    const result = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(10 * 1000),
    })
    if (result.ok) {
      await Filesystem.write(filepath, await result.text())
      ModelsDev.Data.reset()
    }
  }
}
// 每小时刷新一次
setInterval(() => ModelsDev.refresh(), 60 * 1000 * 60)
```

这意味着新模型发布后，OpenCode 无需更新即可自动支持。

## 18.3 模型参数配置

> **源码位置**：packages/opencode/src/provider/transform.ts

`ProviderTransform` 模块负责为不同模型生成合适的参数。不同模型有不同的最佳温度和推理配置：

```typescript
export function temperature(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined    // Anthropic 推荐不设置
  if (id.includes("gemini")) return 1.0
  if (id.includes("kimi-k2")) return 0.6
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (id.includes("minimax-m2") || id.includes("gemini")) return 0.95
  return undefined
}
```

推理模式（thinking/reasoning）的配置更为复杂，每个提供商有不同的 API 格式：

```typescript
export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  switch (model.api.npm) {
    case "@ai-sdk/anthropic":
      // Anthropic 使用 thinking.type + budgetTokens
      return {
        high: { thinking: { type: "enabled", budgetTokens: 16_000 } },
        max:  { thinking: { type: "enabled", budgetTokens: 31_999 } },
      }
    case "@ai-sdk/openai":
      // OpenAI 使用 reasoningEffort
      return Object.fromEntries(
        ["low", "medium", "high"].map((effort) => [effort, { reasoningEffort: effort }])
      )
    case "@ai-sdk/google":
      // Google 使用 thinkingConfig.thinkingBudget
      return {
        high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        max:  { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
      }
    // ... 其他提供商各有差异
  }
}
```

## 18.4 Codex 特殊处理

OpenAI 的 GitHub Codex 集成需要特殊的认证和调用方式。在 `LLM.stream()` 中有专门的处理逻辑：

```typescript
export async function stream(input: StreamInput) {
  const [language, cfg, provider, auth] = await Promise.all([
    Provider.getLanguage(input.model),
    Config.get(),
    Provider.getProvider(input.model.providerID),
    Auth.get(input.model.providerID),
  ])
  // 检测是否为 Codex 模式：provider 是 openai 且使用 OAuth 认证
  const isCodex = provider.id === "openai" && auth?.type === "oauth"

  if (isCodex) {
    // Codex 使用 instructions 而非 system prompt
    options.instructions = SystemPrompt.instructions()
  }

  // Codex 和 GitHub Copilot 不设置 maxOutputTokens
  const maxOutputTokens =
    isCodex || provider.id.includes("github-copilot")
      ? undefined
      : ProviderTransform.maxOutputTokens(input.model)
}
```

GitHub Copilot 提供商还有自定义的模型加载逻辑，根据模型版本选择 Responses API 或 Chat API：

```typescript
"github-copilot": async () => ({
  autoload: false,
  async getModel(sdk: any, modelID: string) {
    // GPT-5 及以上使用 Responses API，其他使用 Chat API
    return shouldUseCopilotResponsesApi(modelID)
      ? sdk.responses(modelID)
      : sdk.chat(modelID)
  },
})
```

## 18.5 LiteLLM 代理支持

许多企业通过 LiteLLM 代理统一管理 LLM 访问。OpenCode 内置了 LiteLLM 兼容性处理：

```typescript
// LiteLLM 代理检测
const isLiteLLMProxy =
  provider.options?.["litellmProxy"] === true ||
  input.model.providerID.toLowerCase().includes("litellm") ||
  input.model.api.id.toLowerCase().includes("litellm")

// LiteLLM 要求工具参数在消息历史包含工具调用时必须存在
// 即使当前轮次不需要工具
if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
  tools["_noop"] = tool({
    description: "Placeholder for LiteLLM/Anthropic proxy compatibility",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => ({ output: "", title: "", metadata: {} }),
  })
}
```

这个 `_noop` 占位工具解决了 LiteLLM 的一个已知限制：当消息历史中包含工具调用记录时，请求必须包含 tools 参数。

## 18.6 与 Cursor / Continue 的 Provider 系统对比

| 特性 | OpenCode | Cursor | Continue |
|------|----------|--------|----------|
| 内置提供商数量 | 20+ | 约 5 个 | 10+ |
| 模型发现 | models.dev 动态刷新 | 硬编码 | 配置文件 |
| 推理模式适配 | 每个提供商独立配置 | 有限支持 | 基础支持 |
| 企业代理 | LiteLLM 原生支持 | 需手动配置 | 有限支持 |
| 自定义 Provider | OpenAI Compatible SDK | API 兼容 | 配置文件 |
| 消息格式适配 | 自动（toolCallId 规范化等） | 手动 | 基础 |

OpenCode 的核心优势在于 `ProviderTransform` 模块——它为每个提供商精心调整了消息格式、缓存策略和参数配置，用户无需关心底层差异。

## 18.7 实战：配置自定义 Provider

假设你有一个兼容 OpenAI API 的本地 LLM 服务（如 Ollama），配置方式如下：

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen3:32b": {
          "name": "Qwen 3 32B",
          "attachment": false,
          "reasoning": true,
          "temperature": true,
          "tool_call": true,
          "cost": { "input": 0, "output": 0 },
          "limit": { "context": 32768, "output": 8192 },
          "options": {}
        }
      }
    }
  }
}
```

配置完成后，用户可以在 OpenCode 中选择 `ollama/qwen3:32b` 作为对话模型，所有工具调用和消息格式会自动适配。

## 18.8 本章要点

- Provider 抽象层通过统一的 `Model` schema 屏蔽底层差异，上层代码完全 Provider 无关
- 内置 20+ 个提供商支持，模型元数据从 models.dev 动态获取并自动刷新
- `ProviderTransform` 为每个提供商定制温度、推理模式和消息格式等参数
- Codex/GitHub Copilot 有专门的认证和 API 选择逻辑
- LiteLLM 代理兼容性通过 `_noop` 占位工具解决工具参数要求
