# Pi Workspace Guard

本仓库把 Workspace Kit 的 `workspace-guard` 作为独立 Pi package 发布。它只对加载了 Workspace Kit 受管 `AGENTS.md` 的项目启用；普通项目不受影响。

## 安装

当前仓库为私有仓库。另一台设备配置好 GitHub SSH key 后，执行：

```bash
pi install git:git@github.com:tyf1996/pi-workspace-guard
```

启动或重启 Pi；已打开的 Pi 会话执行：

```text
/reload
/workspace-guard
```

`/workspace-guard` 会显示规则版本、当前 workspace、状态文件读取情况、Git 前置检查和最近的完成检查结果。

更新和移除：

```bash
pi update --extension git:git@github.com:tyf1996/pi-workspace-guard
pi remove git:git@github.com:tyf1996/pi-workspace-guard
```

## 启用条件

Extension 只在 Pi 实际加载的 `AGENTS.md` 同时包含以下受管标记时启用：

```text
proj:managed-agent-adapter:start agent=shared
proj:managed-workspace-rules:start version=<N>
```

目标项目还应包含 `.workspace/PROJECT_STATE.md`。未满足条件时，`/workspace-guard` 会报告门禁未启用。

## 门禁范围

- 在每次 Agent run 的 system prompt 末尾追加简短执行协议。
- 首次写入前要求读取 `.workspace/PROJECT_STATE.md`。
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
