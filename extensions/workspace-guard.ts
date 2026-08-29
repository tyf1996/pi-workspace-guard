// workspace-kit:managed-pi-extension name=workspace-guard version=1

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const MANAGED_ADAPTER_MARKER = "proj:managed-agent-adapter:start agent=shared";
const RULE_VERSION_PATTERN = /proj:managed-workspace-rules:start version=(\d+)/;
const STATE_RELATIVE_PATH = ".workspace/PROJECT_STATE.md";
const MANAGED_OVERLAY_PATHS = new Set([
	".claude/settings.local.json",
	".workspace/RULES.md",
	"AGENTS.md",
	"CLAUDE.md",
	"HERMES.md",
	"project.json",
]);

const COMPLIANCE_PROTOCOL = `
<workspace_guard>
Workspace Kit 的受管规则已启用。把 AGENTS.md 视为本轮工作合同，并遵守以下执行顺序：
1. 首次写入前读取当前 .workspace/PROJECT_STATE.md；Git 项目还要成功执行 git status、git diff 和 git diff --cached。
2. 工具被 workspace-guard 阻断时，先补齐原因中指出的前置动作；不得换用其他写入工具绕过。
3. 保留已有改动，只修改当前 worktree 范围内的目标；受管 overlay 副本保持只读。
4. 完成前按实际改动执行必要验证、复查 diff，并在产生持久结论、变更或阻塞时更新 PROJECT_STATE.md。验证失败或结果未知时不得宣称完成。
workspace-guard 是工作流门禁，不是操作系统 sandbox；未被机械阻断的动作仍须遵守 AGENTS.md。
</workspace_guard>`;

