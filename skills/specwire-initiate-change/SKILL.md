---
name: specwire-initiate-change
description: 发起变更——拉取分支(change/feat-*|change/fix-*) → propose → 提交推送 → 发起 GitLab Issue。用户要发起 OpenSpec change 时使用。
---

# specwire-initiate-change（发起变更）

## 是什么

把「发起变更」固化为一条命令：拉取分支 → opsx:propose → 提交推送 → 发起 GitLab Issue。

## 执行入口

先将 `scripts/specwire-initiate-change.mjs` 相对于本 `SKILL.md` 所在目录解析为绝对路径，再执行：

```bash
node "<技能目录>/scripts/specwire-initiate-change.mjs" <change-id> --type feat|fix [--todo] [--assignee <name>] [--stash]
```

`--stash`：开始时自动暂存**已跟踪修改**（不触碰未跟踪内容，如待发起的 change 工件），结束时自动切回原分支并还原工作区——工作区脏也能一键发起。

## 意图映射（自然语言 → 命令参数）

| 用户说 | 参数 |
|---|---|
| 功能类变更（新功能/新应用/增强） | `--type feat` |
| 修复类变更（bug/崩溃/问题） | `--type fix` |
| 发布即开工（无需人工批准） | `--todo` |
| 预分配给某人 | `--assignee <名字>` |
| 工作区有未提交修改（自动暂存并还原） | `--stash` |

分支命名：`change/<type>-<change-id>`（如 `change/feat-add-preset-feed`）。

## 流程

1. 拉取分支：基于远端默认分支建 `change/<type>-<change-id>`
2. opsx:propose：`openspec new change <id>`（纯本地，不调用模型；已存在则跳过，已撰写未推送的内容自动带入）
3. 提交推送此分支（无改动时跳过提交）
4. 发起 GitLab Issue：`glab issue create`（labels=`change`，描述含 `change_id` / `branch` / `branch_head_sha`，+ 可选状态/分配）

## 前置检查（调用前核实）

- Node.js、git、openspec CLI、**glab** 已安装；`glab auth status` 显示已登录目标实例
- SSH 免密可推送；当前仓库 main 有 upstream 跟踪分支
- **已知问题（本机特殊——仅 gitlab.specwire.local 自托管实例存在 .local 域名解析问题；其他实例无需 GODEBUG=netdns=go）**：glab（cgo 解析器）解析 `gitlab.specwire.local` 域名超时，需 `export GODEBUG=netdns=go`（纯 Go 解析器读 /etc/hosts 秒解）后 glab 才能正常访问；详见知识库《Go 程序解析 .local 域名超时》

## 输入契约

参数必须是 kebab-case 的 change-id；**不接受变更描述**。描述性需求先走 `/openspec-propose`（可先 `/openspec-explore`），撰写完成并审阅后再回来发起。
