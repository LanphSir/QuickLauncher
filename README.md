# QuickLauncher — 快捷桌面启动器

全局快捷键唤起的插件化工具面板（类 uTools），Windows 优先。

![tech](https://img.shields.io/badge/Electron-38-47848F) ![vue](https://img.shields.io/badge/Vue-3-42B883) ![ts](https://img.shields.io/badge/TypeScript-strict-3178C6)

## 功能

- **全局快捷键唤起**（默认 `Alt+Space`，设置中可改），失焦/Esc 自动隐藏，托盘常驻
- **搜索 + 已固定网格 + 全部应用**，键盘 ↑↓ 选择、Enter 打开
- **内置应用自设计**：web 技术开发的插件（每插件独立渲染进程，互不干扰）
- **外部程序集成**：一个 manifest 即可把任意 exe / 文件夹 / 网址接入面板
- **插件权限模型**：storage / clipboard / notify / shell 按需声明，网关逐调用校验
- 插件数据按插件 id 强制隔离；单个插件崩溃不影响主面板与其他插件

## 内置示例插件

| 插件 | 演示能力 |
|---|---|
| 剪贴板历史 | storage + clipboard + notify，轮询监听剪贴板 |
| 计算器 | 纯 UI 插件 + 键盘操作（自写表达式解析器，不用 eval） |
| 记事本 | external 型：manifest 直接集成 Windows 记事本 |

## 快速开始

```bash
pnpm install
pnpm dev        # 构建内置插件并启动开发模式
```

首次运行后程序进入托盘（右上角图标），按 `Alt+Space` 唤起面板。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发模式（主面板热更新；插件改动需重跑 `pnpm build:plugins`） |
| `pnpm typecheck` | main/preload/renderer 三端类型检查 |
| `pnpm smoke` | CDP 功能冒烟测试（需先另起 `npx electron . --remote-debugging-port=9222`） |
| `pnpm dist` | 打包 Windows 安装包 → `release/<version>/` |
| `pnpm icons` | 重新生成应用/托盘图标 |

## 文档

- [架构说明](docs/architecture.md) — 进程模型、隔离机制、插件协议
- [插件开发指南](docs/plugin-dev-guide.md) — 5 分钟写一个插件
- [功能开发记录](docs/DEVLOG.md) — 每个迭代做了什么、为什么、验证到什么程度
- [迭代路线](docs/ROADMAP.md) — 版本规划与验收标准
- [AI 开发规范](CLAUDE.md) — AI 协作守则：架构铁律、代码规范、已知坑
- 插件开发 Skill（AI 用）：`.zcode/skills/quicklauncher-plugin-dev/`，含脚手架脚本：
  `node .zcode/skills/quicklauncher-plugin-dev/scripts/scaffold.mjs <目录名> --name "显示名"`

## 目录结构

```
src/main/        主进程：窗口/托盘/快捷键/插件管理/API 网关/存储
src/preload/     两座桥：panel.ts(面板) plugin.ts(插件 window.appapi)
src/renderer/    主面板 UI（Vue3 + Pinia + Naive UI）
plugins/         内置插件（workspace 子包，独立构建）
scripts/         图标生成 / 打包插件收集 / 冒烟测试
docs/            架构、开发记录、路线图、插件开发指南
.zcode/skills/   插件开发 skill（AI 助手用）
```

## 后续路线

插件市场（在线列表/下载）· 更多内置应用（翻译/截图/OCR）· 拼音搜索 · 自动更新
