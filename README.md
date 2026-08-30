# Pi Workspace Guard

本仓库把 Workspace Kit 的 `workspace-guard` 作为独立 Pi package 发布。它只对加载了 Workspace Kit 受管 `AGENTS.md` 的项目启用；普通项目不受影响。

## 安装

仓库公开可读，直接通过 HTTPS 安装：

```bash
pi install git:https://github.com/tyf1996/pi-workspace-guard.git
```

独立 package 与 Workspace Kit 安装器复制的 `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/workspace-guard.ts` 二选一。若该文件已经存在，先备份并移出 `extensions/` 目录，再安装 package，避免 Pi 重复加载两份 Extension。

启动或重启 Pi；已打开的 Pi 会话执行：

```text
/reload
/workspace-guard
```

`/workspace-guard` 会立即检查 Pi 当前加载的 context files，并显示规则版本、当前 workspace、Git 前置检查和最近的完成检查结果。未启用时会显示当前 cwd 和 Pi 实际加载的 context 文件路径。

更新和移除：

```bash
pi update --extension git:https://github.com/tyf1996/pi-workspace-guard.git
pi remove git:https://github.com/tyf1996/pi-workspace-guard.git
```

## 启用条件

Extension 只在 Pi 实际加载的 `AGENTS.md` 同时包含以下受管标记时启用：

```text
proj:managed-agent-adapter:start agent=shared
proj:managed-workspace-rules:start version=<N>
```

## 门禁范围

- 在每次 Agent run 的 system prompt 末尾追加简短执行协议。
- Git 项目每次 Agent run 写入前要求成功执行 `git status`、`git diff` 和 `git diff --cached`。
- 阻断可判定的 workspace 越界写入和未跟踪受管 overlay 写入。
- 交互模式逐次确认数据删除、权限提升、设备烧录等高风险命令；非交互模式默认阻断。
- 发生写入后运行 `git diff --check`；失败时最多自动续跑一次。

## 边界

本 Extension 已按 Pi 0.84.3 Extension API 验证。它是工作流门禁，不是 OS sandbox，也不能理解并强制所有自然语言规则。未知自定义工具、最终答复语义、宿主权限和外部系统仍需由人工评审、CI、最小权限或容器约束。

Pi package 会以当前用户权限运行 Extension。安装前应审查源码。

## 验证

```bash
npm test
```
