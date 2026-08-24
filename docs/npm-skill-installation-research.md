# Agent Skill 的 npm 安装方案调研

> 调研日期：2026-08-24
> 范围：以 Agent Skills / `SKILL.md` 为核心，关注 npm/npx 分发、安装生命周期，以及 Codex、Claude Code、Cursor、Gemini CLI 的多 Agent 适配。

## 结论先行

市场上所谓“用 npm 安装技能”，实际至少有五种不同模式，不能只看安装命令里有没有 `npx`：

1. **npm 只发布通用安装器，技能从 Git 获取**：代表是 Vercel `skills`，Baoyu 使用的 `npx skills add ...` 属于这一类。
2. **技能作为 npm 包资产发布，由同步器从 `node_modules` 暴露给 Agent**：代表是 `skills-npm`。
3. **npm 发布产品 CLI，CLI 按 Agent 生成技能与命令文件**：代表是 OpenSpec。
4. **npm 包同时携带技能和专用安装器，显式复制到各 Agent 目录**：一些独立技能包采用这一类；对 SpecWire 最合适。
5. **npm 包只是一个很薄的 Git clone 启动器**：实现简单，但 npm 版本与技能内容脱钩，通常不建议作为长期方案。

后续选型已经确定为第一种模式：

> 仓库维护标准 `skills/<name>/SKILL.md` 与自包含脚本，通过 `npx skills add holyshock31/specwire-skills` 安装。npm 只负责运行通用 `skills` 安装器，SpecWire 暂不发布自己的 npm 包。

这个选择采用 Baoyu 的轻量分发思路：

- 技能保持标准，仓库可被通用生态直接发现和按需安装；
- Agent 路径、复制/软链接、安装记录、更新和卸载交给通用安装器；
- 技能运行脚本跟随技能目录复制，不依赖一次性 `npx` 进程退出后的缓存。

如果以后确实需要严格保护本地修改、生成 Agent 原生命令或统一管理外部依赖，再演进到 OpenSpec 式自有 CLI。当前阶段不使用 `postinstall`，也不自行维护几十个 Agent 的路径注册表。

## 1. 共同底座：Agent Skills 标准

