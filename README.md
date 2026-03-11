# OpenCode 源码解析

> 开源 AI 编程助手深度解析 —— 从 Agent 架构到 ACP 协议，全面解读 OpenCode 的设计与实现

## 关于本书

[OpenCode](https://github.com/anomalyco/opencode) 是一个开源的 AI 编程助手，使用 TypeScript 构建，以 CLI-first 的设计哲学提供终端原生的编程体验。它支持多种 LLM Provider（Anthropic、OpenAI、Google 等），通过 ACP（Agent Client Protocol）协议桥接 Desktop 和 Web 客户端。

本书从源码层面系统梳理 OpenCode 的架构设计与实现细节，适合希望：

- 理解 AI 编程助手内部工作原理的开发者
- 学习 Agent 系统、Session 管理、工具生态设计的工程师
- 希望基于 OpenCode 进行深度定制或贡献代码的参与者
- 对 ACP 协议、MCP 集成、Context 压缩感兴趣的技术人员

## 目录

详见 [CONTENTS.md](./contents.md)

全书共 **22 章 + 3 附录**，分九个部分：

| 部分 | 章节 | 核心议题 |
|------|------|---------|
| 第一部分：宏观认知 | Ch 1–3 | 设计哲学、仓库结构、快速上手 |
| 第二部分：Agent 核心 | Ch 4–6 | Agent 架构、Session 系统、Context 压缩 |
| 第三部分：工具集 | Ch 7–9 | 文件操作、执行与集成、工具注册与权限 |
| 第四部分：Skills 系统 | Ch 10–11 | Skill 架构、内置与自定义 |
| 第五部分：ACP 协议 | Ch 12–13 | 协议设计、实战 |
| 第六部分：Server 与 Bus | Ch 14–15 | HTTP Server、事件总线 |
| 第七部分：高级功能 | Ch 16–18 | Git Worktree、MCP 集成、Provider 系统 |
| 第八部分：界面与生态 | Ch 19–21 | TUI、Desktop/Web、Plugin 系统 |
| 第九部分：配置与生产化 | Ch 22 | 配置体系与部署 |

## 在线阅读

[https://opencode-book.myhubs.dev](https://opencode-book.myhubs.dev)

## License

本书内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证。
OpenCode 项目本身采用 MIT 许可证。
