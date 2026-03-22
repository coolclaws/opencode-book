# 第 15 章　事件总线与消息驱动

> "The best architectures are those that minimize coupling between components while maximizing cohesion within them." —— Robert C. Martin

OpenCode 的各个子系统之间通过事件总线进行通信，而非直接调用。这种消息驱动架构实现了模块间的松耦合，使得 Session 层的变化能自动传播到 TUI、SSE 端点和桌面应用。本章深入分析事件总线的类型安全设计和运作机制。

## 15.1 从直接调用到事件驱动

假设 Session 模块处理完消息后需要通知 UI 更新。最直觉的做法是直接 import TUI 模块调用其更新方法，但这导致 Session 需要知道每个消费者的存在——TUI、SSE 端点、ACP 协议层，每增加一个消费者就多一个依赖：

```text
直接调用模式（紧耦合）                 事件驱动模式（松耦合）

┌──────────┐                        ┌──────────┐
│ Session  │                        │ Session  │
│          ├──→ import TUI          │          ├──→ Bus.publish(event)
│          ├──→ import SSE          │          │    （仅此一个依赖）
│          ├──→ import ACP          └────┬─────┘
│          ├──→ import VSCode?               │
│          ├──→ import Logger?        ┌──────┴──────┐
└──────────┘                         │     Bus      │
  每增加一个消费者                     │  ┌───┬───┐  │
  Session 就多一个依赖                 └──┤   │   ├──┘
                                        ▼   ▼   ▼
                                      TUI  SSE  ACP
                                    消费者自行订阅，互不干扰
```

OpenCode 选择了事件驱动架构来解决这个问题。Session 只负责发布事件，不关心谁在监听。TUI、SSE 端点、VS Code 扩展各自订阅所需事件——新增消费者无需修改 Session 任何代码。这种解耦也极大提升了可测试性：验证 Session 行为只需订阅事件检查载荷，测试 UI 响应只需手动发布事件。

## 15.2 BusEvent.define()：类型安全的事件定义

> **源码位置**：packages/opencode/src/bus/bus-event.ts

事件系统的核心是 `BusEvent.define()` 函数，它结合 Zod schema 实现了类型安全的事件定义：

```typescript
// 文件: packages/opencode/src/bus/bus-event.ts L5-19
export namespace BusEvent {
  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(
    type: Type,
    properties: Properties
  ) {
    const result = { type, properties }
    registry.set(type, result)  // 自动注册到全局注册表
    return result
  }
}
```

`define` 函数接收两个泛型参数：`Type` 是字面量字符串类型（如 `"session.created"`），`Properties` 是描述事件载荷的 Zod schema。每次调用 `define` 时，事件定义会自动注册到一个全局 `registry` Map 中。

这意味着在源码中任意位置定义的事件都会被自动收集，无需手动维护一个集中式的事件列表。

### TypeScript 类型魔法：Discriminated Union

`BusEvent.define()` 的两个泛型参数协同工作，构建了一套端到端的类型安全体系。理解这套体系需要先理解 TypeScript 中 Discriminated Union（可辨识联合类型）的概念。

`Type` 参数被约束为 `extends string`，但在实际使用中 TypeScript 会将其推导为字面量类型——当你传入 `"session.created"` 时，`Type` 不是宽泛的 `string`，而是精确的 `"session.created"` 字面量。这个字面量类型成为后续类型判别的关键。之所以能实现这种推导，是因为 TypeScript 的泛型参数在接收字符串字面量时，会自动将泛型实例化为最窄的类型。如果 `Type` 被声明为 `string` 而非泛型参数，就无法捕获字面量信息，所有事件的 `type` 字段都会退化为 `string` 类型，类型缩窄也就无从谈起。

`Properties` 参数则是一个 Zod schema 类型。Zod 的类型系统允许从 schema 中提取两种 TypeScript 类型：`z.input<T>`（输入类型，即调用 `.parse()` 之前的数据形状）和 `z.output<T>`（输出类型，即 `.parse()` 之后的数据形状）。在事件系统中，`publish()` 使用 `z.output<Definition["properties"]>` 来约束发布者必须提供正确的载荷类型，而 `subscribe()` 使用 `z.infer<Definition["properties"]>` 来为回调函数提供精确的参数类型。

