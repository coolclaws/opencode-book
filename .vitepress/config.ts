import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenCode 源码解析',
  description: '开源 AI 编程助手深度解析 —— 从 Agent 架构到 ACP 协议，全面解读 OpenCode 的设计与实现',
  lang: 'zh-CN',

  base: '/',

  head: [
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'OpenCode 源码解析' }],
    ['meta', { property: 'og:description', content: '开源 AI 编程助手深度解析 —— 从 Agent 架构到 ACP 协议' }],
  ],

  themeConfig: {
    logo: { src: '/logo.png', alt: 'OpenCode' },
    nav: [
      { text: '开始阅读', link: '/chapters/01-overview' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/coolclaws/opencode-book' },
    ],

    sidebar: [
      {
        text: '前言',
        items: [
          { text: '关于本书', link: '/' },
          { text: '完整目录', link: '/contents' },
        ],
      },
      {
        text: '第一部分：宏观认知',
        collapsed: false,
        items: [
          { text: '第 1 章　项目概览与设计哲学', link: '/chapters/01-overview' },
          { text: '第 2 章　仓库结构与模块依赖', link: '/chapters/02-repo-structure' },
          { text: '第 3 章　快速上手与开发环境', link: '/chapters/03-quick-start' },
        ],
      },
      {
        text: '第二部分：Agent 核心',
        collapsed: false,
        items: [
          { text: '第 4 章　Agent 架构与内置角色', link: '/chapters/04-agent' },
          { text: '第 5 章　Session 生命周期', link: '/chapters/05-session' },
          { text: '第 6 章　Context 压缩与 Token 管理', link: '/chapters/06-compaction' },
        ],
      },
      {
        text: '第三部分：工具集',
        collapsed: false,
        items: [
          { text: '第 7 章　文件操作工具：Read / Edit / Write', link: '/chapters/07-file-tools' },
          { text: '第 8 章　执行与集成工具：Bash / Task / LSP', link: '/chapters/08-exec-tools' },
          { text: '第 9 章　工具注册机制与权限模型', link: '/chapters/09-tool-registry' },
        ],
      },
      {
        text: '第四部分：Skills 系统',
        collapsed: false,
        items: [
          { text: '第 10 章　Skill 架构与加载机制', link: '/chapters/10-skill-arch' },
          { text: '第 11 章　内置 Skill 与自定义扩展', link: '/chapters/11-skill-custom' },
        ],
      },
      {
        text: '第五部分：ACP 协议',
        collapsed: false,
        items: [
          { text: '第 12 章　ACP 协议设计与类型体系', link: '/chapters/12-acp-design' },
          { text: '第 13 章　ACP Agent 实战', link: '/chapters/13-acp-practice' },
        ],
      },
      {
        text: '第六部分：Server 与 Bus',
        collapsed: false,
        items: [
          { text: '第 14 章　HTTP Server 与 API 设计', link: '/chapters/14-server' },
          { text: '第 15 章　事件总线与消息驱动', link: '/chapters/15-bus' },
        ],
      },
      {
        text: '第七部分：高级功能',
        collapsed: false,
        items: [
          { text: '第 16 章　Git Worktree 隔离执行', link: '/chapters/16-worktree' },
          { text: '第 17 章　MCP 集成与扩展', link: '/chapters/17-mcp' },
          { text: '第 18 章　Provider 抽象与多模型支持', link: '/chapters/18-provider' },
        ],
      },
      {
        text: '第八部分：界面与生态',
        collapsed: false,
        items: [
          { text: '第 19 章　TUI 终端界面', link: '/chapters/19-tui' },
          { text: '第 20 章　Desktop 与 Web 客户端', link: '/chapters/20-desktop-web' },
          { text: '第 21 章　Plugin 系统与社区生态', link: '/chapters/21-plugin' },
        ],
      },
      {
        text: '第九部分：配置与生产化',
        collapsed: false,
        items: [
          { text: '第 22 章　配置体系与生产部署', link: '/chapters/22-config-deploy' },
        ],
      },
      {
        text: '附录',
        collapsed: true,
        items: [
          { text: '附录 A：推荐阅读路径', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B：工具速查表', link: '/chapters/appendix-b-tool-reference' },
          { text: '附录 C：术语表', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/coolclaws/opencode-book' },
    ],

    footer: {
      message: '基于 CC BY-NC-SA 4.0 协议发布',
      copyright: 'Copyright © 2025-present',
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
