---
name: specwire-merge-change
description: 许可合并——校验 MR 关联与状态 → glab mr merge → 清理评审 worktree → 输出归档前指引。用户验证通过、许可合并 OpenSpec change 的 MR 时使用。
---

# specwire-merge-change（许可合并）

## 是什么

把「许可合并一个 MR」固化为一条命令：校验（状态 + 关联）→ `glab mr merge` → 清理评审 worktree → 输出归档前指引。调用即 = 合并许可；技能不改 change 分支、不执行规格归档。

## 执行入口

先将 `scripts/specwire-merge-change.mjs` 相对于本 `SKILL.md` 所在目录解析为绝对路径，再执行：

```bash
node "<技能目录>/scripts/specwire-merge-change.mjs" <change-id> --mr <编号> [--squash] [--dry-run] [--repo <group/project>]
```

- `--squash`：压缩合并（默认常规 merge commit，保留实现提交与 trailer——**首次建议不加**，见下）
- `--dry-run`：只预览将执行的命令与清理清单，不执行
- `--repo`：覆盖 remote 推断

## 意图映射（自然语言 → 参数）

| 用户说 | 参数 |
|---|---|
| 验证通过了，合并这个 MR | `<change-id> --mr <编号>` |
| 压缩合并（历史清爽） | 追加 `--squash` |
| 先看看会做什么 | 追加 `--dry-run` |

## 流程

1. 校验：MR 存在且 `opened`、目标 main、描述/标题必须含 change-id（**强校验——防合并错 MR**）
2. 执行：`glab mr merge <编号> --repo <project> --yes [--squash]`
3. 清理：`git worktree remove .worktrees/review-<mr>` 与 `base-<mr>`（幂等，失败不阻断）
4. 输出归档前指引（同步 main → `openspec archive` → archived trailer push）

## 边界（与相邻技能）

- **不做验证判定**（specwire-review-change 的职责）——本技能前提是已验证通过
- **不归档规格**（specwire-archive-change 的职责）——只输出指引
- **不删 change 分支**（`change/feat-*`）——保留溯源；源分支删除由 MR/GitLab 设置控制，本技能不删

## 前置检查（调用前核实）

- git、glab 已安装且 `glab auth status` 已登录目标实例
- **已知问题（本机特殊——仅 gitlab.specwire.local 自托管实例存在 .local 域名解析问题；其他实例无需 GODEBUG=netdns=go）**：glab 解析 `gitlab.specwire.local` 需 `export GODEBUG=netdns=go`（同 specwire-initiate-change/specwire-review-change）
- 当前仓库有 GitLab remote（如 `origin` → personal/webdeck）

## 输入契约

- `<change-id>`（必填）：kebab-case；MR 必须关联（严格校验，不匹配直接报错——零副作用，先于合并）
- `--mr`（必填）：数字编号
