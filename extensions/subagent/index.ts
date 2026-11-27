import * as path from "node:path";
import { type ExtensionAPI, getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { readBenchmarks } from "./benchmarks.ts";
import {
	finalText,
	formatDuration,
	formatTokens,
	contextText,
	INTERNAL_TOOL_NAMES,
	modelFacingResult,
	readChildMetadata,
	resolveResumePath,
	resultOutput,
	type RunConfig,
	runChild,
	statusOf,
	structuredResult,
	type SubagentResult,
	summarize,
} from "./child.ts";
import { buildCatalog, type Catalog, catalogText, enforce, parsePolicy, resolveFresh, THINKING_LEVELS } from "./policy.ts";
import { LiveRuns, registerViewer, RUN_ENTRY_TYPE } from "./viewer.ts";

const COLLAPSED_ITEM_COUNT = 10;

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────────

// A plain `{ type: "string", enum }`, which every provider accepts.
const stringEnum = <T extends string>(values: readonly T[], description?: string) =>
	Type.Unsafe<T>({ type: "string", enum: [...values], ...(description ? { description } : {}) });

const SubagentParams = Type.Object({
	task: Type.String({ minLength: 1, description: "Self-contained assignment for a fresh child, or the next instruction for a resumed child." }),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._:-]+$", description: "Fresh child only. Short correlation label returned with every result of this child, including resumes." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Fresh child only. provider/id from subagent_models; omit for the configured subagent default." })),
	thinking: Type.Optional(stringEnum(THINKING_LEVELS, "Fresh child only. A thinking level subagent_models lists for the model; omit for the configured subagent default.")),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, description: "Fresh child only. Omit to inherit the parent's active tools except subagent and subagent_models; [] disables tools; plain names are the child's exact tool set; a list of only +name/-name entries adds to or removes from the inherited set. Add subagent only when the child must delegate further." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory for a fresh child. Defaults to the parent cwd." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Supervision checkpoint in milliseconds. On expiry, stops the child and returns any assistant text already emitted plus its resumable session when available." })),
	resume: Type.Optional(Type.String({ minLength: 1, description: "Exact absolute session path returned by an earlier subagent call. Cannot be combined with label, model, thinking, tools, or cwd." })),
});

const SubagentOutput = Type.Object({
	status: stringEnum(["done", "failed", "timeout", "aborted"] as const),
	output: Type.String({ description: "The child's final text, or its partial text after a timeout or abort. Not truncated." }),
	error: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	session: Type.Optional(Type.String({ description: "Pass as resume to continue this child." })),
	contextTokens: Type.Optional(Type.Integer({ description: "Tokens in the child's context after its last turn." })),
	contextWindow: Type.Optional(Type.Integer()),
});

const Score = Type.Optional(Type.Number());
const ModelsOutput = Type.Object({
	restricted: Type.Boolean({ description: "False when any model Pi accepts is permitted." }),
	defaultModel: Type.Optional(Type.String()),
	defaultThinking: Type.Optional(stringEnum(THINKING_LEVELS)),
	models: Type.Array(Type.Object({
		id: Type.String(),
		thinking: Type.Array(stringEnum(THINKING_LEVELS)),
		description: Type.Optional(Type.String()),
		benchmarks: Type.Optional(Type.Record(Type.String(), Type.Object({
			artificialAnalysis: Type.Optional(Type.Object({ intelligence: Score, coding: Score, cost: Score }, { description: "Artificial Analysis indices and USD per benchmark task." })),
		}), { description: "Scores by thinking level." })),
	})),
	issues: Type.Array(Type.String(), { description: "Configuration problems; they block only calls that select the affected model." }),
});

