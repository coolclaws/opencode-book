---
layout: home

hero:
  name: "OpenCode 源码解析"
  text: "开源 AI 编程助手深度解析"
  tagline: 从 Agent 架构到 ACP 协议，从 TUI 终端到 Desktop 客户端，全面解读 OpenCode 的设计与实现
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-overview
    - theme: alt
      text: 查看目录
      link: /contents
    - theme: alt
      text: GitHub
      link: https://github.com/coolclaws/opencode-book

features:
  - title: TUI 原生体验
    details: 深入 Ink + React 构建的终端界面，解析键盘事件、多面板布局与流式渲染的完整实现，理解 CLI-first 的设计哲学。

  - title: 多 Agent 协作
    details: 剖析 build / plan / general / explore 四大内置 Agent，理解权限隔离、子任务委派与 Session 生命周期管理。

  - title: ACP 协议桥接
    details: 解读 Agent Client Protocol 的类型体系与消息转换，掌握 Desktop / Web 客户端与核心引擎的通信机制。

  - title: 工具与 Skill 生态
    details: 覆盖 Bash / Edit / LSP / Task 工具链，以及 SKILL.md 发现、URL 下载、多路径扫描的完整 Skill 系统。
---