[Agent Skills 规范](https://agentskills.io/specification)定义的最小可移植单元是一个目录：必需 `SKILL.md`，可选 `scripts/`、`references/`、`assets/`。`SKILL.md` 必须包含 `name` 和 `description`；`allowed-tools` 仍是实验字段，各 Agent 支持可能不同。

因此跨 Agent 应分成两层：

- **可移植内容层**：标准 `SKILL.md`、脚本、参考资料、资产；尽量只依赖规范的公共子集。
- **宿主适配层**：安装路径、项目/用户作用域、检测方式、调用语法、命令文件格式、可选扩展元数据。

只做第一层可以“多数时候被发现”，但无法保证安装、更新、卸载和调用体验一致。

## 2. 常见实现模式

### 2.1 通用 Git/URL 安装器：Vercel `skills`

[vercel-labs/skills](https://github.com/vercel-labs/skills)通过 npm 发布通用 CLI，典型命令是：

```bash
npx skills add vercel-labs/agent-skills
npx skills add JimLiu/baoyu-skills --skill baoyu-cover-image
```

这里 npm 安装的是 `skills` 这个**安装器**，技能正文仍来自 Git 仓库、URL、归档或本地目录，并不是 npm 依赖本身。官方 README 当前列出 70 多种 Agent，支持：

- GitHub shorthand、完整 Git/GitLab URL、本地路径、直接 `SKILL.md` 和压缩包；
- 项目级和用户级安装；
- 自动检测 Agent，也可显式 `--agent`；
- 选技能、列出、更新、卸载；
- 复制或“规范副本 + Agent 目录软链接”。

从其 [`installer.ts`](https://github.com/vercel-labs/skills/blob/main/src/installer.ts) 可以看到，它会检查目标路径、防止路径穿越，并在 Windows 使用 junction；软链接失败时可退回复制。Agent 路径维护在 [`agents.ts`](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)。

它还用项目/用户级 lock 数据记录来源与内容哈希，并对远程压缩包设置下载大小、解压后大小和文件数上限。这个安全基线值得复用；但内容哈希目前主要服务来源追踪和更新，并不等于“自动保护用户安装后的本地修改”。

优点：

- 发布方只要维护标准技能仓库，接入成本最低；
- 适合公开生态、试用和按需选装；
- 一个 CLI 覆盖大量 Agent，不需要每个技能项目重复造安装器。

限制：

- 默认安装的是仓库当前内容；安装器 npm 版本和技能版本是两条独立版本线；
- Agent 路径表会滞后于厂商文档。例如该项目当前表格仍把 Codex 用户目录列为 `~/.codex/skills`，而 OpenAI 当前官方文档推荐 `~/.agents/skills`；
- 共享规范目录和软链接能减少重复文件，但会引入“删除一个 Agent 是否影响其他 Agent”“同名技能由谁拥有”等问题；
- 它主要解决文件投放，不会替产品解决各 Agent 的命令语法和专有能力差异。

适用：纯技能仓库、快速公开分发、希望直接接入 skills.sh 生态。

### 2.2 npm 资产 + `node_modules` 同步：`skills-npm`

[antfu/skills-npm](https://github.com/antfu/skills-npm)提出另一种约定：发布方把技能放进 npm 包的 `skills/<name>/SKILL.md`，消费者运行：

```bash
npm i -D skills-npm
npx skills-npm setup
```

`setup` 会把同步命令接入项目的 `prepare`，之后每次安装依赖时，从 `node_modules` 扫描技能并软链接到已检测的 Agent 目录。生成的技能名带 `npm-<package>-<skill>` 前缀，过期清理也限制在这个前缀内，形成了实用但偏弱的所有权边界：它依赖命名前缀，不是逐文件 manifest。

这种模式已有两类发布形态：

- 独立技能资产包，例如 [`@vueuse/skills`](https://github.com/vueuse/skills)；
- 产品 npm 包顺带携带技能，例如 Slidev 的 [`skills/slidev`](https://github.com/slidevjs/slidev/tree/main/skills/slidev)。

优点：

- 技能和所服务的库/CLI 使用同一个 npm semver 与 lockfile，兼容关系清晰；
- 团队安装依赖后可以自动同步；
- npm tarball、registry、缓存、完整性校验和私有源能力都可直接复用。

限制：

- 要求消费项目有 `package.json`、`node_modules` 和一个额外同步器；
- 默认是项目级、软链接式体验，不适合所有“全局工作流技能”；
- `prepare` 会修改消费项目生命周期，团队需要接受这个约定；
- 用户卸载 npm 依赖后仍需同步，才能清掉 Agent 目录中的旧链接。

适用：技能必须与某个 JS 库版本严格一致，且主要服务 Node.js 项目。

### 2.3 产品 CLI 生成器：OpenSpec

[OpenSpec](https://github.com/Fission-AI/OpenSpec)通过 npm 安装真正的产品 CLI：

```bash
npm install -g @fission-ai/openspec@latest
openspec init --tools codex,claude,cursor
openspec update
```

它不是简单复制一份通用技能。根据[支持工具文档](https://github.com/Fission-AI/OpenSpec/blob/main/docs/supported-tools.md)，OpenSpec 会按宿主生成：

- 不同技能目录；
- 不同命令目录与扩展名；
- 不同调用写法，例如 Codex 的 `$openspec-*`、Claude 的 `/opsx:*`、Cursor 的 `/opsx-*`；
- skills-only、commands-only 或混合交付；
- 共享 `.agents/skills` 的单一所有者标记和迁移逻辑。

升级 npm 包后，还要在每个项目运行 `openspec update`，刷新生成文件；[安装文档](https://github.com/Fission-AI/OpenSpec/blob/main/docs/installation.md)明确区分了“升级 CLI”和“刷新项目集成”。

优点：

- 最适合“技能只是产品 CLI 的 Agent 界面”这种场景；
- 可以把 Agent 的命令格式、调用提示和迁移纳入测试；
- 能做项目配置、工作流选择和较完整的更新管理。

限制：

- 适配器和迁移代码维护量最大；
- 生成文件可能被用户修改，更新时必须识别“自己生成的”“用户拥有的”“已经分叉的”；
- 仅维护路径表远远不够，还要维护渲染器和调用语法。

适用：有真实运行时 CLI、配置或多步工作流，并且希望不同 Agent 获得原生体验。

### 2.4 自包含 npm 技能包 + 显式安装器

代表性实现如 [`@ancher-ai/agent-skills`](https://github.com/streamify-one/ancher-agent-skills)：npm tarball 同时携带技能、安装 CLI 和 Agent 适配代码，用户显式选择 Agent 与 user/project scope，安装器负责复制、卸载、dry-run，必要时还适配不同宿主的 MCP 配置。

另一个更偏企业生命周期的参考是 [UiPath Skills](https://github.com/UiPath/skills)：CLI 与独立技能内容包配合，并用来源文件记录 ownership，让 update/uninstall 只处理自己安装的内容。这种“自有载荷 + 显式动作 + 可验证归属”比仅靠目录前缀更接近 SpecWire 应采用的形态。

其核心特征是：

- npm 包版本就是技能载荷版本；
- 安装不依赖二次 Git clone；
- `npx package install` 可以是一次性启动，但复制后的技能仍自包含；
- 只维护实际支持的少数 Agent，而不是追求一个全市场注册表。

优点：版本、载荷、安装器一致；可离线复用 npm 缓存；容易围绕自己的技能做安全的覆盖、更新和卸载策略。

限制：路径变化与 Agent 差异要自己跟进；如果每个技能包都重复实现一套通用安装器，会有重复成本。

适用：一个组织自己的工作流技能套装。SpecWire 属于这一类。

### 2.5 薄 npm 启动器 + Git clone

例如 [`agent-skills-hub`](https://github.com/agent-skills-hub/agent-skills-hub) 的 npm 包主要携带安装脚本，执行时再 clone 仓库或从临时 clone 中复制单个技能。

优点是实现极小、技能仓库始终是最新；缺点是需要 Git 和网络、npm semver 不能代表最终技能内容、离线与回滚较弱、更新和卸载容易变成删除目录再复制。除非技能载荷非常大或必须独立于安装器高频更新，否则不推荐 SpecWire 采用。

### 2.6 双渠道：标准仓库 + 原生插件

[Baoyu Skills](https://github.com/JimLiu/baoyu-skills#installation)一方面推荐 `npx skills add JimLiu/baoyu-skills`，另一方面提供 Claude 插件市场安装。它的根 `package.json` 是 private，说明这里的 `npx` 仍来自通用安装器，而不是 Baoyu 自己的 npm 技能包。

这是很值得借鉴的发布策略：同一份标准技能源，同时服务通用安装器和厂商原生插件。原生插件可以提供更好的 UI、依赖声明或连接器，但不应成为 npm 路线的前置条件。

## 3. 不同 Agent 当前如何发现技能

以下以厂商当前官方文档为准。第三方安装器的内置表可能滞后，因此适配注册表应带来源和测试，而不是永久硬编码后不再维护。

| Agent | 项目级目录 | 用户级目录 | 重要差异 |
|---|---|---|---|
| Codex | `.agents/skills/`，并从 CWD 向仓库根逐层扫描 | `~/.agents/skills/`；管理员还可用 `/etc/codex/skills` | 支持技能目录软链接；显式调用使用 `$skill-name`；可选 `agents/openai.yaml` 是 OpenAI 扩展 |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | `/skill-name`；支持插件技能、调用控制、动态上下文、子 Agent 等扩展；目录变更通常可热发现 |
| Cursor | `.agents/skills/` 或 `.cursor/skills/` | `~/.agents/skills/` 或 `~/.cursor/skills/` | 也兼容 Claude/Codex 目录；支持 `paths`、`disable-model-invocation` 等 Cursor 字段 |
| Gemini CLI | `.agents/skills/` 或 `.gemini/skills/` | `~/.agents/skills/` 或 `~/.gemini/skills/` | 自带 `gemini skills install/link/uninstall`；workspace 与 user 有优先级，激活带额外同意机制 |

依据：

- [OpenAI：Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Anthropic：Extend Claude with skills](https://code.claude.com/docs/en/skills)
- [Cursor：Agent Skills](https://cursor.com/docs/skills)
- [Gemini CLI：Managing Agent Skills](https://geminicli.com/docs/cli/using-agent-skills/)

一个有用的现实结论是：

- Codex、Cursor、Gemini 的当前官方目录有共享交集：项目 `.agents/skills`、用户 `~/.agents/skills`；
- Claude Code 仍应单独写入 `.claude/skills`；
- OpenSpec 之所以仍给 Cursor、Gemini 写厂商目录，是因为它还要生成厂商命令文件，不能只靠共享技能根。

因此，SpecWire 若只支持标准技能，可以把 Codex/Cursor/Gemini 的同一物理目标去重；若未来生成原生命令，再为各 Agent 分开渲染。

## 4. 多 Agent 支持不只是路径表

建议把适配能力拆成四层，逐层增加，而不是一次实现“全兼容”。

### 4.1 目录与作用域

每个 Agent adapter 至少描述：

```ts
interface AgentAdapter {
  id: string
  displayName: string
  projectSkillsDir(cwd: string): string
  userSkillsDir(home: string, env: NodeJS.ProcessEnv): string
  detect(): Promise<{ installed: boolean; reasons: string[] }>
  invoke(name: string): string
  restartHint?: string
  legacySkillsDirs?: string[]
}
```

规则：

- `--agent` 是事实，自动检测只是默认建议；
- 同时用“配置目录存在”和“CLI 在 PATH”两类信号；
- CI 中要求显式 `--agent`、`--scope`、`--yes`，不要猜；
- 展开并规范化实际目标路径后去重，避免 Codex/Cursor/Gemini 对 `.agents/skills` 重复覆盖。

### 4.2 内容与调用语法

基础 `SKILL.md` 只使用公共字段 `name`、`description`，把 `allowed-tools` 等宿主差异视为可选增强。

技能正文也不要假定所有 Agent 都使用同一种显式调用形式。OpenSpec 的案例表明，`$name`、`/name`、`/skill:name`、`@name` 可能并存。若正文需要自引用，建议由构建期模板注入，或用自然语言“调用 `<name>` 技能”，避免硬编码斜杠语法。

### 4.3 命令与运行时

迁移前的 SpecWire `SKILL.md` 展示了 `specwire-archive-change ...` 等裸命令，但旧 `install.sh` 只复制技能目录，并没有在 macOS/Linux 把这些命令安装进 PATH。这是 Git 分发时需要明确修复的契约。

两种可选方案：

1. **便携技能优先**：技能调用其同目录的 Node 脚本，安装包把脚本一起复制；npm 只负责安装器。这样 `npx` 进程退出后技能仍可运行。
2. **产品 CLI 优先**：要求全局安装 npm 包，由 npm `bin` 提供命令，技能只调用全局 CLI。体验接近 OpenSpec，但必须明确 CLI 与技能都要安装/更新。

建议 V1 采用方案 1，同时在全局安装时额外暴露 npm bin，给人类终端使用。npm 会为 Windows 自动生成 `.cmd`/PowerShell shim，因此不必把手写 `.cmd` 当成主要跨平台机制。

### 4.4 Agent 原生增强

等基础版稳定后，再按需生成：

- Codex 的 `agents/openai.yaml`；
- Claude plugin 元数据或专有调用控制；
- Cursor command / mode 元数据；
- Gemini command 或 extension 配置。

这些文件应从一个规范源生成，不能维护四份可漂移的手工副本。

## 5. 备选演进：自有 npm 安装器

当前选型不实现本节。以下结构仅在通用安装器的生命周期能力不能满足需求时采用。

### 5.1 包结构

```text
specwire-skills/
├── package.json
├── bin/
│   └── specwire-skills.mjs
├── src/
│   ├── agents.mjs
│   ├── install.mjs
│   ├── manifest.mjs
│   └── doctor.mjs
├── skills/
│   ├── specwire-preflight/
│   │   ├── SKILL.md
│   │   └── scripts/specwire-preflight.mjs
│   ├── specwire-initiate-change/
│   ├── specwire-review-change/
│   ├── specwire-merge-change/
│   └── specwire-archive-change/
└── README.md
```

`package.json` 的关键点：

```json
{
  "name": "@your-scope/specwire-skills",
  "type": "module",
  "bin": {
    "specwire-skills": "./bin/specwire-skills.mjs"
  },
  "files": ["bin", "src", "skills", "README.md", "LICENSE"],
  "engines": { "node": ">=20" }
}
```

可选地把 5 个工作流命令也映射到 `bin`，但要在文档中说明：它们只在全局安装或项目依赖环境中保证在 PATH；一次性 `npx ... install` 的便携技能必须继续依赖包内复制的脚本。

### 5.2 用户命令

```bash
# 交互安装
npx @your-scope/specwire-skills@latest install

# 可重复、适合脚本/CI
npx @your-scope/specwire-skills@1.0.0 install \
  --agent codex,claude,cursor,gemini \
  --scope user \
  --yes

# 生命周期
npx @your-scope/specwire-skills doctor
npx @your-scope/specwire-skills list
npx @your-scope/specwire-skills update
npx @your-scope/specwire-skills uninstall
```

推荐参数：`--agent`、`--scope user|project`、`--skill`、`--all`、`--dry-run`、`--json`、`--yes`、`--force`。

### 5.3 安装算法

1. 读取包内 `skills/*/SKILL.md`，校验目录名、frontmatter 和相对引用。
2. 解析用户显式选择；没有选择时检测 Agent 并交互确认。
3. 计算 user/project 目标，将相同的规范化绝对路径去重。
4. 检查目标：不存在则安装；由 SpecWire 管理且未改动则更新；非 SpecWire 或已被用户修改则停止，除非 `--force`。
5. 先复制到同一文件系统的临时目录，校验后原子改名，避免半安装状态。
6. 写入所有权 manifest，记录包名、版本、技能哈希、目标、scope 和对应 Agent。
7. 输出发现/重载提示，并运行轻量验证。

V1 默认使用**复制**。软链接适合本地开发，可以后增加 `--link`；作为普通用户安装默认值，它会扩大共享目标、Windows 权限和卸载语义的复杂度。

### 5.4 安全的更新与卸载

manifest 至少记录：

```json
{
  "schemaVersion": 1,
  "package": "@your-scope/specwire-skills",
  "version": "1.0.0",
  "skill": "specwire-preflight",
  "contentHash": "sha256:...",
  "agents": ["codex", "cursor", "gemini"],
  "scope": "user"
}
```

约束：

- 只删除 manifest 声明且仍匹配的技能目录；
- 不因为看到一个通用 `skills/` 目录就递归清空；
- 检测到用户修改时保留并报告，`--force` 才替换；
- 对旧版本迁移先写新目标，再清理已确认属于 SpecWire 的旧目标；
- `--dry-run` 输出精确源、目标、覆盖和删除列表。

### 5.5 不使用 `postinstall` 写 Agent 目录

显式安装优于 npm `postinstall`：

- npm 安装依赖不等于授权修改用户主目录；
- CI、容器、root 安装和 pnpm store 的上下文经常不同；
- npm 可能禁用 scripts；
- 多 Agent 和 scope 需要用户选择；
- 出错时显式 CLI 更容易诊断与回滚。

`prepare` 模式只适合 `skills-npm` 那类“消费项目主动加入同步器”的场景，不应成为 SpecWire 全局技能包的默认行为。

## 6. 当前实现

仓库已经按第一种模式整理：

- 5 个技能统一位于 `skills/<name>/`；
- 每个技能具有匹配目录名的 `name`、明确的 `description` 和自包含 `scripts/*.mjs`；
- 技能正文以相对技能根的脚本路径作为运行入口，不要求裸命令存在于 PATH；
- 根 README 提供整体安装、选择性安装、Agent 选择、更新和卸载方式；
- 目标目录、作用域、复制/链接、安装记录和更新由通用 `skills` CLI 管理。

后续可选增强：

1. 在 GitHub Actions 中校验全部 `SKILL.md` 和 Node.js 脚本；
2. 增加 macOS/Linux/Windows 的脚本级测试；
3. 根据公开使用反馈决定是否增加原生 Claude/OpenAI 插件渠道；
4. 只有在通用安装器不能满足 ownership 或内容迁移要求时，再实现第 5 节的自有 CLI。

## 7. 最终选型

| 目标 | 首选方案 |
|---|---|
| 让任何公开技能仓库快速被安装 | `npx skills add` |
| 技能必须与某个 JS 依赖版本锁定 | 包内 `skills/` + `skills-npm` |
| 技能是复杂产品 CLI 的宿主界面 | OpenSpec 式生成器 |
| 当前 SpecWire：优先低维护、GitHub 分发 | **标准技能仓库 + `npx skills add`** |
| 未来 SpecWire：需要自定义生成、强 ownership 或迁移 | 自包含 npm 包 + 显式专用安装器 |
| Claude/Codex 的原生 UI、连接器或市场分发 | 在 npm 主线之外再提供插件渠道 |

当前 SpecWire 不复制 Vercel 的 70+ Agent 注册表，也不实现 OpenSpec 的命令生成系统。范围收敛为：

- 一个位于 `skills/` 的规范技能源；
- 5 个可选择、可整体安装的技能；
- 自包含、跨平台的 Node.js 执行脚本；
- 通用 CLI 提供的 Agent 选择、user/project scope、copy/link、update/remove；
- 技能自己的前置检查负责 Node、git、glab、openspec 与认证，不擅自安装或登录外部工具。

这条路线以 Git commit/tag 版本化技能内容，并借助 npm 分发通用安装器；将来的原生插件、命令渲染或自有 npm 包可以继续复用同一份 `skills/` 源。
