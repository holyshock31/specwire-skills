---
name: specwire-review-change
description: 验证审核——列出 MR 让人选 / 评审指定 MR（校验元数据、拉分支、worktree、跑测试，输出验证报告与人工闸门清单）。用户要评审/验证 OpenSpec change 的 MR 时使用。
---

# specwire-review-change（验证审核）

## 是什么

把「验证审核一个 MR」固化为一条命令：列出 MR → 评审（校验元数据 → 拉分支 → worktree → 测试）→ 验证报告 + 人工闸门清单。技能不代做视觉实测与合并。

## 执行入口

先将 `scripts/specwire-review-change.mjs` 相对于本 `SKILL.md` 所在目录解析为绝对路径，再执行：

```bash
node "<技能目录>/scripts/specwire-review-change.mjs"                          # 列出打开中 MR（选定后带 --mr 再跑）
node "<技能目录>/scripts/specwire-review-change.mjs" --mr <编号>              # 评审该 MR（change_id 从描述自动提取）
node "<技能目录>/scripts/specwire-review-change.mjs" <change-id> --mr <编号>  # 严格校验（MR 必须关联该 change-id，防审错）
```

可选：`--repo <group/project>`（覆盖 remote 推断）；`--diff`（控制台输出完整 diff）；`--diff-file <path>`（只输出某文件 diff）；`--allow-non-main`（显式允许非 main 目标）；`--allow-unlinked`（显式允许未关联 change-id）。

## 参数收集与异常确认

脚本保持非交互；由 Agent 负责选择与追问。先用只读信息推断，已明确的不要再问，多个异常合并成一次询问。

1. 用户未给 MR 编号时，先运行无 `--mr` 的列表模式，把打开中的 MR 作为选项展示给用户；只有唯一候选且用户指代清楚时才可直接采用。
2. 用户给了 change-id 时一并传入，启用严格关联校验；未给则让脚本从 MR 描述提取。
3. MR 目标不是 `main` 时停止并说明源/目标分支；只有用户明确确认仍要评审，才追加 `--allow-non-main`。
4. MR 未声明 `SpecWire-Change` / `change_id` 时停止；询问补充 MR 元数据还是继续评审，只有明确选择继续时才追加 `--allow-unlinked`。
5. 默认只输出 diff 摘要和入口。仅当用户要求完整差异或指定文件时使用 `--diff` / `--diff-file`，不为此例行追问。

用户要求“评审/验证”已授权 fetch、创建隔离 worktree 和运行仓库已有测试；这不包含合并授权。不要在本技能中合并 MR。

## 意图映射（自然语言 → 参数）

| 用户说 | 参数 |
|---|---|
| 先看看有哪些 MR | （无参数） |
| 验证审核那个 MR | `--mr <编号>` |
| 这个变更的 MR（严格校验关联） | `<change-id> --mr <编号>` |
| 项目推断不对 | `--repo <group/project>` |
| 想看完整差异内容 | `--diff` / `--diff-file <路径>` |
| 确认评审非 main 目标 | `--allow-non-main` |
| 确认评审未关联 change 的 MR | `--allow-unlinked` |

## 流程

1. 列 MR（无参）；或校验 MR 元数据（目标 main、描述含 `SpecWire-Change` / `change_id` 并提取 change-id）
2. fetch 源分支 → 输出改动范围（`diff vs origin/main`）+ diff 入口（网页/终端/代码三处）
3. worktree 拉取（项目内 `.worktrees/review-<编号>`，独立目录 + 复用 node_modules；自动把 `.worktrees/` 追加到 `.git/info/exclude` 保证 `git status` 不污染）→ 跑 `lint` / `typecheck` / `test` / `e2e` / `smoke`（package.json 存在才跑）
4. 输出验证报告：MR 摘要 / 改动范围与 diff 入口 / **分级测试结果** / **自动 base 对照** / 处置建议 / 人工闸门清单

### 测试分级（通用判定规则）

- **强门**（确定性 + 通常隔离）：`lint` / `typecheck` / `test` / `e2e`——FAIL 大概率真回归 → 打回优先
- **弱门**（环境态敏感）：`smoke`——FAIL 先判环境/状态 → **自动 base 对照**（检出不含 MR 的 `origin/<target>` 跑同一测试）：base 同败 = 环境态（与 MR 无关）；base 通过 = 真回归
- **无质量门**（仓库无脚本）：显式报告并升级人工检查清单，不静默视为通过

## 人工闸门（技能不代做）

- **视觉实测**：`cd .worktrees/review-<编号> && npm start` → 按变更意图验证（代码已 checkout 在该目录）
- **合并许可**：`glab mr merge <编号> --repo <project>`（人执行或显式授权 agent）
- **审后清理**：`git worktree remove .worktrees/review-<编号>`

## 前置检查（调用前核实）

- git、glab 已安装且 `glab auth status` 已登录目标实例
- **已知问题（本机特殊——仅 gitlab.specwire.local 自托管实例存在 .local 域名解析问题；其他实例无需 GODEBUG=netdns=go）**：glab 解析 `gitlab.specwire.local` 需 `export GODEBUG=netdns=go`（同 specwire-initiate-change）
- 当前仓库有 GitLab remote（如 `origin` → personal/webdeck）

## 输入契约

- `--mr`：数字编号（评审模式必填；不给 = 列 MR 模式）
- change-id（可选）：kebab-case；给出则严格校验 MR 关联，不匹配直接报错（零副作用——校验先于 fetch/worktree）