这两者结合产生了 Discriminated Union 的效果。当多个事件定义被聚合在一起时，TypeScript 可以根据 `type` 字段的字面量值来缩窄整个事件对象的类型。例如，在一个处理多种事件的回调中，检查 `event.type === "session.created"` 后，TypeScript 自动知道 `event.properties` 包含 `Session.Info` 的所有字段。这种类型缩窄完全发生在编译期，不产生任何运行时开销。这也意味着如果有人拼错了事件名称或传错了载荷字段，编译器会立即报错，而非在运行时出现难以追踪的 bug。

## 15.3 事件注册表与命名约定

整个 OpenCode 系统定义了丰富的事件类型，覆盖所有核心业务领域：

```typescript
// 文件: packages/opencode/src/session/index.ts L40-55
// Session 生命周期事件
Session.Event = {
  Created: BusEvent.define("session.created", Session.Info),
  Updated: BusEvent.define("session.updated", Session.Info),
  Deleted: BusEvent.define("session.deleted", z.object({ id: z.string() })),
  Error:   BusEvent.define("session.error", z.object({ id: z.string(), error: z.string() })),
}

// 消息事件
MessageV2.Event = {
  Updated:     BusEvent.define("message.updated", /* ... */),
  PartUpdated: BusEvent.define("message.part.updated", /* ... */),
  PartDelta:   BusEvent.define("message.part.delta", /* ... */),
}

// Worktree 事件
Worktree.Event = {
  Ready:  BusEvent.define("worktree.ready", z.object({ name: z.string(), branch: z.string() })),
  Failed: BusEvent.define("worktree.failed", z.object({ message: z.string() })),
}

// MCP 事件
MCP.ToolsChanged = BusEvent.define("mcp.tools.changed", z.object({ server: z.string() }))

// 其他：project.updated、lsp.updated、question.asked、installation.updated 等
```

事件命名遵循 `domain[.sub].action` 的分层约定。以 `message.part.updated` 为例：`message` 是领域，`part` 是子对象（一条消息包含多个 part），`updated` 是动作。`session.created` 只有两层，因为 Session 本身就是顶层实体。`permission.asked` 使用 `asked` 而非 `created`，命名反映业务意图而非 CRUD 操作。这种分层命名在日志中一目了然，也为通配符订阅提供了语义基础。每个事件的 `properties` 都有完整的 Zod schema 约束，确保发布和订阅两端数据结构一致。

## 15.4 事件发布与订阅

> **源码位置**：packages/opencode/src/bus/index.ts

Bus 模块实现了经典的发布/订阅模式，同时与 Instance 生命周期绑定：

```typescript
// 文件: packages/opencode/src/bus/index.ts L41-64
export namespace Bus {
  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = { type: def.type, properties }
    const pending = []
    // 分发给精确匹配和通配符订阅者
    for (const key of [def.type, "*"]) {
      const match = [...(state().subscriptions.get(key) ?? [])]
      for (const sub of match) {
        pending.push(sub(payload))
      }
    }
    // 同时通过 GlobalBus 广播，供跨 Instance 监听
    GlobalBus.emit("event", { directory: Instance.directory, payload })
    return Promise.all(pending)
  }

  // 订阅特定事件
  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => void,
  ) {
    return raw(def.type, callback)
  }

  // 订阅所有事件（通配符）
  export function subscribeAll(callback: (event: any) => void) {
    return raw("*", callback)
  }
}
```

有几个关键设计点值得深入分析：

**类型推导的精确性**：`publish` 的 `properties` 参数类型由 `Definition` 泛型自动推导，传错字段会在编译时报错。

**双层广播机制**：每次 `publish` 都执行两轮分发——第一轮是 Instance 内部本地分发（精确匹配和通配符 `"*"`），第二轮通过 `GlobalBus.emit()` 跨 Instance 广播给 SSE 端点。这让同一 `publish` 调用能同时服务本地 TUI 和远程桌面应用。

**返回取消函数**：`subscribe` 返回一个 `() => void` 函数，调用即取消订阅。源码中的 `raw` 函数实现了这个模式——通过闭包捕获回调引用，取消时从数组中移除：

