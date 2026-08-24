# SpecWire Skills

面向 SpecWire 变更管线的一组 Agent Skills：前置体检、发起变更、验证审核、许可合并和任务归档。

技能采用开放的 [`SKILL.md`](https://agentskills.io/specification) 目录格式，通过通用 [`skills`](https://github.com/vercel-labs/skills) CLI 从 GitHub 安装。本仓库本身不是 npm 包；`npx` 获取的是通用安装器。

## 安装

交互选择技能、Agent 和安装方式：

```bash
npx skills add holyshock31/specwire-skills
```

只安装部分技能：

```bash
npx skills add holyshock31/specwire-skills \
  --skill specwire-preflight \
  --skill specwire-initiate-change
```

安装到指定 Agent：

```bash
npx skills add holyshock31/specwire-skills \
  --agent codex \
  --agent claude-code
```

非交互复制全部技能到 Codex：

```bash
npx skills add holyshock31/specwire-skills \
  --skill '*' \
  --agent codex \
  --copy \
  --yes
```

私有仓库使用 Git 或 GitHub CLI 已配置的凭据；公开仓库无需登录。

## 技能

| 技能 | 用途 | 主要副作用 |
|---|---|---|
| `specwire-preflight` | 检查工具链、认证、网络、SSH、仓库和阶段前置 | 只读探测 |
| `specwire-initiate-change` | 创建 change 分支、提交并推送、创建 GitLab Issue | 写 Git 和 GitLab |
| `specwire-review-change` | 拉取 MR、创建隔离 worktree、运行项目测试并出具报告 | 创建本地 worktree |
| `specwire-merge-change` | 校验并合并指定 MR，清理评审 worktree | 合并 GitLab MR |
| `specwire-archive-change` | 归档已合并 change、推送归档事件并验证闭环 | 提交并推送默认分支 |

安装后直接用自然语言要求 Agent 执行对应任务，也可以使用宿主支持的显式技能调用语法。

## 前置依赖

- Node.js 18 或更高版本；
- Git；
- GitLab CLI `glab`，并已登录目标实例；
- OpenSpec CLI；
- 对目标仓库具有所需的读取、推送和合并权限。

各技能在执行实质操作前仍会检查相应前置条件。`specwire-preflight` 只做诊断，不自动修复环境。

## 管理已安装技能

```bash
npx skills list
npx skills update
npx skills remove
```

`skills update` 和 `skills remove` 会根据安装记录交互选择作用域与技能。完整参数以 `npx skills --help` 为准。

## 仓库结构

```text
skills/
├── specwire-preflight/
├── specwire-initiate-change/
├── specwire-review-change/
├── specwire-merge-change/
└── specwire-archive-change/
```

每个目录包含必需的 `SKILL.md` 和自包含 Node.js 脚本。脚本由 Agent 解析技能目录后以 `node` 执行，不要求额外的全局 SpecWire 命令。

实现方式的选型与多 Agent 调研见 [npm 技能安装方案调研](docs/npm-skill-installation-research.md)。
