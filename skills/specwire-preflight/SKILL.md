---
name: specwire-preflight
description: SpecWire 管线前置体检——零副作用检查 工具链/认证/网络/SSH/仓库态/阶段前置，每项附修复建议（默认全链路）。用户要发起/评审/合并/归档前检查环境是否符合要求时使用。
---

# specwire-preflight（前置体检）

## 是什么

起飞前体检：一次命令回答「这台机器/这个仓库能走通 SpecWire 管线吗」。**只探测 + 给修复建议，不修复**（与管线技能哲学一致：技能给证据，人执行）。

## 执行入口

先将 `scripts/specwire-preflight.mjs` 相对于本 `SKILL.md` 所在目录解析为绝对路径，再执行：

```bash
node "<技能目录>/scripts/specwire-preflight.mjs" [init|review|merge|archive|all] [--project <group/project>] [--bridge]
```

- 默认 `all` 全链路；指定目标只查该环前置（`review`/`merge` 会多查 MR 可读性，`archive` 会多查 Issue 可读性）
- `--project`：覆盖 origin remote 推断
- `--bridge`：附加检查 Bridge 容器运行状态（并提示其 token 与 glab 独立）
- 退出码：0 = 无 ❌；1 = 存在 ❌

## 检查清单

| 组 | 项 | 失败修复建议（固化本机教训） |
|---|---|---|
| 工具链 | node / git / glab / openspec | brew / npm 安装 |
| 认证&网络 | glab `api user` 实测 + `GODEBUG` 检查 | `export GODEBUG=netdns=go` / `glab auth login --hostname … --token …` |
| SSH | `git ls-remote origin HEAD` | 配 SSH key / `GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes'` |
| 仓库 | origin 推断 / upstream / 默认分支 / **分叉**（ahead+behind）/ **工作区脏** / openspec 根 | `--stash` / `git rebase origin/main` / `git remote add origin` |
| 阶段 | review/merge 查 MR 列表；archive 查 Issue 列表 | glab 登录 + 仓库权限 |
| --bridge | 容器运行态 + token 独立性提示 | `docker compose up -d` / 查 bridge/.env |

## 边界

- **不修复、不推送、不提交**：全只读探测（fetch 为只读网络操作）
- 与四件套的定位差异：四件套做**事**，preflight 看**能不能做**（准入体检）；故障时也可先跑 `specwire-preflight <环节>` 定位
- 体检结果**不替代**环节内校验（以各环节实际结果为准）

## 前置检查

- 与四件套相同：git/glab/openspec（node 自带）；本机 glab 域名问题需 `GODEBUG=netdns=go`（体检会主动提示）