```typescript
// 文件: packages/opencode/src/bus/index.ts L89-104
function raw(type: string, callback: (event: any) => void) {
  const subscriptions = state().subscriptions
  let match = subscriptions.get(type) ?? []
  match.push(callback)
  subscriptions.set(type, match)

  return () => {
    const match = subscriptions.get(type)
    if (!match) return
    const index = match.indexOf(callback)
    if (index === -1) return
    match.splice(index, 1)
  }
}
```

`publish` 在分发时使用扩展运算符 `[...(state().subscriptions.get(key) ?? [])]` 创建订阅者数组的快照。这个看似简单的操作解决了一个微妙的并发问题：如果某个订阅者的回调函数中触发了新的订阅或取消订阅（比如 `once` 方法在回调中取消自身），直接遍历原数组会导致迭代器失效。快照确保了当前分发轮次使用的是一份稳定的订阅者列表，新的订阅/取消操作只影响下一次 `publish`。

## 15.5 GlobalBus 与跨 Instance 通信

GlobalBus 是 Bus 系统中容易被忽略但至关重要的一环。它是一个简单的 Node.js `EventEmitter` 实例：

```typescript
// 文件: packages/opencode/src/bus/global.ts L1-10
import { EventEmitter } from "events"

export const GlobalBus = new EventEmitter<{
  event: [
    {
      directory?: string
      payload: any
    },
  ]
}>()
```

GlobalBus 与 Instance 内部的 Bus 有本质区别。Instance 内部的 Bus 通过 `Instance.state()` 管理订阅列表，每个 Instance 有自己独立的 Map——当用户打开项目 A 时，项目 A 的事件只分发给项目 A 的订阅者。但 GlobalBus 是进程级别的单例，所有 Instance 共享同一个 EventEmitter。

这种双层设计服务于不同的消费场景。TUI 运行在特定 Instance 中，它只需要当前项目的事件，因此通过 `Bus.subscribe` 订阅 Instance 内部的 Bus。而 SSE 端点（HTTP Server 的 `/event` 路由）需要监听所有 Instance 的事件——因为一个 OpenCode 进程可能同时服务多个项目目录，每个 SSE 客户端可能关注不同的项目。SSE 端点通过 `GlobalBus.on("event", ...)` 监听全局事件，然后根据 `directory` 字段过滤出客户端关注的项目。

`publish` 每次调用都同时向两个层面广播，其中 GlobalBus 的 `emit` 携带了 `directory: Instance.directory` 字段，让 SSE 端点能够识别事件来源的项目。这意味着即使多个项目同时活跃，事件也不会串线——桌面应用连接到项目 A 的 SSE 流，只会收到带有项目 A 目录标识的事件。

## 15.6 once 方法与 Bus 生命周期

`once` 方法实现了一次性订阅的语义，其机制值得单独说明：

```typescript
// 文件: packages/opencode/src/bus/index.ts L78-85
export function once<Definition extends BusEvent.Definition>(
  def: Definition,
  callback: (event: {
    type: Definition["type"]
    properties: z.infer<Definition["properties"]>
  }) => "done" | undefined,
) {
  const unsub = subscribe(def, (event) => {
    if (callback(event)) unsub()
  })
}
```

回调函数返回 `"done"` 字符串时，`once` 调用 `unsub()` 取消订阅。返回 `undefined`（即不返回任何值）则保持订阅继续。这比传统的 `once`（收到第一个事件就取消）更灵活——订阅者可以根据事件内容决定是否"满足条件"。例如，等待某个特定 worktree 就绪时，回调可以检查 `event.properties.name` 是否匹配目标名称，只有匹配时才返回 `"done"`，不匹配则继续等待下一个 `worktree.ready` 事件。

Bus 的生命周期与 Instance 绑定。`Instance.state()` 的第二个参数是一个析构函数，在 Instance 被释放时执行。Bus 的析构逻辑遍历通配符订阅者列表，向每个订阅者发送一个 `InstanceDisposed` 事件：

