// workspace-kit:managed-pi-extension name=workspace-guard version=5

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const MANAGED_ADAPTER_MARKER = "proj:managed-agent-adapter:start agent=shared";
const RULE_VERSION_PATTERN = /proj:managed-workspace-rules:start version=(\d+)/;
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
Pi 当前加载的全部 AGENTS.md 是本轮工作的完整规则合同，必须逐条遵守所有适用于当前任务、动作和答复的要求。
不得选择性忽略、弱化或用模型默认习惯替代这些规则；每次工具调用、文件修改和最终答复前都必须检查相关规则，完成前必须对照全部适用规则自检。
workspace-guard 只强制部分可机械判断的边界；未被阻断不代表符合 AGENTS.md。
</workspace_guard>`;

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

export default function workspaceGuard(pi) {
	const state = {
		active: false,
		workspaceRoot: undefined,
		gitRoot: undefined,
		ruleVersion: undefined,
		gitChecks: { status: false, diff: false, cached: false },
	};

	function reset(workspaceRoot, ruleVersion) {
		state.active = true;
		state.workspaceRoot = workspaceRoot;
		state.gitRoot = undefined;
		state.ruleVersion = ruleVersion;
		state.gitChecks = { status: false, diff: false, cached: false };
	}

	async function activate(contextFiles, ctx) {
		const context = managedContext(contextFiles, ctx.cwd);
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
		if (state.gitRoot) {
			if (!state.gitChecks.status) missing.push("git status");
			if (!state.gitChecks.diff) missing.push("git diff");
			if (!state.gitChecks.cached) missing.push("git diff --cached");
		}
		return missing;
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
		if (!(await activate(event.systemPromptOptions.contextFiles, ctx))) return undefined;
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
		if (path && state.gitRoot && !isInside(state.gitRoot, path)) return undefined;

		const missing = preflightMissing();
		if (missing.length > 0) {
			return { block: true, reason: `workspace-guard：写入前必须先成功执行：${missing.join("、")}` };
		}

		if (path && !(await isTrackedManagedPath(path))) {
			return { block: true, reason: `workspace-guard：${path} 是未跟踪的受管 overlay 副本，只允许通过 proj rules/proj wt sync 更新` };
		}

		return undefined;
	});

	pi.on("tool_result", (event) => {
		if (!state.active || event.isError) return undefined;

		if (event.toolName === "bash" && typeof event.input.command === "string") {
			const command = event.input.command;
			const checks = gitChecksFromCommand(command);
			state.gitChecks.status ||= checks.status;
			state.gitChecks.diff ||= checks.diff;
			state.gitChecks.cached ||= checks.cached;
		}

		return undefined;
	});

	pi.on("agent_settled", () => {
		state.gitChecks = { status: false, diff: false, cached: false };
	});

	pi.registerCommand("workspace-guard", {
		description: "显示 Workspace Kit 工作流门禁状态",
		handler: async (_args, ctx) => {
			const contextFiles = ctx.getSystemPromptOptions().contextFiles ?? [];
			if (!(await activate(contextFiles, ctx))) {
				const contextPaths = contextFiles
					.filter((file) => typeof file.path === "string")
					.map((file) => resolve(ctx.cwd, file.path));
				const loaded = contextPaths.length > 0 ? contextPaths.map((path) => `- ${path}`).join("\n") : "（无）";
				ctx.ui.notify(
					`workspace-guard：Pi 当前未加载 Workspace Kit 受管 AGENTS.md，门禁未启用。\n当前 cwd：${ctx.cwd}\nPi 已加载 context files：\n${loaded}`,
					"info",
				);
				return;
			}
			const checks = [
				`规则版本：${state.ruleVersion ?? "未知"}`,
				`workspace：${state.workspaceRoot}`,
				`项目类型：${state.gitRoot ? `Git (${state.gitRoot})` : "非 Git"}`,
				state.gitRoot
					? `Git 前置：status=${state.gitChecks.status ? "是" : "否"}，diff=${state.gitChecks.diff ? "是" : "否"}，cached=${state.gitChecks.cached ? "是" : "否"}`
					: "Git 前置：不适用",
			];
			ctx.ui.notify(checks.join("\n"), "info");
		},
	});
}
