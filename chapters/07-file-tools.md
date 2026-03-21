# 第 7 章　文件操作工具：Read / Edit / Write

文件操作是 AI 编程助手最核心的能力。OpenCode 将文件操作拆分为三个独立工具——Read（读取）、Edit（编辑）、Write（写入），并辅以 Glob（文件搜索）和 Grep（内容搜索）两个检索工具。本章深入分析这五个工具的实现细节，重点剖析 Edit 工具独特的九级模糊匹配引擎。

## 7.1 Read 工具：文件读取

> **源码位置**：packages/opencode/src/tool/read.ts

Read 工具负责文件和目录的读取。它的参数定义简洁明了：

```typescript
// 文件: packages/opencode/src/tool/read.ts L23-27
parameters: z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})
```

### 7.1.1 输出截断机制

Read 工具内置了三层截断保护，防止大文件撑爆上下文窗口：

```typescript
// 文件: packages/opencode/src/tool/read.ts L15-19
const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
```

- **行数限制**：默认最多读取 `DEFAULT_READ_LIMIT = 2000` 行
- **字节限制**：最大 `MAX_BYTES = 50 * 1024`（50 KB）
- **单行截断**：每行最多 `MAX_LINE_LENGTH = 2000` 字符

当文件超出限制时，输出末尾会附加提示信息，引导模型使用 `offset` 参数继续读取后续内容。截断逻辑的实现值得关注——它同时追踪行数和字节数两个维度：

```typescript
// 文件: packages/opencode/src/tool/read.ts L163-183
for await (const text of rl) {
  lines += 1
  if (lines <= start) continue
  if (raw.length >= limit) {
    hasMoreLines = true
    continue
  }
  const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
  const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
  if (bytes + size > MAX_BYTES) {
    truncatedByBytes = true
    hasMoreLines = true
    break
  }
  raw.push(line)
  bytes += size
}
```

注意这里使用 `Buffer.byteLength` 而非 `line.length` 来计算字节数。对于包含中文或 emoji 等多字节字符的文件，一个字符可能占用 3-4 个字节，使用字符长度会严重低估实际内存消耗。

### 7.1.2 智能文件类型处理

Read 工具并非只能处理文本。它通过 MIME 类型检测来区分文件类型：

```typescript
// 文件: packages/opencode/src/tool/read.ts L121-123
const mime = Filesystem.mimeType(filepath)
const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isPdf = mime === "application/pdf"
```

图片和 PDF 文件会以 Base64 编码作为附件返回。对于二进制文件，Read 工具会采样前 4096 字节，若其中超过 30% 是不可打印字符则判定为二进制并拒绝读取。二进制检测还内置了一个快速路径——通过扩展名直接判断常见的二进制格式：

```typescript
// 文件: packages/opencode/src/tool/read.ts L236-270
async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  switch (ext) {
    case ".zip": case ".tar": case ".gz": case ".exe":
    case ".dll": case ".so": case ".class": case ".jar":
    case ".wasm": case ".pyc": case ".pyo":
      return true
    default:
      break
  }
  // ...采样检测
}
```

### 7.1.3 目录读取与文件建议

当传入路径是目录时，Read 工具自动切换为目录列表模式，返回排序后的文件和子目录条目，目录名后追加 `/` 后缀以示区分。符号链接指向目录的情况也会被正确处理。

当文件不存在时，Read 工具不会简单地抛出"文件未找到"错误，而是在同一目录下搜索名称相似的文件作为建议：

```typescript
// 文件: packages/opencode/src/tool/read.ts L56-67
const suggestions = await fs
  .readdir(dir)
  .then((entries) =>
    entries
      .filter(
        (entry) =>
          entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
      )
      .map((entry) => path.join(dir, entry))
      .slice(0, 3),
  )
  .catch(() => [])
```

这个机制使用大小写不敏感的子串匹配，最多返回 3 个建议。当模型把 `config.ts` 误记为 `Config.ts` 时，这个提示能帮助它快速纠正路径。

## 7.2 Edit 工具：智能替换引擎

> **源码位置**：packages/opencode/src/tool/edit.ts

Edit 工具是 OpenCode 文件操作的核心。与 Claude Code 的精确匹配不同，OpenCode 的 Edit 工具实现了一套九级递进式模糊匹配策略——当精确匹配失败时，自动尝试更宽松的匹配方式。

### 7.2.1 行尾符归一化

在进入匹配逻辑之前，Edit 工具先处理跨平台行尾符差异：

```typescript
// 文件: packages/opencode/src/tool/edit.ts L23-34
function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}
```

工具先检测原文件使用的行尾符（`\n` 或 `\r\n`），然后将模型提供的 `oldString` 和 `newString` 转换为相同的行尾符格式后再进行匹配。这确保了在 Windows（CRLF）和 Unix（LF）系统之间的无缝操作。

### 7.2.2 九种替换策略

`replace()` 函数按优先级依次尝试以下九种 Replacer：

