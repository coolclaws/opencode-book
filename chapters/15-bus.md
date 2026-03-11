# 第 15 章　事件总线与消息驱动

OpenCode 的各个子系统之间通过事件总线进行通信，而非直接调用。这种消息驱动架构实现了模块间的松耦合，使得 Session 层的变化能自动传播到 TUI、SSE 端点和桌面应用。本章深入分析事件总线的类型安全设计和运作机制。

## 15.1 BusEvent.define()：类型安全的事件定义

> **源码位置**：packages/opencode/src/bus/bus-event.ts

事件系统的核心是 `BusEvent.define()` 函数，它结合 Zod schema 实现了类型安全的事件定义：

```typescript
import z from "zod"
import type { ZodType } from "zod"

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

## 15.2 事件注册表

整个 OpenCode 系统定义了丰富的事件类型，覆盖所有核心业务领域：

```typescript
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

事件命名遵循 `domain.action` 约定，层次分明。每个事件的 `properties` 都有完整的 Zod schema 约束，确保发布和订阅两端的数据结构一致。

## 15.3 事件发布与订阅

> **源码位置**：packages/opencode/src/bus/index.ts

Bus 模块实现了经典的发布/订阅模式，同时与 Instance 生命周期绑定：

```typescript
export namespace Bus {
  // 发布事件：类型安全，载荷必须匹配 Definition 的 schema
  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = { type: def.type, properties }
    const pending = []
    // 分发给精确匹配和通配符订阅者
    for (const key of [def.type, "*"]) {
      const match = state().subscriptions.get(key)
      for (const sub of match ?? []) {
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

关键设计点：

- **类型推导**：`publish` 的 `properties` 参数类型由 `Definition` 泛型自动推导，传错字段会在编译时报错
- **双层广播**：本地 `subscriptions` 用于 Instance 内部通信，`GlobalBus` 用于跨 Instance 通信（如 Server 的 SSE 推送）
- **返回取消函数**：`subscribe` 返回一个 `() => void` 函数，调用即取消订阅

Bus 的状态通过 `Instance.state()` 管理，当 Instance 被释放时，会自动向所有通配符订阅者发送 `InstanceDisposed` 事件，确保资源清理。

## 15.4 Discriminated Union 类型生成

`payloads()` 函数是连接事件系统与 OpenAPI 文档的桥梁：

```typescript
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

这个函数遍历 `registry` 中所有已注册的事件，生成一个 Zod discriminated union 类型。其作用是：

1. **SSE 端点的响应 schema**：在 Server 的 `/event` 路由中，`BusEvent.payloads()` 被用作 SSE 流的 schema 定义
2. **OpenAPI 文档**：自动生成所有事件类型的 JSON Schema，客户端可据此生成类型安全的 SDK
3. **运行时验证**：确保通过 SSE 发送的事件都符合已注册的 schema

这意味着新增一个事件只需一行 `BusEvent.define()` 调用，它会自动出现在 API 文档和类型系统中。

## 15.5 事件驱动架构的优势

OpenCode 的事件驱动设计带来了显著的工程优势：

**松耦合**：Session 模块不需要知道 TUI 的存在——它只管发布 `session.updated` 事件，由 TUI 自行订阅并更新界面。这使得新增一个桌面应用客户端不需要修改任何核心代码。

**可测试性**：测试 Session 逻辑时，可以通过监听事件来验证行为，而无需模拟 UI 层。同样，测试 UI 响应只需手动发布事件即可。

**多客户端同步**：SSE 端点通过 `Bus.subscribeAll()` 转发所有事件，多个 UI 客户端自然保持状态同步。这是 OpenCode 相比 Claude Code（单进程 TUI）的架构优势。

**生命周期管理**：当 Instance 被释放时，Bus 自动发送 `InstanceDisposed` 事件，SSE 连接据此关闭，不会出现悬挂的订阅。

## 15.6 实战：追踪一个 Session 事件的传播路径

当用户在 TUI 中发送一条消息，事件传播路径如下：

1. **消息处理**：Session 模块处理用户输入，调用 LLM 获取响应
2. **事件发布**：`Bus.publish(MessageV2.Event.Updated, { ... })` 发布消息更新事件
3. **本地订阅者**：Instance 内的 TUI 订阅回调收到通知，更新界面渲染
4. **GlobalBus 广播**：事件通过 `GlobalBus.emit("event", ...)` 发送到全局总线
5. **SSE 转发**：Server 的 `/event` 端点通过 `Bus.subscribeAll()` 监听到事件，写入 SSE 流
6. **远程客户端**：桌面应用通过 SSE 连接收到事件，同步更新 UI

整个过程中，消息处理逻辑与 UI 更新完全解耦。如果未来新增一个 VS Code 插件客户端，只需连接 SSE 端点即可获得实时更新，无需修改任何核心代码。

## 15.7 本章要点

- `BusEvent.define()` 结合 Zod schema 实现类型安全的事件定义，自动注册到全局注册表
- Bus 实现发布/订阅模式，支持精确匹配和通配符订阅，返回取消函数管理生命周期
- `payloads()` 函数将所有事件聚合为 discriminated union，自动生成 OpenAPI schema
- 事件驱动架构实现模块松耦合、多客户端同步和可测试性
- 双层广播（Instance 本地 + GlobalBus）支持跨实例通信
