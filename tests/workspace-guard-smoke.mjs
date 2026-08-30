#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workspaceGuard, {
	gitChecksFromCommand,
	isHighConfidenceReadOnlyCommand,
} from "../extensions/workspace-guard.ts";

const MANAGED_CONTEXT = `
<!-- proj:managed-agent-adapter:start agent=shared version=3 -->
<!-- proj:managed-workspace-rules:start version=11 -->
`;

function createHarness(root, options = {}) {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const contextFiles = options.contextFiles ?? [{ path: join(root, "AGENTS.md"), content: MANAGED_CONTEXT }];
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
			throw new Error(`unexpected git call: ${args.join(" ")}`);
		},
	};
	workspaceGuard(pi);

	const ctx = {
		cwd: root,
		getSystemPromptOptions() {
			return { cwd: root, contextFiles };
		},
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
	};

	return {
		commands,
		ctx,
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
		"sed -n '1,120p' .workspace/RULES.md && git status --short && git diff && git diff --cached",
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
const root = await mkdtemp(join(tmpdir(), "workspace-guard-"));
try {
	await writeFile(join(root, "AGENTS.md"), MANAGED_CONTEXT, "utf8");
	await writeFile(join(root, "target.txt"), "before\n", "utf8");

	const commandOnly = createHarness(root);
	await commandOnly.commands.get("workspace-guard").handler("", commandOnly.ctx);
	assert.match(commandOnly.notifications.at(-1).message, /规则版本：11/);
	assert.match(commandOnly.notifications.at(-1).message, new RegExp(`workspace：${root}`));

	const unmanagedCommand = createHarness(root, {
		contextFiles: [{ path: join(root, "AGENTS.md"), content: "ordinary AGENTS.md" }],
	});
	await unmanagedCommand.commands.get("workspace-guard").handler("", unmanagedCommand.ctx);
	assert.match(unmanagedCommand.notifications.at(-1).message, /门禁未启用/);
	assert.match(unmanagedCommand.notifications.at(-1).message, /当前 cwd/);
	assert.match(unmanagedCommand.notifications.at(-1).message, /AGENTS\.md/);

	const harness = createHarness(root);

	const inactive = await activate(harness, root, "ordinary AGENTS.md");
	assert.equal(inactive, undefined);
	const active = await activate(harness, root);
	assert.match(active.systemPrompt, /<workspace_guard>/);
	assert.match(active.systemPrompt, /完整规则合同/);
	assert.match(active.systemPrompt, /不得选择性忽略/);
	assert.match(active.systemPrompt, /未被阻断不代表符合 AGENTS\.md/);
	assert.doesNotMatch(active.systemPrompt, /遵守以下执行顺序/);
	assert.match(active.systemPrompt, /写入前仍需/);
	assert.ok(harness.commands.has("workspace-guard"));

	const target = join(root, "target.txt");
	assert.equal(
		await harness.handlers.get("tool_call")(
			eventFor("write", "external-output", { path: join(root, "..", "artifact.md"), content: "result" }),
			harness.ctx,
		),
		undefined,
	);
	let blocked = await harness.handlers.get("tool_call")(
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
	assert.equal(
		await harness.handlers.get("tool_call")(
			eventFor("bash", "shell-write", { command: "python3 script.py" }),
			harness.ctx,
		),
		undefined,
	);
	await harness.handlers.get("agent_settled")({ type: "agent_settled" }, harness.ctx);
	blocked = await harness.handlers.get("tool_call")(
		eventFor("edit", "next-run-edit", { path: target, oldText: "after", newText: "next" }),
		harness.ctx,
	);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /git status/);

	const nonGit = createHarness(root, { git: false });
	await activate(nonGit, root);
	blocked = await nonGit.handlers.get("tool_call")(
		eventFor("edit", "non-git-edit", { path: target, oldText: "before", newText: "after" }),
		nonGit.ctx,
	);
	assert.equal(blocked, undefined);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("workspace-guard behavior smoke test: PASS");
