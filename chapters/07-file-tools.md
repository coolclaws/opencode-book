# 第 7 章　文件操作工具：Read / Edit / Write

文件操作是 AI 编程助手最核心的能力。OpenCode 将文件操作拆分为三个独立工具——Read（读取）、Edit（编辑）、Write（写入），并辅以 Glob（文件搜索）和 Grep（内容搜索）两个检索工具。本章深入分析这五个工具的实现细节，重点剖析 Edit 工具独特的九级模糊匹配引擎。

## 7.1 Read 工具：文件读取

> **源码位置**：packages/opencode/src/tool/read.ts

Read 工具负责文件和目录的读取。它的参数定义简洁明了：

```typescript
parameters: z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})
```

### 7.1.1 输出截断机制

Read 工具内置了三层截断保护，防止大文件撑爆上下文窗口：

- **行数限制**：默认最多读取 `DEFAULT_READ_LIMIT = 2000` 行
- **字节限制**：最大 `MAX_BYTES = 50 * 1024`（50 KB）
- **单行截断**：每行最多 `MAX_LINE_LENGTH = 2000` 字符

当文件超出限制时，输出末尾会附加提示信息，引导模型使用 `offset` 参数继续读取后续内容。

### 7.1.2 智能文件类型处理

Read 工具并非只能处理文本。它通过 MIME 类型检测来区分文件类型：

```typescript
const mime = Filesystem.mimeType(filepath)
const isImage = mime.startsWith("image/") && mime !== "image/svg+xml"
const isPdf = mime === "application/pdf"
```

图片和 PDF 文件会以 Base64 编码作为附件返回。对于二进制文件，Read 工具会采样前 4096 字节，若其中超过 30% 是不可打印字符则判定为二进制并拒绝读取。

### 7.1.3 目录读取

当传入路径是目录时，Read 工具自动切换为目录列表模式，返回排序后的文件和子目录条目，目录名后追加 `/` 后缀以示区分。

## 7.2 Edit 工具：智能替换引擎

> **源码位置**：packages/opencode/src/tool/edit.ts

Edit 工具是 OpenCode 文件操作的核心。与 Claude Code 的精确匹配不同，OpenCode 的 Edit 工具实现了一套九级递进式模糊匹配策略——当精确匹配失败时，自动尝试更宽松的匹配方式。

### 7.2.1 工具参数

```typescript
parameters: z.object({
  filePath: z.string().describe("The absolute path to the file to modify"),
  oldString: z.string().describe("The text to replace"),
  newString: z.string().describe("The text to replace it with"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString"),
})
```

### 7.2.2 九种替换策略

`replace()` 函数按优先级依次尝试以下九种 Replacer：

```typescript
for (const replacer of [
  SimpleReplacer,          // 1. 精确匹配
  LineTrimmedReplacer,     // 2. 行级 trim 匹配
  BlockAnchorReplacer,     // 3. 首尾锚点 + Levenshtein 相似度
  WhitespaceNormalizedReplacer, // 4. 空白符归一化
  IndentationFlexibleReplacer,  // 5. 缩进弹性匹配
  EscapeNormalizedReplacer,     // 6. 转义字符归一化
  TrimmedBoundaryReplacer,      // 7. 边界 trim 匹配
  ContextAwareReplacer,         // 8. 上下文锚点匹配
  MultiOccurrenceReplacer,      // 9. 多重出现匹配
]) {
  for (const search of replacer(content, oldString)) { ... }
}
```

**SimpleReplacer**：直接返回 `find` 本身，用于精确的 `indexOf` 匹配。

**LineTrimmedReplacer**：逐行对比 `trim()` 后的内容，容忍行首行尾的空白差异。

**BlockAnchorReplacer**：这是最精妙的策略。它仅匹配首行和末行（锚点），然后使用 Levenshtein 编辑距离算法计算中间行的相似度。单候选阈值为 0.0（几乎总是接受），多候选阈值为 0.3：

```typescript
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3
```

**WhitespaceNormalizedReplacer**：将所有连续空白符压缩为单个空格后比对，还支持用正则在原文中定位匹配子串。

**IndentationFlexibleReplacer**：去除最小公共缩进后比较，解决模型输出缩进不一致的问题。

**EscapeNormalizedReplacer**：处理转义字符（`\n`、`\t`、`\\` 等）的差异。

**TrimmedBoundaryReplacer**：对整个搜索文本执行 `trim()` 后再匹配。

**ContextAwareReplacer**：类似 BlockAnchorReplacer，但要求行数完全匹配，并用 50% 中间行匹配率作为阈值。

**MultiOccurrenceReplacer**：扫描所有精确出现位置，配合 `replaceAll` 参数使用。

### 7.2.3 唯一性约束

当非 `replaceAll` 模式下找到多个匹配时，`replace()` 函数会抛出错误，要求模型提供更多上下文来唯一定位：