const SUBAGENT_GUIDELINES = [
	"Give each subagent a self-contained task with relevant context, constraints, and the required output.",
	"Run independent subagents concurrently, as sibling calls or with Promise.all in codemode; partition write work so children do not edit the same files.",
	"Treat subagent.timeoutMs as a supervision checkpoint, not merely a runtime limit; set it to when control should return for progress review. After a timeout: (1) resume the same session only to request a concise progress report covering completed work, current step, blockers, and proposed next action; do not ask it to continue in that turn; (2) once the report returns, decide whether to resume the child and steer any further work based on that report.",
	"Prefer subagent.resume whenever the child's accumulated context remains useful, including for answers, corrections, or follow-up.",
];

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

function elapsedBadge(result: Pick<SubagentResult, "startedAt" | "endedAt" | "timeoutMs">, now = Date.now()): string {
	const elapsed = formatDuration(Math.max(0, (result.endedAt ?? now) - result.startedAt));
	return `[⏱ ${elapsed}${result.timeoutMs ? ` / ${formatDuration(result.timeoutMs)}` : ""}]`;
}

function usageText(result: SubagentResult): string {
	const { turns, input, output, cacheRead, cacheWrite, cost } = result.usage;
	return [
		turns && `${turns} turn${turns === 1 ? "" : "s"}`,
		input && `↑${formatTokens(input)}`,
		output && `↓${formatTokens(output)}`,
		cacheRead && `R${formatTokens(cacheRead)}`,
		cacheWrite && `W${formatTokens(cacheWrite)}`,
		cost.total && `$${cost.total.toFixed(4)}`,
		contextText(result) && `ctx:${contextText(result)}`,
		result.model,
		result.thinking,
	].filter(Boolean).join(" ");
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> }
	| { type: "toolResult"; name: string; text: string; isError: boolean };

function displayItems(result: SubagentResult): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of result.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim()) items.push({ type: "text", text: part.text });
				if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		} else if (message.role === "toolResult") {
			const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			items.push({ type: "toolResult", name: message.toolName, text, isError: message.isError });
		}
	}
	if (result.partialText) items.push({ type: "text", text: result.partialText });
	return items;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
	if (name === "bash" && typeof args.command === "string") return `$ ${args.command.split("\n")[0]}`;
	const target = args.path ?? args.pattern ?? args.query;
	return target === undefined ? name : `${name} ${String(target)}`;
}

function compactItem(item: DisplayItem): string {
	if (item.type === "toolCall") return `→ ${formatToolCall(item.name, item.args)}`;
	if (item.type === "toolResult") return `← ${item.name}${item.isError ? " failed" : ""}: ${(item.text.trim().split("\n")[0] || "(no output)").slice(0, 160)}`;
	return item.text.split("\n").slice(0, 3).join("\n");
}

function catalogHeadline(catalog: Catalog): string {
	const defaults = catalog.defaultModel ? `default: ${catalog.defaultModel}${catalog.defaultThinking ? ` (${catalog.defaultThinking})` : ""}` : "";
	if (!catalog.restricted) return ["any model", defaults].filter(Boolean).join(", ");
	return [`${catalog.models.length} model${catalog.models.length === 1 ? "" : "s"}`, defaults].filter(Boolean).join(", ");
}

function renderCatalog(catalog: Catalog, expanded: boolean, theme: Theme): Component {
	const issues = catalog.issues.length;
	const headline = `${theme.fg("muted", catalogHeadline(catalog))}${issues ? theme.fg("warning", ` · ${issues} issue${issues === 1 ? "" : "s"}`) : ""}`;
	if (!expanded) return new Text(headline, 0, 0);
	const container = new Container();
	container.addChild(new Text(headline, 0, 0));
	for (const model of catalog.models) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", model.id), 0, 0));
		container.addChild(new Text(theme.fg("muted", model.thinking.join(" · ") || "unusable"), 0, 0));
		if (model.description) container.addChild(new Text(theme.fg("dim", model.description), 0, 0));
	}
	if (issues) {
		container.addChild(new Spacer(1));
		for (const issue of catalog.issues) container.addChild(new Text(theme.fg("warning", `! ${issue}`), 0, 0));
	}
	return container;
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

