---
name: specwire-archive-change
description: 任务归档——同步 main → openspec archive → archived trailer 推送 → 验证（GitLab Issue closed + Multica 卡提示）。用户要归档已合并 OpenSpec change 时使用。
---

# specwire-archive-change（任务归档）

## 是什么

把「归档一个已合并 change」固化为一条命令：同步 main → `openspec archive` → archived trailer 推送（触发 Bridge）→ 验证闭环。技能不删 change 分支、不直接调 Bridge API（事件驱动）。

## 执行入口

先将 `scripts/specwire-archive-change.mjs` 相对于本 `SKILL.md` 所在目录解析为绝对路径，再执行：

```bash
node "<技能目录>/scripts/specwire-archive-change.mjs" <change-id> [--stash] [--dry-run] [--repo <group/project>]
```

- `--stash`：自动暂存已跟踪修改并全程还原（同 specwire-initiate-change）
- `--dry-run`：预览将执行的命令，不执行

## 意图映射（自然语言 → 参数）

| 用户说 | 参数 |
|---|---|
| 合并完了，归档这个变更 | `<change-id>` |
| 工作区有未提交修改 | 追加 `--stash` |
| 先看看会做什么 | 追加 `--dry-run` |

## 流程

1. 材料性校验：change 存在（active 或已在 `archive/`——后者幂等，直接进验证）；active 时提示实施痕迹（`implementation.md` 有无）；**不重复确认 MR**（流程顺序由 specwire-merge-change 保证，且未合并的 change 在 main 上不存在——天然拦截）
2. 同步 main：fetch + `merge --ff-only`（分叉则明确报错，不自动合并历史）
3. 归档：`openspec archive <id> -y --json`（非交互；validate 失败即止，不提交）
4. 提交 + 推送：commit 带 `SpecWire-Event: archived` / `SpecWire-Change: <id>` trailer → `push origin main` ← **触发 Bridge**
5. 验证：轮询 GitLab Issue closed（≤50s）；Multica 卡 best-effort 提示
6. 收尾：change 分支保持不动（提示自行处理）；`--stash` 已还原

## 边界（与相邻技能）

- **不删 change 分支**（`change/feat-*` / `change/fix-*`）——溯源保留
- **不直接调用 Bridge API**——Bridge 无本地关闭端点；"自动关闭 Multica + GitLab Issue"由 Bridge 响应 archived trailer 完成。本地技能只负责**触发与验证**
- **不做实现**（apply 的职责）/ **不做验证判定**（review 的职责）/ **不做合并**（merge 的职责）

## 前置检查（调用前核实）

- git、glab、openspec 已安装（glab 已登录目标实例）
- **已知问题（本机特殊——仅 gitlab.specwire.local 自托管实例存在 .local 域名解析问题；其他实例无需 GODEBUG=netdns=go）**：glab 解析 `gitlab.specwire.local` 需 `export GODEBUG=netdns=go`（同其他技能）
- 前置：MR 已合并（specwire-merge-change 完成）；当前 main 与远端无未处理分叉

## 输入契约

- `<change-id>`（必填）：kebab-case；不在 active 也不在 archive → 报错
- 归档默认校验工件一致性（含 tasks 完成度）；失败提示补全或经确认 `openspec archive --no-validate`
