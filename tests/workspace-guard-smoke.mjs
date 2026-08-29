#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workspaceGuard, {
	dangerousCommandReason,
	gitChecksFromCommand,
	isHighConfidenceReadOnlyCommand,
} from "../extensions/workspace-guard.ts";

const MANAGED_CONTEXT = `
<!-- proj:managed-agent-adapter:start agent=shared version=2 -->
<!-- proj:managed-workspace-rules:start version=10 -->
`;

function createHarness(root, options = {}) {
	const handlers = new Map();
	const commands = new Map();
	const followUps = [];
	const notifications = [];
	const confirms = [];
	const diffCheckResults = [...(options.diffCheckResults ?? [])];
	let trackedManagedPath = options.trackedManagedPath ?? true;

	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		async exec(command, args) {
			assert.equal(command, "git");
			if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
				return options.git === false
					? { code: 128, stdout: "", stderr: "not a git repository" }
					: { code: 0, stdout: `${root}\n`, stderr: "" };
			}
			if (args[0] === "ls-files") {
				return trackedManagedPath
					? { code: 0, stdout: `${args.at(-1)}\n`, stderr: "" }
					: { code: 1, stdout: "", stderr: "untracked" };
			}
			if (args[0] === "diff" && args[1] === "--check") {
				return diffCheckResults.shift() ?? { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected git call: ${args.join(" ")}`);
		},
		sendUserMessage(message, sendOptions) {
			followUps.push({ message, options: sendOptions });
		},
	};
	workspaceGuard(pi);

	const ctx = {
		cwd: root,
		hasUI: options.hasUI ?? false,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			async confirm(title, message) {
				confirms.push({ title, message });
				return options.confirm ?? false;
			},
		},
	};

	return {
		commands,
		confirms,
		ctx,
		followUps,
		handlers,
		notifications,
		setTrackedManagedPath(value) {
			trackedManagedPath = value;
		},
	};
}

function eventFor(toolName, toolCallId, input) {
	return { type: "tool_call", toolName, toolCallId, input };
}

function resultFor(toolName, toolCallId, input, isError = false) {
	return { type: "tool_result", toolName, toolCallId, input, isError, content: [], details: undefined };
}

async function activate(harness, root, content = MANAGED_CONTEXT) {
	return harness.handlers.get("before_agent_start")(
		{
			type: "before_agent_start",
			prompt: "test",
			systemPrompt: "base prompt",
			systemPromptOptions: { cwd: root, contextFiles: [{ path: join(root, "AGENTS.md"), content }] },
		},
		harness.ctx,
	);
}

assert.equal(
	isHighConfidenceReadOnlyCommand(
		"sed -n '1,120p' .workspace/PROJECT_STATE.md && git status --short && git diff && git diff --cached",
	),
	true,
);
assert.equal(isHighConfidenceReadOnlyCommand("python3 script.py"), false);
assert.equal(isHighConfidenceReadOnlyCommand("sed -i 's/a/b/' file"), false);
assert.equal(isHighConfidenceReadOnlyCommand("git branch feature"), false);
assert.equal(isHighConfidenceReadOnlyCommand("git diff --output=review.patch"), false);
assert.equal(isHighConfidenceReadOnlyCommand("rg --pre ./generator pattern"), false);
assert.deepEqual(gitChecksFromCommand("git status --short; git diff; git diff --staged"), {
	status: true,
	diff: true,
	cached: true,
});
assert.deepEqual(gitChecksFromCommand("git --no-pager status; git --no-pager diff; git --no-pager diff --cached"), {
	status: true,
	diff: true,
	cached: true,
});
assert.equal(dangerousCommandReason("rm -rf build"), "数据删除");
assert.equal(dangerousCommandReason("git reset --hard HEAD"), "Git 强制重置");
assert.equal(dangerousCommandReason("git restore target.txt"), "Git 工作区覆盖");
assert.equal(dangerousCommandReason("find . -name '*.tmp' -delete"), "数据删除或外部执行");
assert.equal(dangerousCommandReason("git diff --check"), undefined);

const root = await mkdtemp(join(tmpdir(), "workspace-guard-"));
try {
	await mkdir(join(root, ".workspace"));
	await writeFile(join(root, ".workspace", "PROJECT_STATE.md"), "# state\n", "utf8");
	await writeFile(join(root, "AGENTS.md"), MANAGED_CONTEXT, "utf8");
	await writeFile(join(root, "target.txt"), "before\n", "utf8");

	const harness = createHarness(root, {
		diffCheckResults: [
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "target.txt:1: trailing whitespace.\n", stderr: "" },
			{ code: 1, stdout: "target.txt:1: trailing whitespace.\n", stderr: "" },
		],
	});

	const inactive = await activate(harness, root, "ordinary AGENTS.md");
	assert.equal(inactive, undefined);
	const active = await activate(harness, root);
	assert.match(active.systemPrompt, /<workspace_guard>/);
	assert.match(active.systemPrompt, /写入前仍需/);
	assert.ok(harness.commands.has("workspace-guard"));

	const target = join(root, "target.txt");
	let blocked = await harness.handlers.get("tool_call")(
		eventFor("edit", "edit-before-state", { path: target, oldText: "before", newText: "after" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /PROJECT_STATE/);

	await harness.handlers.get("tool_result")(
		resultFor("read", "read-state", { path: join(root, ".workspace", "PROJECT_STATE.md") }),
		harness.ctx,
	);
	blocked = await harness.handlers.get("tool_call")(
		eventFor("edit", "edit-before-git", { path: target, oldText: "before", newText: "after" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /git status/);

	const preflightCommand = "git status --short && git diff && git diff --cached";
	assert.equal(
		await harness.handlers.get("tool_call")(eventFor("bash", "preflight", { command: preflightCommand }), harness.ctx),
		undefined,
	);
	await harness.handlers.get("tool_result")(resultFor("bash", "preflight", { command: preflightCommand }), harness.ctx);

	blocked = await harness.handlers.get("tool_call")(
		eventFor("write", "outside", { path: join(root, "..", "outside.txt"), content: "no" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /拒绝写出/);

	harness.setTrackedManagedPath(false);
	blocked = await harness.handlers.get("tool_call")(
		eventFor("edit", "overlay", { path: join(root, "AGENTS.md"), oldText: "a", newText: "b" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /overlay/);
	harness.setTrackedManagedPath(true);

	assert.equal(
		await harness.handlers.get("tool_call")(
			eventFor("edit", "valid-edit", { path: target, oldText: "before", newText: "after" }),
			harness.ctx,
		),
		undefined,
	);
	await harness.handlers.get("tool_result")(
		resultFor("edit", "valid-edit", { path: target, oldText: "before", newText: "after" }),
		harness.ctx,
	);
	await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);
	assert.equal(harness.followUps.length, 0);

	blocked = await harness.handlers.get("tool_call")(
		eventFor("bash", "danger", { command: "rm -rf build" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /非交互模式/);

	assert.equal(
		await harness.handlers.get("tool_call")(
			eventFor("edit", "bad-edit", { path: target, oldText: "after", newText: "bad  " }),
			harness.ctx,
		),
		undefined,
	);
	await harness.handlers.get("tool_result")(
		resultFor("edit", "bad-edit", { path: target, oldText: "after", newText: "bad  " }),
		harness.ctx,
	);
	await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);
	assert.equal(harness.followUps.length, 1);
	assert.equal(harness.followUps[0].options.deliverAs, "followUp");
	await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);
	assert.equal(harness.followUps.length, 1);
	assert.match(harness.notifications.at(-1).message, /自动续跑上限/);
	await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
	blocked = await harness.handlers.get("tool_call")(
		eventFor("edit", "next-run-edit", { path: target, oldText: "after", newText: "next" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.doesNotMatch(blocked.reason, /PROJECT_STATE/);
	assert.match(blocked.reason, /git status/);

	const nonGit = createHarness(root, { git: false });
	await activate(nonGit, root);
	await nonGit.handlers.get("tool_result")(
		resultFor("read", "non-git-state", { path: join(root, ".workspace", "PROJECT_STATE.md") }),
		nonGit.ctx,
	);
	blocked = await nonGit.handlers.get("tool_call")(
		eventFor("edit", "non-git-edit", { path: target, oldText: "before", newText: "after" }),
		nonGit.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /修改已有文件前必须先读取/);
	await nonGit.handlers.get("tool_result")(resultFor("read", "read-target", { path: target }), nonGit.ctx);
	assert.equal(
		await nonGit.handlers.get("tool_call")(
			eventFor("edit", "non-git-edit-after-read", { path: target, oldText: "before", newText: "after" }),
			nonGit.ctx,
		),
		undefined,
	);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("workspace-guard behavior smoke test: PASS");