```typescript
// 文件: packages/opencode/src/bus/index.ts L23-38
const state = Instance.state(
  () => {
    const subscriptions = new Map<any, Subscription[]>()
    return { subscriptions }
  },
  async (entry) => {
    const wildcard = entry.subscriptions.get("*")
    if (!wildcard) return
    const event = {
      type: InstanceDisposed.type,
      properties: { directory: Instance.directory },
    }
    for (const sub of [...wildcard]) {
      sub(event)
    }
  },
)
```

`InstanceDisposed` 本身也是通过 `BusEvent.define` 定义的事件，类型为 `"server.instance.disposed"`。SSE 端点收到这个事件后会关闭对应的 HTTP 流，避免客户端持有无效连接。这种析构通知机制确保了资源清理的可靠性——即使某个 Instance 因为异常被回收，所有监听者也能收到通知并做出相应处理。值得注意的是，析构函数只通知通配符订阅者（`"*"`），因为精确匹配的订阅者在 Instance 释放后本身也失去了意义——它们订阅的事件类型已经不会再被发布。

## 15.7 Discriminated Union 类型生成

`payloads()` 函数是连接事件系统与 OpenAPI 文档的桥梁：

```typescript
// 文件: packages/opencode/src/bus/bus-event.ts L21-43
export function payloads() {
  return z
    .discriminatedUnion(
      "type",
      registry
        .entries()
        .map(([type, def]) => {
          return z
            .object({
              type: z.literal(type),
              properties: def.properties,
            })
            .meta({ ref: "Event" + "." + def.type })
        })
        .toArray() as any,
    )
    .meta({ ref: "Event" })
}
```

这个函数遍历 `registry` 中所有事件，将每个条目映射为带 `z.literal(type)` 判别字段的 `z.object`，最终构建出 Zod discriminated union 类型。它的作用覆盖三个层面：

1. **SSE 端点的响应 schema**：在 Server 的 `/event` 路由中，`BusEvent.payloads()` 被用作 SSE 流的 schema 定义
2. **OpenAPI 文档**：自动生成所有事件类型的 JSON Schema，客户端可据此生成类型安全的 SDK
3. **运行时验证**：确保通过 SSE 发送的事件都符合已注册的 schema

这意味着新增一个事件只需一行 `BusEvent.define()` 调用，它会自动出现在 API 文档和类型系统中。整个注册、聚合、文档生成的流水线完全自动化，开发者无需维护任何额外的配置文件或手动更新 schema。

## 15.8 错误事件的传播机制

事件总线不仅用于正常的状态更新，也承担着错误传播的职责。理解错误事件如何在系统中流动，有助于全面掌握事件驱动架构的运作方式。

当一个工具调用在 Processor 中执行失败时，Processor 捕获异常后不会直接抛出——它将错误封装为 `Session.Event.Error` 事件并发布到 Bus。Bus 将这个错误事件分发给两类接收者：本地订阅者（TUI 收到后在界面上显示错误提示）和 GlobalBus（通过 SSE 流推送给远程客户端，桌面应用据此更新状态显示）。

这种统一的错误传播路径使得所有客户端——无论是终端中的 TUI 还是远程的桌面应用——都能以一致的方式感知和展示错误。

但并非所有错误都等同处理。`Permission.RejectedError` 是一个特殊的错误类型：当用户拒绝了一个权限请求（例如拒绝文件写入权限）时，Processor 不仅发布错误事件，还会中断当前的处理循环。普通错误只影响展示层，而权限拒绝错误会实质性地改变 Processor 的控制流——它告诉系统"用户明确不想继续这个操作"，因此 Processor 应该停止当前的 tool-call 链，而不是尝试下一个工具。

## 15.9 实战：从 tool_call 到 TUI 更新的完整流程

当 AI 模型返回一个 tool_call 指令时，事件在系统中的传播路径体现了整个事件驱动架构的协作方式。以下序列图展示了一个工具调用从触发到最终在所有客户端上更新显示的完整过程：