```typescript
const lastIndex = content.lastIndexOf(search)
if (index !== lastIndex) continue // 跳过非唯一匹配
```

## 7.3 Write 工具：文件创建

> **源码位置**：packages/opencode/src/tool/write.ts

Write 工具用于创建新文件或完整覆写现有文件。与 Edit 的增量修改不同，Write 接收完整的文件内容：

```typescript
parameters: z.object({
  content: z.string().describe("The content to write to the file"),
  filePath: z.string().describe("The absolute path to the file to write"),
})
```

Write 工具在写入后会触发 LSP 诊断，不仅检查当前文件的错误，还会扫描最多 `MAX_PROJECT_DIAGNOSTICS_FILES = 5` 个其他受影响文件的错误，帮助模型及时发现连锁问题。

## 7.4 Glob 与 Grep 工具

> **源码位置**：packages/opencode/src/tool/glob.ts, packages/opencode/src/tool/grep.ts

### 7.4.1 Glob 工具

Glob 工具基于 Ripgrep 的 `--files` 模式实现文件搜索，结果按修改时间降序排列，最多返回 100 个条目：

```typescript
for await (const file of Ripgrep.files({
  cwd: search,
  glob: [params.pattern],
  signal: ctx.abort,
})) {
  if (files.length >= limit) { truncated = true; break }
  // 获取 mtime 用于排序
}
files.sort((a, b) => b.mtime - a.mtime)
```

### 7.4.2 Grep 工具

Grep 工具调用 Ripgrep 进行正则搜索，支持 `include` 参数过滤文件类型。结果同样按修改时间排序，最多返回 100 条匹配，每行最多 2000 字符。

## 7.5 文件时间锁与并发保护

> **源码位置**：packages/opencode/src/file/time.ts

OpenCode 通过 `FileTime` 模块实现了两个关键的安全机制：

### 7.5.1 读后写断言

每次 Read 操作会记录 `(sessionID, filePath) -> timestamp`。Edit 和 Write 在修改前必须调用 `FileTime.assert()` 验证文件自上次读取后未被外部修改：

```typescript
export async function assert(sessionID: string, filepath: string) {
  const time = get(sessionID, filepath)
  if (!time) throw new Error(`You must read file ${filepath} before overwriting it.`)
  const mtime = Filesystem.stat(filepath)?.mtime
  // 允许 50ms 容差（Windows NTFS 时间戳精度）
  if (mtime && mtime.getTime() > time.getTime() + 50) {
    throw new Error(`File ${filepath} has been modified since it was last read.`)
  }
}
```

### 7.5.2 文件级写锁

`withLock()` 使用 Promise 链实现了文件级的写锁，确保同一文件的并发编辑操作被序列化执行：

```typescript
export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = current.locks.get(filepath) ?? Promise.resolve()
  let release: () => void = () => {}
  const nextLock = new Promise<void>((resolve) => { release = resolve })
  const chained = currentLock.then(() => nextLock)
  current.locks.set(filepath, chained)
  await currentLock // 等待前序操作完成
  try { return await fn() }
  finally { release() } // 释放锁，允许后续操作
}
```

这种设计避免了传统互斥锁，完全基于 JavaScript 的 Promise 机制实现协作式并发控制。

## 7.6 实战：Edit 工具的模糊匹配如何工作

假设源文件内容为：

```typescript
function greet(name: string) {
    console.log("Hello, " + name);
    return true;
}
```

当模型提交的 `oldString` 存在缩进偏差时：

```typescript
// oldString（模型输出，缩进错误）
"function greet(name: string) {\n  console.log(\"Hello, \" + name);\n  return true;\n}"
```

替换引擎的执行过程如下：

1. **SimpleReplacer**：精确匹配失败（缩进从 4 空格变成了 2 空格）
2. **LineTrimmedReplacer**：逐行 `trim()` 后比较，每行内容相同，匹配成功

引擎提取原文中对应区域的精确文本（保留原始 4 空格缩进），用 `newString` 替换之。这样即使模型输出的缩进不够精确，编辑操作仍能正确执行。

对比其他工具：Claude Code 要求 `oldString` 精确匹配（包括空白），匹配失败则直接报错；Cursor 使用 diff 格式而非 search-replace。OpenCode 的九级递进策略在容错性上明显领先。

## 7.7 本章要点

- **Read 工具**内置三层截断保护（行数、字节、单行长度），支持图片/PDF 的 Base64 附件返回，并自动检测二进制文件
- **Edit 工具**实现了九种递进式替换策略，从精确匹配到 Levenshtein 相似度匹配，极大提高了 AI 编辑的成功率
- **Write 工具**在写入后触发全项目 LSP 诊断，检测跨文件的连锁错误
- **FileTime 机制**通过"读后写断言"和"Promise 链写锁"双重保护，防止文件竞态和过期覆写
- Glob 和 Grep 工具均基于 Ripgrep 实现，结果按修改时间排序，内置 100 条结果上限