const DANGEROUS_COMMANDS = [
	{ pattern: /(^|[;&|]\s*)\s*(?:sudo|doas|pkexec)\b/i, reason: "权限提升" },
	{ pattern: /(^|[;&|]\s*)\s*su\s+(?:-|--login|-c\b)/i, reason: "权限提升" },
	{ pattern: /(^|[;&|]\s*)\s*(?:rm|unlink|rmdir)\b/i, reason: "数据删除" },
	{ pattern: /\bgit\s+(?:-[A-Za-z]\s+\S+\s+)*clean\b/i, reason: "Git 清理" },
	{ pattern: /\bgit\s+(?:-[A-Za-z]\s+\S+\s+)*reset\s+--hard\b/i, reason: "Git 强制重置" },
	{ pattern: /\bgit\s+(?:-[A-Za-z]\s+\S+\s+)*restore\b/i, reason: "Git 工作区覆盖" },
	{ pattern: /\bgit\s+(?:-[A-Za-z]\s+\S+\s+)*checkout\b[^;&|\n]*\s--(?:\s|$)/i, reason: "Git 工作区覆盖" },
	{ pattern: /\bfind\b[^;&|\n]*\s-(?:delete|exec|execdir|ok|okdir)\b/i, reason: "数据删除或外部执行" },
	{ pattern: /(^|[;&|]\s*)\s*(?:shred|truncate)\b/i, reason: "数据破坏" },
	{ pattern: /\b(?:chmod|chown|chgrp)\b/i, reason: "权限变更" },
	{ pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//i, reason: "块设备写入" },
	{ pattern: /\b(?:mkfs(?:\.\w+)?|wipefs)\b/i, reason: "块设备写入" },
	{ pattern: /\b(?:flashrom|rkdeveloptool|uuu|dfu-util)\b/i, reason: "设备烧录" },
	{ pattern: /\b(?:fastboot\s+(?:flash|erase)|esptool(?:\.py)?\b[^;&|\n]*\bwrite_flash)\b/i, reason: "设备烧录" },
	{ pattern: /\bterraform\s+(?:apply|destroy)\b/i, reason: "基础设施变更" },
	{ pattern: /\bkubectl\s+(?:apply|create|delete|patch|replace|scale)\b/i, reason: "集群变更" },
	{ pattern: /\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/i, reason: "集群变更" },
];

function realpathOrResolved(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isInside(root, path) {
	const child = relative(root, path);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function physicalDestination(path) {
	let existing = path;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return resolve(realpathOrResolved(existing), relative(existing, path));
}

function inputPath(input, cwd) {
	if (!input || typeof input.path !== "string" || !input.path.trim()) return undefined;
	return resolve(cwd, input.path);
}

function managedContext(contextFiles, cwd) {
	const candidates = (contextFiles ?? [])
		.filter(
			(file) =>
				typeof file.path === "string" &&
				typeof file.content === "string" &&
				basename(file.path).toLowerCase() === "agents.md" &&
				file.content.includes(MANAGED_ADAPTER_MARKER) &&
				RULE_VERSION_PATTERN.test(file.content),
		)
		.map((file) => ({ ...file, path: resolve(cwd, file.path) }))
		.filter((file) => isInside(dirname(file.path), resolve(cwd)))
		.sort((left, right) => right.path.length - left.path.length);
	return candidates[0];
}

function stripSafeRedirections(command) {
	return command
		.replace(/(?:\d*>|>)\s*\/dev\/null\b/g, "")
		.replace(/\d*>&\d+/g, "");
}

function isReadOnlyGitCommand(segment) {
	const match = segment.match(
		/^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*\s+(?:--no-pager\s+)?([\w-]+)([\s\S]*)$/i,
	);
	if (!match) return false;
	const subcommand = match[1].toLowerCase();
	const args = match[2];
	if (/(?:^|\s)(?:--output(?:=|\s)|-o\s)/.test(args)) return false;
	if (["status", "diff", "show", "log", "rev-parse", "ls-files", "ls-tree", "describe"].includes(subcommand)) {
		return true;
	}
	if (subcommand === "branch") {
		const branchArgs = args.trim();
		return branchArgs === "" || /^(?:--show-current|--list|-a|-r|-v|-vv)(?:\s|$)/.test(branchArgs);
	}
	if (subcommand === "worktree") return /^\s+list\b/.test(args);
	if (subcommand === "remote") return /^\s*(?:-v|--verbose)?\s*$/.test(args);
	if (subcommand === "tag") return /^\s*(?:-l|--list)(?:\s|$)/.test(args);
	if (subcommand === "config") return /^\s+(?:--get|--get-all|--get-regexp|--list)(?:\s|$)/.test(args);
	return false;
}

export function isHighConfidenceReadOnlyCommand(rawCommand) {
	if (typeof rawCommand !== "string" || !rawCommand.trim()) return false;
	let command = stripSafeRedirections(rawCommand.trim());
	if (/[<>`]/.test(command) || command.includes("$(") || /\b(?:eval|exec)\b/.test(command)) return false;

	const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every((rawSegment) => {
		let segment = rawSegment.trim();
		segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
		if (/^cd(?:\s|$)/.test(segment)) return true;
		if (isReadOnlyGitCommand(segment)) return true;
		if (/^sed\b/.test(segment)) {
			const script = segment.match(/^sed\s+-n\s+(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s|$)/);
			return script !== null && /^(?:\d+|\$)?(?:,(?:\d+|\$))?p$/.test(script[1] ?? script[2] ?? script[3]);
		}
		if (/^find\b/.test(segment)) {
			return !/-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b/.test(segment);
		}
		if (/^rg\b/.test(segment) && /(?:^|\s)--pre(?:=|\s|$)/.test(segment)) return false;
		return /^(?:pwd|ls|rg|grep|cat|head|tail|wc|file|stat|realpath|readlink|basename|dirname|which|whereis|date|uname|id|hostname|printf|echo|true|false|test|command\s+-v|\[)(?:\s|$)/.test(
			segment,
		);
	});
}

export function gitChecksFromCommand(command) {
	const checks = { status: false, diff: false, cached: false };
	if (typeof command !== "string") return checks;
	checks.status = /\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*(?:\s+--no-pager)?\s+status\b/.test(command);
	const diffCommands =
		command.match(/\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*(?:\s+--no-pager)?\s+diff\b[^;&|\n]*/g) ?? [];
	for (const diffCommand of diffCommands) {
		if (/\s--(?:cached|staged)(?:\s|$)/.test(diffCommand)) checks.cached = true;
		else checks.diff = true;
	}
	return checks;
}

export function dangerousCommandReason(command) {
	if (typeof command !== "string") return undefined;
	return DANGEROUS_COMMANDS.find(({ pattern }) => pattern.test(command))?.reason;
}

function commandReadsState(command) {
	return (
		typeof command === "string" &&
		/\b(?:cat|sed|head|tail|bat|rg)\b[^;&|\n]*\.workspace\/PROJECT_STATE\.md\b/.test(command)
	);
}

function shortFailure(stdout, stderr) {
	const text = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
	if (!text) return "git diff --check 返回非零状态";
	return text.split("\n").slice(0, 8).join("\n");
}

export default function workspaceGuard(pi) {
	const state = {
		active: false,
		workspaceRoot: undefined,
		workspaceRootPhysical: undefined,
		gitRoot: undefined,
		ruleVersion: undefined,
		stateRead: false,
		gitChecks: { status: false, diff: false, cached: false },
		readPaths: new Set(),
		pendingWrites: new Set(),
		writesSinceCheck: false,
		baselineDiffCheckClean: undefined,
		completionRetryUsed: false,
		lastCompletionFailure: undefined,
	};

	function reset(workspaceRoot, ruleVersion) {
		state.active = true;
		state.workspaceRoot = workspaceRoot;
		state.workspaceRootPhysical = realpathOrResolved(workspaceRoot);
		state.gitRoot = undefined;
		state.ruleVersion = ruleVersion;
		state.stateRead = false;
		state.gitChecks = { status: false, diff: false, cached: false };
		state.readPaths.clear();
		state.pendingWrites.clear();
		state.writesSinceCheck = false;
		state.baselineDiffCheckClean = undefined;
		state.completionRetryUsed = false;
		state.lastCompletionFailure = undefined;
	}

	async function activate(event, ctx) {
		const context = managedContext(event.systemPromptOptions.contextFiles, ctx.cwd);
		if (!context) {
			state.active = false;
			return false;
		}
		const workspaceRoot = dirname(context.path);
		const ruleVersion = context.content.match(RULE_VERSION_PATTERN)?.[1];
		if (!state.active || state.workspaceRoot !== workspaceRoot || state.ruleVersion !== ruleVersion) {
			reset(workspaceRoot, ruleVersion);
			const result = await pi.exec("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"]);
			if (result.code === 0 && result.stdout.trim()) state.gitRoot = realpathOrResolved(result.stdout.trim());
		}
		return true;
	}

	function preflightMissing() {
		const missing = [];
		if (!state.stateRead) missing.push(`读取 ${STATE_RELATIVE_PATH}`);
		if (state.gitRoot) {
			if (!state.gitChecks.status) missing.push("git status");
			if (!state.gitChecks.diff) missing.push("git diff");
			if (!state.gitChecks.cached) missing.push("git diff --cached");
		}
		return missing;
	}

	async function captureBaseline() {
		if (!state.gitRoot || state.baselineDiffCheckClean !== undefined) return;
		const result = await pi.exec("git", ["diff", "--check"], { cwd: state.gitRoot });
		state.baselineDiffCheckClean = result.code === 0;
	}

	async function isTrackedManagedPath(path) {
		if (!state.gitRoot || !state.workspaceRoot) return true;
		const workspaceRelative = relative(state.workspaceRoot, path).split("\\").join("/");
		if (!MANAGED_OVERLAY_PATHS.has(workspaceRelative)) return true;
		const gitRelative = relative(state.gitRoot, path);
		if (!isInside(state.gitRoot, path)) return false;
		const result = await pi.exec("git", ["ls-files", "--error-unmatch", "--", gitRelative], { cwd: state.gitRoot });
		return result.code === 0;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await activate(event, ctx))) return undefined;
		const missing = preflightMissing();
		const status = missing.length === 0 ? "写入前置检查已满足。" : `写入前仍需：${missing.join("、")}。`;
		return { systemPrompt: `${event.systemPrompt}\n${COMPLIANCE_PROTOCOL}\n当前状态：${status}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.active) return undefined;
		const path = inputPath(event.input, ctx.cwd);
		const isFileWrite = event.toolName === "edit" || event.toolName === "write";
		const isKnownCustomWrite = event.toolName === "apply_patch" || event.toolName === "patch";
		const command = event.toolName === "bash" && typeof event.input.command === "string" ? event.input.command : undefined;
		const isShellWrite = command !== undefined && !isHighConfidenceReadOnlyCommand(command);
		const isWrite = isFileWrite || isKnownCustomWrite || isShellWrite;

		if (!isWrite) return undefined;
		if (path && state.workspaceRootPhysical) {
			const destination = physicalDestination(path);
			if (!isInside(state.workspaceRootPhysical, destination)) {
				return { block: true, reason: `workspace-guard：拒绝写出当前 workspace：${path}` };
			}
		}

		const missing = preflightMissing();
		if (missing.length > 0) {
			return { block: true, reason: `workspace-guard：写入前必须先成功执行：${missing.join("、")}` };
		}

		if (path && !(await isTrackedManagedPath(path))) {
			return { block: true, reason: `workspace-guard：${path} 是未跟踪的受管 overlay 副本，只允许通过 proj rules/proj wt sync 更新` };
		}

		if (!state.gitRoot && path && existsSync(path) && !state.readPaths.has(realpathOrResolved(path))) {
			return { block: true, reason: `workspace-guard：非 Git 项目修改已有文件前必须先读取目标：${path}` };
		}

		if (command) {
			const danger = dangerousCommandReason(command);
			if (danger) {
				if (!ctx.hasUI) {
					return { block: true, reason: `workspace-guard：非交互模式禁止未经确认的${danger}` };
				}
				const allowed = await ctx.ui.confirm("workspace-guard 高风险动作", `${danger}：\n\n${command}\n\n允许执行一次？`);
				if (!allowed) return { block: true, reason: `workspace-guard：用户未批准${danger}` };
			}
		}

		await captureBaseline();
		state.pendingWrites.add(event.toolCallId);
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!state.active || event.isError) {
			state.pendingWrites.delete(event.toolCallId);
			return undefined;
		}

		if (event.toolName === "read") {
			const path = inputPath(event.input, ctx.cwd);
			if (path) {
				const physical = realpathOrResolved(path);
				state.readPaths.add(physical);
				const statePath = state.workspaceRoot ? resolve(state.workspaceRoot, STATE_RELATIVE_PATH) : undefined;
				const offset = typeof event.input.offset === "number" ? event.input.offset : 1;
				const limit = event.input.limit;
				if (statePath && path === statePath && offset <= 1 && (limit === undefined || Number(limit) >= 100)) {
					state.stateRead = true;
				}
			}
		}

		if (event.toolName === "bash" && typeof event.input.command === "string") {
			const command = event.input.command;
			const checks = gitChecksFromCommand(command);
			state.gitChecks.status ||= checks.status;
			state.gitChecks.diff ||= checks.diff;
			state.gitChecks.cached ||= checks.cached;
			if (commandReadsState(command)) state.stateRead = true;
		}

		if (state.pendingWrites.delete(event.toolCallId)) state.writesSinceCheck = true;
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.active || !state.gitRoot || !state.writesSinceCheck) return;
		const result = await pi.exec("git", ["diff", "--check"], { cwd: state.gitRoot });
		if (result.code === 0) {
			state.writesSinceCheck = false;
			state.lastCompletionFailure = undefined;
			return;
		}

		state.lastCompletionFailure = shortFailure(result.stdout, result.stderr);
		if (state.baselineDiffCheckClean === false) {
			state.writesSinceCheck = false;
			ctx.ui.notify("workspace-guard：已有 diff --check 错误，未自动要求修改用户原有改动。", "warning");
			return;
		}
		if (!state.completionRetryUsed) {
			state.completionRetryUsed = true;
			pi.sendUserMessage(
				`[workspace-guard] 完成检查失败。请修复后重新验证；不得在失败仍存在时宣称完成。\n\n${state.lastCompletionFailure}`,
				{ deliverAs: "followUp" },
			);
			return;
		}
		state.writesSinceCheck = false;
		ctx.ui.notify("workspace-guard：git diff --check 仍失败，已达到本轮自动续跑上限。", "error");
	});

	pi.on("agent_settled", () => {
		state.completionRetryUsed = false;
		state.gitChecks = { status: false, diff: false, cached: false };
		state.readPaths.clear();
		state.pendingWrites.clear();
		state.baselineDiffCheckClean = undefined;
	});

	pi.registerCommand("workspace-guard", {
		description: "显示 Workspace Kit 工作流门禁状态",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("workspace-guard：当前会话未加载 Workspace Kit 受管 AGENTS.md，门禁未启用。", "info");
				return;
			}
			const checks = [
				`规则版本：${state.ruleVersion ?? "未知"}`,
				`workspace：${state.workspaceRoot}`,
				`项目类型：${state.gitRoot ? `Git (${state.gitRoot})` : "非 Git"}`,
				`PROJECT_STATE：${state.stateRead ? "已读取" : "未读取"}`,
				state.gitRoot
					? `Git 前置：status=${state.gitChecks.status ? "是" : "否"}，diff=${state.gitChecks.diff ? "是" : "否"}，cached=${state.gitChecks.cached ? "是" : "否"}`
					: "Git 前置：不适用",
				`完成检查：${state.lastCompletionFailure ? `失败（${state.lastCompletionFailure.split("\n")[0]}）` : "无已知失败"}`,
			];
			ctx.ui.notify(checks.join("\n"), state.lastCompletionFailure ? "warning" : "info");
		},
	});
}