```text
Session/Processor      Bus (Instance)      GlobalBus       TUI          SSE 端点      Desktop
  │                      │                   │              │              │              │
  │ tool-call 触发       │                   │              │              │              │
  │ updatePart(running)  │                   │              │              │              │
  │                      │                   │              │              │              │
  │  publish(PartUpdated)│                   │              │              │              │
  │─────────────────────→│                   │              │              │              │
  │                      │  本地订阅回调     │              │              │              │
  │                      │──────────────────────────────────→              │              │
  │                      │                   │              │ store 更新   │              │
  │                      │                   │              │ → UI 重绘   │              │
  │                      │                   │              │              │              │
  │                      │  GlobalBus.emit() │              │              │              │
  │                      │──────────────────→│              │              │              │
  │                      │                   │  写入 SSE 流 │              │              │
  │                      │                   │─────────────────────────────→              │
  │                      │                   │              │              │ EventSource  │
  │                      │                   │              │              │─────────────→│
  │                      │                   │              │              │              │ 更新 UI
```

流程从 Session 的 Processor 开始。Processor 解析到 LLM 返回的 tool_call 指令后，首先调用 `Session.updatePart()` 将该工具调用的状态标记为 `running`，然后通过 `Bus.publish(MessageV2.Event.PartUpdated, {...})` 发布一个 part 更新事件。

Bus 接收后执行双层分发：本地层将事件分发给 TUI 的 `SyncProvider`，更新 SolidJS store 触发界面重绘；跨 Instance 层通过 `GlobalBus.emit()` 将事件推送到 SSE 端点，远程桌面应用通过 `EventSource` 接收并更新 UI。

Processor 不知道有多少客户端在监听。未来新增 VS Code 插件只需连接 SSE 端点，无需修改 Processor 任何代码。

## 15.10 事件驱动架构的工程优势

OpenCode 的事件驱动设计带来了显著的工程优势：

**松耦合**：Session 模块不需要知道 TUI 的存在——它只管发布 `session.updated` 事件，由 TUI 自行订阅并更新界面。这使得新增一个桌面应用客户端不需要修改任何核心代码。

**可测试性**：测试 Session 逻辑时，可以通过监听事件来验证行为，而无需模拟 UI 层。同样，测试 UI 响应只需手动发布事件即可。

**多客户端同步**：SSE 端点通过 `Bus.subscribeAll()` 转发所有事件，多个 UI 客户端自然保持状态同步。这是 OpenCode 相比 Claude Code（单进程 TUI）的架构优势。

**生命周期管理**：当 Instance 被释放时，Bus 自动发送 `InstanceDisposed` 事件，SSE 连接据此关闭，不会出现悬挂的订阅。

## 15.11 本章要点

- `BusEvent.define()` 结合 Zod schema 实现类型安全的事件定义，自动注册到全局注册表，新增事件只需一行代码
- 两个泛型参数 `Type`（字面量字符串）和 `Properties`（ZodType）协同构建编译期类型安全，`publish()` 和 `subscribe()` 各自从 schema 提取输入/输出类型，实现 Discriminated Union 效果
- 事件命名遵循 `domain[.sub].action` 分层约定，如 `session.created`、`message.part.updated`、`worktree.ready`，名称反映业务语义而非 CRUD 操作
- Bus 实现发布/订阅模式，支持精确匹配和通配符订阅，返回取消函数管理生命周期；`publish` 使用扩展运算符创建订阅者快照，避免回调中修改订阅列表导致的迭代器失效
- GlobalBus 是进程级 EventEmitter 单例，与 Instance 内部 Bus 形成双层架构：本地 Bus 服务 TUI 等进程内消费者，GlobalBus 携带 `directory` 字段服务 SSE 端点等跨 Instance 消费者
- `once` 方法通过回调返回 `"done"` 实现条件性一次性订阅，比传统 `once` 更灵活
- Instance 释放时析构函数向通配符订阅者发送 `InstanceDisposed` 事件（类型 `"server.instance.disposed"`），SSE 端点据此关闭连接，避免资源泄漏
- `payloads()` 函数将所有事件聚合为 discriminated union，自动生成 OpenAPI schema，实现定义-注册-文档全流水线自动化
- 错误事件通过同一 Bus 传播，`Permission.RejectedError` 会中断 Processor 循环而非仅展示错误
- 事件驱动架构实现模块松耦合、多客户端同步和可测试性