```typescript
// 文件: packages/opencode/src/tool/edit.ts L638-648
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

**SimpleReplacer**（L197-199）：直接返回 `find` 本身，用于精确的 `indexOf` 匹配。

**LineTrimmedReplacer**（L201-239）：逐行对比 `trim()` 后的内容，容忍行首行尾的空白差异。实现中精确计算原文的字符偏移量，确保返回的是原文中的精确子串。

**BlockAnchorReplacer**（L241-374）：这是最精妙的策略。它仅匹配首行和末行（锚点），然后使用 Levenshtein 编辑距离算法计算中间行的相似度：

```typescript
// 文件: packages/opencode/src/tool/edit.ts L173-174
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3
```

单候选阈值为 0.0（几乎总是接受），多候选阈值为 0.3。当只找到一个候选区域时，阈值降到 0.0，意味着只要首尾锚点匹配上了，几乎不管中间行有多少差异都会接受。这看似激进，但在实践中效果很好——因为首尾锚点已经大幅缩小了搜索范围，单候选的误匹配概率极低。

Levenshtein 距离算法（L179-195）使用经典的动态规划矩阵实现，时间复杂度为 O(n*m)。对于中间行级别的短文本比较，这个开销可以忽略不计。

**WhitespaceNormalizedReplacer**（L376-418）：将所有连续空白符压缩为单个空格后比对。当单行匹配不到时，还会使用正则在原文中定位匹配子串——将搜索词按空白分割后构建 `\s+` 连接的正则模式。

**IndentationFlexibleReplacer**（L420-446）：去除最小公共缩进后比较，解决模型输出缩进不一致的问题。对于 Python 这类空白敏感的语言特别关键——模型经常会输出相对缩进正确但绝对缩进偏移了的代码。

**EscapeNormalizedReplacer**（L448-495）：处理转义字符（`\n`、`\t`、`\\`、`\$` 等）的差异。模型有时会在输出中将字面量的换行符写成 `\n` 转义序列。

**ContextAwareReplacer**（L537-593）：类似 BlockAnchorReplacer，但要求行数完全匹配，并用 50% 中间行匹配率作为阈值。

**MultiOccurrenceReplacer**（L497-509）：扫描所有精确出现位置，配合 `replaceAll` 参数使用。

### 7.2.3 唯一性约束

当非 `replaceAll` 模式下找到多个匹配时，`replace()` 函数会跳过非唯一匹配：

```typescript
// 文件: packages/opencode/src/tool/edit.ts L656-658
const lastIndex = content.lastIndexOf(search)
if (index !== lastIndex) continue // 跳过非唯一匹配
return content.substring(0, index) + newString + content.substring(index + search.length)
```

### 7.2.4 与其他工具的模糊匹配对比

不同的 AI 编程工具在处理"模型输出的代码与源文件不完全匹配"这个问题上采取了截然不同的策略。

Claude Code 采用严格的精确匹配方式：`oldString` 必须与文件中的文本逐字符一致。匹配失败时直接报错，由模型重新尝试。这种方式简单可靠，但代价是更高的重试率。

Cursor 走了一条完全不同的路线：它使用 diff 格式而非 search-replace 格式。模型直接输出统一 diff（unified diff），由编辑器的 diff 引擎应用补丁。

OpenCode 的九级递进策略代表了第三种思路：保留 search-replace 的简单交互格式，但在匹配引擎内部做渐进式模糊化。这种方式将复杂性从模型端转移到了工具端。值得注意的是，这些策略的灵感来源在源码注释中有明确标注——Cline 和 Gemini CLI 的 diff 应用逻辑都被参考和吸收：

```typescript
// 文件: packages/opencode/src/tool/edit.ts L1-4
// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts
```

## 7.3 Write 工具：文件创建

> **源码位置**：packages/opencode/src/tool/write.ts

Write 工具用于创建新文件或完整覆写现有文件。

### 7.3.1 写后 LSP 诊断

Write 工具在写入后会触发 LSP 诊断，不仅检查当前文件的错误，还会扫描最多 `MAX_PROJECT_DIAGNOSTICS_FILES = 5` 个其他受影响文件的错误：

```typescript
// 文件: packages/opencode/src/tool/write.ts L17-18
const MAX_DIAGNOSTICS_PER_FILE = 20
const MAX_PROJECT_DIAGNOSTICS_FILES = 5
```

诊断扫描遍历所有文件的 LSP 错误报告，当前文件的错误和其他文件的错误分别处理：

```typescript
// 文件: packages/opencode/src/tool/write.ts L59-72
for (const [file, issues] of Object.entries(diagnostics)) {
  const errors = issues.filter((item) => item.severity === 1)
  if (errors.length === 0) continue
  const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
  if (file === normalizedFilepath) {
    output += `\n\nLSP errors detected in this file, please fix:...`
    continue
  }
  if (projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
  projectDiagnosticsCount++
  output += `\n\nLSP errors detected in other files:...`
}
```

Edit 工具同样会在编辑完成后触发诊断流程，但只检查当前文件的错误（L146-156），不扫描其他文件。

## 7.4 Glob 与 Grep 工具

> **源码位置**：packages/opencode/src/tool/glob.ts, packages/opencode/src/tool/grep.ts

### 7.4.1 Glob 工具

Glob 工具基于 Ripgrep 的 `--files` 模式实现文件搜索，结果按修改时间降序排列，最多返回 100 个条目：

```typescript
// 文件: packages/opencode/src/tool/glob.ts L39-55
for await (const file of Ripgrep.files({
  cwd: search,
  glob: [params.pattern],
  signal: ctx.abort,
})) {
  if (files.length >= limit) {
    truncated = true
    break
  }
  const full = path.resolve(search, file)
  const stats = Filesystem.stat(full)?.mtime.getTime() ?? 0
  files.push({ path: full, mtime: stats })
}
files.sort((a, b) => b.mtime - a.mtime)
```

### 7.4.2 Grep 工具

Grep 工具调用 Ripgrep 进行正则搜索，支持 `include` 参数过滤文件类型。输出按文件分组，每个文件下列出匹配行号和内容。Grep 工具还能优雅地处理 Ripgrep 的退出码语义：

```typescript
// 文件: packages/opencode/src/tool/grep.ts L66-76
if (exitCode === 1 || (exitCode === 2 && !output.trim())) {
  return { title: params.pattern, metadata: { matches: 0, truncated: false }, output: "No files found" }
}
if (exitCode !== 0 && exitCode !== 2) {
  throw new Error(`ripgrep failed: ${errorOutput}`)
}
```

退出码 0 表示找到匹配，1 表示无匹配，2 表示部分路径不可访问但可能仍有结果——这种精细的错误码处理避免了因不可访问的符号链接而误报搜索失败。

## 7.5 文件时间锁与并发保护

> **源码位置**：packages/opencode/src/file/time.ts

OpenCode 通过 `FileTime` 模块实现了两个关键的安全机制。这个模块使用 Effect 框架实现，通过 `ServiceMap` 暴露为可依赖注入的服务。

### 7.5.1 读后写断言

每次 Read 操作会记录文件的 `mtime`、`ctime` 和 `size` 三元组。Edit 和 Write 在修改前必须调用 `FileTime.assert()` 验证文件自上次读取后未被外部修改：

```typescript
// 文件: packages/opencode/src/file/time.ts L87-101
const assert = Effect.fn("FileTime.assert")(function* (sessionID: SessionID, filepath: string) {
  if (disableCheck) return
  const reads = (yield* InstanceState.get(state)).reads
  const time = reads.get(sessionID)?.get(filepath)
  if (!time) throw new Error(`You must read file ${filepath} before overwriting it.`)
  const next = yield* stamp(filepath)
  const changed = next.mtime !== time.mtime || next.ctime !== time.ctime || next.size !== time.size
  if (!changed) return
  throw new Error(`File ${filepath} has been modified since it was last read.`)
})
```

注意这里同时比较了 `mtime`、`ctime` 和 `size` 三个维度——仅比较 `mtime` 可能在某些极端场景下不够可靠（例如某些编辑器会先删除再创建文件，导致 `ctime` 变化但 `mtime` 可能相同）。

### 7.5.2 文件级写锁

`withLock()` 使用 Effect 框架的 `Semaphore` 实现文件级写锁，确保同一文件的并发编辑操作被序列化执行：

```typescript
// 文件: packages/opencode/src/file/time.ts L103-105
const withLock = Effect.fn("FileTime.withLock")(function* <T>(filepath: string, fn: () => Promise<T>) {
  return yield* Effect.promise(fn).pipe((yield* getLock(filepath)).withPermits(1))
})
```

每个文件路径对应一个 `Semaphore.makeUnsafe(1)` 信号量（L71），即互斥锁。当多个 Agent 并发编辑同一个文件时，写锁确保这些编辑按先到先得的顺序依次执行。

### 7.5.3 外部目录保护

所有文件操作工具在执行前都会调用 `assertExternalDirectory` 检查路径是否在项目目录之外：

```typescript
// 文件: packages/opencode/src/tool/external-directory.ts L12-32
export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return
  if (options?.bypass) return
  if (Instance.containsPath(target)) return
  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? target : path.dirname(target)
  const glob = path.join(parentDir, "*").replaceAll("\\", "/")
  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: { filepath: target, parentDir },
  })
}
```

## 7.6 本章要点

- **Read 工具**内置三层截断保护（行数、字节、单行长度），支持图片/PDF 的 Base64 附件返回，并自动检测二进制文件，文件不存在时提供相似文件名建议
- **Edit 工具**实现了九种递进式替换策略，从精确匹配到 Levenshtein 相似度匹配，灵感来源于 Cline 和 Gemini CLI 的实现
- **Write 工具**在写入后触发全项目 LSP 诊断，扫描最多 5 个受影响文件的 Error 级别诊断
- **FileTime 机制**通过 mtime/ctime/size 三元组断言和 Effect Semaphore 写锁双重保护，防止文件竞态和过期覆写
- Glob 和 Grep 工具均基于 Ripgrep 实现，结果按修改时间排序，内置 100 条结果上限