/** Resolve inherited tools: omitted inherits, plain names replace, only +name/-name entries adjust (like Pi's --tools). */
function resolveChildTools(inherited: readonly string[], requested: readonly string[] | undefined): string[] {
	if (!requested) return [...inherited];
	const modifiers = requested.filter((entry) => /^[+-]/.test(entry));
	if (modifiers.length === 0) return [...new Set(requested)];
	if (modifiers.length < requested.length) throw new Error("`tools` must be either plain tool names or only +name/-name entries, not a mix.");
	const tools = new Set(inherited);
	for (const entry of modifiers) {
		const name = entry.slice(1);
		if (!name) throw new Error(`Invalid tools entry "${entry}".`);
		if (entry[0] === "+") tools.add(name);
		else tools.delete(name);
	}
	return [...tools];
}

export default function (pi: ExtensionAPI) {
	const runs = new LiveRuns();
	const toolDefinitions: Record<string, ToolDefinition<any, any>> = {};
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		toolDefinitions[tool.name] = tool;
		pi.registerTool(tool);
	};
	const readPolicy = () => parsePolicy((pi.getSettings() as { subagent?: unknown }).subagent);
	registerViewer(pi, { runs, toolDefinitions });

	registerTool({
		name: "subagent_models",
		label: "Subagent Models",
		description: "List the child models and thinking levels subagent accepts, the subagent defaults, and optional benchmark scores per level. No child is started.",
		promptSnippet: "List model and thinking values accepted by subagent",
		parameters: Type.Object({}),
		outputSchema: ModelsOutput,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const catalog = buildCatalog(readPolicy(), ctx.modelRegistry, readBenchmarks());
			return {
				content: [{ type: "text", text: catalogText(catalog) }],
				structuredContent: catalog as Static<typeof ModelsOutput>,
				details: catalog,
			};
		},
		renderResult(toolResult, { expanded }, theme) {
			const catalog = toolResult.details as Catalog | undefined;
			if (catalog?.models) return renderCatalog(catalog, expanded, theme);
			const content = toolResult.content[0];
			return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
		},
	});

	registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run one task in a separate Pi session and return its final or partial response with a session path that can be resumed.",
		promptSnippet: "Run a task in a separate resumable Pi session",
		promptGuidelines: SUBAGENT_GUIDELINES,
		parameters: SubagentParams,
		outputSchema: SubagentOutput,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be blank.");
			const policy = readPolicy();

			let config: RunConfig;
			let label = params.label;
			let resume: string | undefined;
			if (params.resume) {
				if (params.label || params.model || params.thinking || params.tools || params.cwd) {
					throw new Error("A resumed subagent accepts only task, resume, and timeoutMs; it keeps its original label and runtime configuration. Start a fresh child to change them.");
				}
				resume = resolveResumePath(params.resume);
				const { version: _, label: savedLabel, ...saved } = readChildMetadata(resume);
				try {
					config = { ...saved, ...enforce(policy, saved, ctx.modelRegistry) };
				} catch (error) {
					throw new Error(`This child cannot resume under the current subagent policy: ${(error as Error).message}`);
				}
				label = savedLabel;
			} else {
				const inherited = pi.getActiveTools().filter((name) => !INTERNAL_TOOL_NAMES.has(name));
				config = {
					cwd: path.resolve(params.cwd ?? ctx.cwd),
					...resolveFresh(policy, { model: params.model, thinking: params.thinking }, ctx.modelRegistry),
					tools: resolveChildTools(inherited, params.tools),
				};
			}

			// Look up the context window whenever the reported model changes.
			let windowFor: string | undefined;
			const withWindow = (live: SubagentResult) => {
				if (live.model === windowFor) return live;
				windowFor = live.model;
				live.contextWindow = ctx.modelRegistry.getAll().find((model) => `${model.provider}/${model.id}` === live.model)?.contextWindow;
				return live;
			};
			let result: SubagentResult;
			try {
				result = withWindow(await runChild({
					config,
					task: params.task,
					label,
					timeoutMs: params.timeoutMs,
					resume,
					signal,
					onUpdate(live) {
						withWindow(live);
						runs.update(toolCallId, live);
						onUpdate?.({ content: [{ type: "text", text: live.partialText || finalText(live) || "(running...)" }], details: { result: live } });
					},
				}));
				// Recorded on the branch for /subagents, also for calls made from codemode scripts, which never
				// reach the transcript themselves.
				if (result.sessionFile) pi.appendEntry(RUN_ENTRY_TYPE, summarize(result));
			} finally {
				runs.end(toolCallId);
			}
			return {
				content: [{ type: "text", text: modelFacingResult(result) }],
				structuredContent: structuredResult(result),
				details: { result },
				usage: result.usage,
				...(statusOf(result) === "failed" ? { isError: true } : {}),
			};
		},
		renderCall(args, theme) {
			const preview = args.task.length > 72 ? `${args.task.slice(0, 72)}…` : args.task;
			const identity = args.label ?? (args.resume ? "resume" : "child");
			const timeout = args.timeoutMs ? ` ${theme.fg("dim", `[⏱ ${formatDuration(args.timeoutMs)}]`)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", identity)}${timeout}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},
		renderResult(toolResult, { expanded }, theme, context) {
			const result = (toolResult.details as { result?: SubagentResult } | undefined)?.result;
			if (!result) {
				const content = toolResult.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const status = statusOf(result);
			const icon = status === "running"
				? theme.fg("warning", "⏳")
				: status === "done"
					? theme.fg("success", "✓")
					: theme.fg(status === "timeout" ? "warning" : "error", "✗");
			const title = result.label ?? (result.resumed ? "resumed child" : "child");
			const items = displayItems(result);

			// Tick the elapsed timer once a second while the child runs.
			const state = context.state as { ticker?: ReturnType<typeof setInterval> };
			if (status === "running") state.ticker ??= setInterval(() => context.invalidate(), 1000);
			else if (state.ticker) {
				clearInterval(state.ticker);
				state.ticker = undefined;
			}
			const header = `${icon} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("dim", elapsedBadge(result))} ${theme.fg(status === "done" ? "success" : "warning", status)}`;
			const stats = usageText(result);
			const session = result.sessionFile ? theme.fg("dim", `session: ${result.sessionFile}`) : "";

			if (!expanded) {
				const recent = items.slice(-COLLAPSED_ITEM_COUNT);
				const lines = [header];
				if (items.length > recent.length) lines.push(theme.fg("muted", `… ${items.length - recent.length} earlier items`));
				for (const item of recent) lines.push(theme.fg(item.type === "toolResult" && item.isError ? "error" : "dim", compactItem(item)));
				for (const activity of result.toolActivity) {
					if (activity.status === "running") lines.push(theme.fg("warning", `⚙ ${formatToolCall(activity.name, activity.args)}`));
				}
				if (stats) lines.push(theme.fg("dim", stats));
				if (session) lines.push(session);
				return new Text(lines.join("\n"), 0, 0);
			}

			const container = new Container();
			const section = (title: string) => {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", `── ${title} ──`), 0, 0));
			};
			container.addChild(new Text(header, 0, 0));
			section("Task");
			container.addChild(new Text(result.task, 0, 0));
			section("Activity");
			for (const item of items) {
				if (item.type !== "text") container.addChild(new Text(theme.fg(item.type === "toolResult" && item.isError ? "error" : "dim", compactItem(item)), 0, 0));
			}
			section("Result");
			container.addChild(new Markdown(resultOutput(result), 0, 0, getMarkdownTheme()));
			if (stats) container.addChild(new Text(theme.fg("dim", stats), 0, 0));
			if (session) container.addChild(new Text(session, 0, 0));
			return container;
		},
	});
}

export const __testing = { elapsedBadge, resolveChildTools, catalogHeadline };
