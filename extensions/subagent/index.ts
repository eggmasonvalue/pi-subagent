import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, type Message, type Usage } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CHILD_SYSTEM_GUIDANCE =
	"Work independently on the delegated task. If you cannot proceed reliably without clarification, a decision, or missing information, stop and return the precise question or blocker to your supervisor. Do not guess or wait. Your supervisor can resume this session with an answer.";
const COLLAPSED_ITEM_COUNT = 10;
const CHILD_METADATA_SUFFIX = ".subagent.json";
const INTERNAL_TOOL_NAMES = new Set(["subagent", "subagent_models"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

interface UsageStats extends Usage {
	turns: number;
}

interface ChildMetadata {
	version: 2;
	cwd: string;
	model?: string;
	thinking?: string;
	tools: string[];
}

interface ToolActivity {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
}

interface SubagentResult {
	task: string;
	label?: string;
	resumed: boolean;
	timeoutMs?: number;
	exitCode: number;
	messages: Message[];
	toolActivity: ToolActivity[];
	partialText: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionFile?: string;
	sessionId?: string;
}

interface SubagentDetails {
	result: SubagentResult;
}

interface ModelAllowlistLevel {
	artificialAnalysis?: { intelligence?: number; coding?: number; cost?: number };
	deepSWE?: { pass?: number; cost?: number };
}

interface ModelAllowlistEntry {
	id: string;
	levels?: Record<string, ModelAllowlistLevel>;
	description?: string;
	[key: string]: unknown;
}

interface ModelAllowlistConfig {
	enabled?: boolean;
	allowed?: (string | ModelAllowlistEntry)[];
	default?: string;
}

interface ModelPolicy {
	enabled: boolean;
	allowed: Set<string>;
	metadata: Map<string, ModelAllowlistEntry>;
	defaultModel?: string;
	configPath: string;
}

interface RunConfig {
	cwd: string;
	model?: string;
	thinking?: string;
	tools: string[];
}

const EMPTY_USAGE = (): UsageStats => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	turns: 0,
});

function getModelAllowlistPath(): string {
	return path.join(getAgentDir(), "pi-subagent", "models-allowlist.json");
}

function loadModelPolicy(configPath = getModelAllowlistPath()): { policy: ModelPolicy; error?: string } {
	const disabled: ModelPolicy = {
		enabled: false,
		allowed: new Set(),
		metadata: new Map(),
		configPath,
	};
	if (!fs.existsSync(configPath)) return { policy: disabled };

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		return {
			policy: disabled,
			error: `Invalid JSON in model allowlist: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { policy: disabled, error: "Model allowlist must be a JSON object." };
	}

	const config = parsed as ModelAllowlistConfig;
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		return { policy: disabled, error: 'Model allowlist field "enabled" must be boolean.' };
	}
	if (config.allowed !== undefined && !Array.isArray(config.allowed)) {
		return { policy: disabled, error: 'Model allowlist field "allowed" must be an array.' };
	}
	if (config.default !== undefined && typeof config.default !== "string") {
		return { policy: disabled, error: 'Model allowlist field "default" must be a string.' };
	}

	const metadata = new Map<string, ModelAllowlistEntry>();
	const allowed = new Set<string>();
	for (const raw of config.allowed ?? []) {
		if (typeof raw === "string") {
			const id = raw.trim();
			if (id) allowed.add(id);
			continue;
		}
		if (raw && typeof raw === "object" && typeof raw.id === "string" && raw.id.trim()) {
			const entry = { ...raw, id: raw.id.trim() };
			allowed.add(entry.id);
			metadata.set(entry.id, entry);
		}
	}

	const enabled = config.enabled ?? true;
	const defaultModel = config.default?.trim() || undefined;
	if (enabled && allowed.size === 0) {
		return { policy: disabled, error: 'Model allowlist is enabled but "allowed" is empty.' };
	}
	if (enabled && defaultModel && !allowed.has(defaultModel)) {
		return { policy: disabled, error: 'The default model must also appear in "allowed".' };
	}

	return { policy: { enabled, allowed, metadata, defaultModel, configPath } };
}

function allowedThinkingLevels(entry: ModelAllowlistEntry | undefined): string[] | undefined {
	if (!entry?.levels || typeof entry.levels !== "object" || Array.isArray(entry.levels)) return undefined;
	const levels = Object.keys(entry.levels);
	return levels.length > 0 ? levels : undefined;
}

function validateModelPolicy(policy: ModelPolicy, registry: { getAll(): any[] }): string[] {
	if (!policy.enabled) return [];
	const errors: string[] = [];
	const known = new Map<string, any>();
	for (const model of registry.getAll()) known.set(`${model.provider}/${model.id}`, model);

	for (const id of policy.allowed) {
		const model = known.get(id);
		if (!model) {
			errors.push(`Allowlisted model "${id}" is not known to Pi.`);
			continue;
		}
		for (const level of allowedThinkingLevels(policy.metadata.get(id)) ?? []) {
			if (!THINKING_LEVEL_SET.has(level)) {
				errors.push(`Thinking level "${level}" configured for "${id}" is not recognized by Pi.`);
				continue;
			}
			if (level === "off") continue;
			if (!model.reasoning) {
				errors.push(`Thinking level "${level}" is unsupported by "${id}".`);
				continue;
			}
			const map = model.thinkingLevelMap as Record<string, unknown> | undefined;
			if ((level === "xhigh" || level === "max") && (!map || !(level in map) || map[level] === null)) {
				errors.push(`Thinking level "${level}" is unsupported by "${id}".`);
			} else if (map && level in map && map[level] === null) {
				errors.push(`Thinking level "${level}" is unsupported by "${id}".`);
			}
		}
	}
	return errors;
}

function resolveFreshModel(
	requestedModel: string | undefined,
	thinking: string | undefined,
	policy: ModelPolicy,
): { model?: string; error?: string } {
	if (!policy.enabled) return { model: requestedModel?.trim() || undefined };
	const model = requestedModel?.trim() || policy.defaultModel;
	if (!model) return { error: "Model policy requires `model`, but no default is configured." };
	if (!policy.allowed.has(model)) {
		return { error: `Model "${model}" is not allowed. Call subagent_models for permitted models.` };
	}
	const levels = allowedThinkingLevels(policy.metadata.get(model));
	if (!thinking && levels) {
		return { error: `Thinking level is required for "${model}". Allowed: ${levels.join(", ")}.` };
	}
	if (thinking && levels && !levels.includes(thinking)) {
		return { error: `Thinking level "${thinking}" is not allowed for "${model}". Allowed: ${levels.join(", ")}.` };
	}
	return { model };
}

function formatLevels(levels: unknown): string {
	if (!levels || typeof levels !== "object" || Array.isArray(levels)) return "";
	return Object.entries(levels as Record<string, ModelAllowlistLevel>)
		.map(([level, value]) => {
			const metrics: string[] = [];
			const aa = value?.artificialAnalysis;
			if (aa) {
				const quality = [aa.intelligence, aa.coding]
					.filter((metric): metric is number => typeof metric === "number")
					.map((metric) => metric.toFixed(1))
					.join("/");
				metrics.push(`AA ${quality || "?"}${typeof aa.cost === "number" ? `/$${aa.cost}` : ""}`);
			}
			const swe = value?.deepSWE;
			if (swe) {
				const pass = typeof swe.pass === "number" ? `${Math.round(swe.pass * 100)}%` : "?";
				metrics.push(`DeepSWE ${pass}${typeof swe.cost === "number" ? `/$${swe.cost}` : ""}`);
			}
			return `${level}: ${metrics.join(" · ") || "unbenchmarked"}`;
		})
		.join(" · ");
}

function compactModelCatalog(policy: ModelPolicy, validationErrors: string[]) {
	const entries = Array.from(policy.allowed).map((id) => policy.metadata.get(id) ?? { id });
	return {
		allowlistEnabled: policy.enabled,
		default: policy.defaultModel ?? null,
		columns: ["id", "levels", "description"],
		models: entries.map((entry) => [entry.id, formatLevels(entry.levels), entry.description ?? null]),
		validationErrors,
		note: policy.enabled
			? "Use an exact row id and an allowed thinking level. Omit model to use the default."
			: "No allowlist is configured; omit model to use the child Pi default or provide any available Pi model.",
	};
}

function metadataPath(sessionFile: string): string {
	return `${sessionFile}${CHILD_METADATA_SUFFIX}`;
}

function writeChildMetadata(sessionFile: string, metadata: ChildMetadata): void {
	const destination = metadataPath(sessionFile);
	const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, destination);
	} finally {
		try {
			if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
		} catch {
			// Preserve the original metadata error.
		}
	}
}

function readChildMetadata(sessionFile: string): ChildMetadata {
	const file = metadataPath(sessionFile);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`Subagent runtime metadata not found or invalid: ${file}`);
	}
	if (!parsed || typeof parsed !== "object") throw new Error(`Invalid subagent runtime metadata: ${file}`);
	const value = parsed as Partial<ChildMetadata>;
	if (value.version !== 2 || typeof value.cwd !== "string" || !Array.isArray(value.tools)) {
		throw new Error(`Invalid subagent runtime metadata: ${file}`);
	}
	return {
		version: 2,
		cwd: value.cwd,
		model: typeof value.model === "string" ? value.model : undefined,
		thinking: typeof value.thinking === "string" ? value.thinking : undefined,
		tools: value.tools.filter((tool): tool is string => typeof tool === "string"),
	};
}

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function resolveResumePath(input: string): string {
	const expanded = expandHome(input.trim());
	if (!path.isAbsolute(expanded) || path.extname(expanded) !== ".jsonl") {
		throw new Error("`resume` must be the exact absolute JSONL path returned by an earlier subagent call.");
	}
	const resolved = path.resolve(expanded);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`Subagent session not found: ${resolved}`);
	}
	return resolved;
}

function resolveSessionFile(sessionDir: string, result: SubagentResult): void {
	if (result.sessionFile) return;
	try {
		const file = fs.readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"));
		if (file) result.sessionFile = path.join(sessionDir, file);
	} catch {
		// The child may not have created its session yet.
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function addUsage(total: UsageStats, usage: Usage): void {
	total.input += usage.input || 0;
	total.output += usage.output || 0;
	total.cacheRead += usage.cacheRead || 0;
	total.cacheWrite += usage.cacheWrite || 0;
	total.totalTokens = usage.totalTokens || total.totalTokens;
	total.cost.input += usage.cost?.input || 0;
	total.cost.output += usage.cost?.output || 0;
	total.cost.cacheRead += usage.cost?.cacheRead || 0;
	total.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	total.cost.total += usage.cost?.total || 0;
}

function getFinalOutput(result: SubagentResult): string {
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const message = result.messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return result.partialText.trim();
}

function statusOf(result: SubagentResult): "running" | "done" | "failed" | "timeout" | "aborted" {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "timeout") return "timeout";
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "done";
}

function resultOutput(result: SubagentResult): string {
	const parts: string[] = [];
	if (result.errorMessage) parts.push(`Error: ${result.errorMessage}`);
	const output = getFinalOutput(result);
	if (output) parts.push(output);
	else if (result.stderr.trim()) parts.push(result.stderr.trim());
	return parts.join("\n\n") || "(no output)";
}

function truncateResult(output: string): string {
	const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return output;
	return `${truncated.content}\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines, ${truncated.outputBytes} of ${truncated.totalBytes} bytes. Full output is available in the child session.]`;
}

function envelope(result: SubagentResult): string {
	const fields: string[] = [];
	if (result.label) fields.push(`label=${result.label}`);
	fields.push(`status=${statusOf(result)}`);
	if (result.resumed) fields.push("resumed=true");
	if (result.model) fields.push(`model=${result.model}`);
	if (result.thinking) fields.push(`thinking=${result.thinking}`);
	if (result.timeoutMs) fields.push(`timeoutMs=${result.timeoutMs}`);
	if (result.usage.turns) fields.push(`turns=${result.usage.turns}`);
	if (result.usage.cost.total) fields.push(`cost=${result.usage.cost.total.toFixed(4)}`);
	fields.push(`exit=${result.stopReason ?? "end"}`);
	if (result.sessionFile) fields.push(`session=${result.sessionFile}`);
	return `[${fields.join(" ")}]`;
}

function modelFacingResult(result: SubagentResult): string {
	return `${envelope(result)}\n${truncateResult(resultOutput(result))}`;
}

function killChild(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	if (process.platform === "win32" && proc.pid) {
		const killer = spawn("taskkill.exe", ["/pid", String(proc.pid), "/t", "/f"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => proc.kill());
		killer.on("close", (code) => {
			if (code !== 0 && proc.exitCode === null && proc.signalCode === null) proc.kill();
		});
		killer.unref();
		return;
	}
	proc.kill("SIGTERM");
	setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
	}, 5000).unref();
}

type Update = (partial: AgentToolResult<SubagentDetails>) => void;

interface RunChildDependencies {
	agentDir?: string;
	invoke?: (args: string[]) => { command: string; args: string[] };
}

async function runChild(
	config: RunConfig,
	task: string,
	label: string | undefined,
	timeoutMs: number | undefined,
	resumePath: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: Update | undefined,
	dependencies: RunChildDependencies = {},
): Promise<SubagentResult> {
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const sessionDir = path.join(dependencies.agentDir ?? getAgentDir(), "sessions", "subagent", runId);
	if (!resumePath) await fs.promises.mkdir(sessionDir, { recursive: true });

	const args = ["--mode", "json", "-p"];
	if (resumePath) args.push("--session", resumePath);
	else args.push("--session-dir", sessionDir);
	if (config.model) args.push("--model", config.model);
	if (config.thinking) args.push("--thinking", config.thinking);
	if (config.tools.length === 0) args.push("--no-tools");
	else args.push("--tools", config.tools.join(","));
	if (config.tools.some((tool) => INTERNAL_TOOL_NAMES.has(tool))) {
		args.push("--extension", path.join(import.meta.dirname, "index.ts"));
	}
	args.push("--append-system-prompt", CHILD_SYSTEM_GUIDANCE);

	const result: SubagentResult = {
		task,
		label,
		resumed: Boolean(resumePath),
		timeoutMs,
		exitCode: -1,
		messages: [],
		toolActivity: [],
		partialText: "",
		stderr: "",
		usage: EMPTY_USAGE(),
		model: config.model,
		thinking: config.thinking,
		sessionFile: resumePath,
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: result.partialText || getFinalOutput(result) || "(running...)" }],
			details: { result },
		});
	};

	let aborted = false;
	let timedOut = false;
	let currentTurnUsage: Usage | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = (dependencies.invoke ?? getPiInvocation)(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: config.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		const decoder = new StringDecoder("utf8");
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(code);
		};
		const onAbort = () => {
			if (timedOut) return;
			aborted = true;
			if (timeout) clearTimeout(timeout);
			killChild(proc);
		};
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "session" && event.id) {
				result.sessionId = event.id;
				if (!resumePath) resolveSessionFile(sessionDir, result);
				emitUpdate();
				return;
			}
			if (event.type === "message_start" && event.message?.role === "assistant") {
				result.partialText = "";
				currentTurnUsage = undefined;
				result.usage.turns++;
				return;
			}
			if (event.type === "message_update") {
				if (event.usage) currentTurnUsage = event.usage as Usage;
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta" && typeof delta.delta === "string") {
					result.partialText += delta.delta;
					emitUpdate();
				}
				return;
			}
			if (event.type === "tool_execution_start") {
				result.toolActivity.push({
					id: String(event.toolCallId ?? ""),
					name: String(event.toolName ?? "unknown"),
					args: event.args && typeof event.args === "object" ? event.args : {},
					status: "running",
				});
				emitUpdate();
				return;
			}
			if (event.type === "tool_execution_end") {
				const activity = result.toolActivity.find((item) => item.id === String(event.toolCallId ?? ""));
				if (activity) activity.status = event.isError ? "error" : "done";
				emitUpdate();
				return;
			}
			if (event.type === "message_end" && event.message) {
				const message = event.message as Message;
				result.messages.push(message);
				if (message.role === "assistant") {
					result.partialText = "";
					currentTurnUsage = undefined;
					if (message.usage) addUsage(result.usage, message.usage);
					const reportedModel = message.model as string | undefined;
					const provider = (message as any).provider as string | undefined;
					if (reportedModel && !config.model) {
						result.model = provider ? `${provider}/${reportedModel}` : reportedModel;
						config.model = result.model;
					}
					if (message.stopReason) result.stopReason = message.stopReason;
					if (message.errorMessage) result.errorMessage = message.errorMessage;
				}
				emitUpdate();
				return;
			}
		};

		proc.stdin?.on("error", () => {});
		proc.stdin?.end(task);
		proc.stdout?.on("data", (data) => {
			buffer += decoder.write(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			buffer += decoder.end();
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});
		proc.on("error", (error) => {
			result.errorMessage = error.message;
			finish(1);
		});

		if (timeoutMs) {
			timeout = setTimeout(() => {
				if (aborted) return;
				timedOut = true;
				killChild(proc);
			}, timeoutMs);
		}
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});

	result.exitCode = exitCode;
	if (currentTurnUsage) addUsage(result.usage, currentTurnUsage);
	if (!resumePath) {
		resolveSessionFile(sessionDir, result);
		if (!result.sessionFile) {
			result.errorMessage = "Child session was not created; this run cannot be resumed.";
			if (!timedOut && !aborted) result.exitCode = 1;
		} else {
			try {
				writeChildMetadata(result.sessionFile, {
					version: 2,
					cwd: config.cwd,
					model: config.model,
					thinking: config.thinking,
					tools: config.tools,
				});
			} catch (error) {
				result.errorMessage = `Child finished, but resume metadata could not be saved: ${error instanceof Error ? error.message : String(error)}`;
				if (!timedOut && !aborted) result.exitCode = 1;
			}
		}
	}
	if (timedOut) result.stopReason = "timeout";
	else if (aborted) result.stopReason = "aborted";
	return result;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function usageText(result: SubagentResult): string {
	const parts: string[] = [];
	if (result.usage.turns) parts.push(`${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"}`);
	if (result.usage.input) parts.push(`↑${formatTokens(result.usage.input)}`);
	if (result.usage.output) parts.push(`↓${formatTokens(result.usage.output)}`);
	if (result.usage.cacheRead) parts.push(`R${formatTokens(result.usage.cacheRead)}`);
	if (result.usage.cacheWrite) parts.push(`W${formatTokens(result.usage.cacheWrite)}`);
	if (result.usage.cost.total) parts.push(`$${result.usage.cost.total.toFixed(4)}`);
	if (result.usage.totalTokens) parts.push(`ctx:${formatTokens(result.usage.totalTokens)}`);
	if (result.model) parts.push(result.model);
	if (result.thinking) parts.push(result.thinking);
	return parts.join(" ");
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
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
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
	if (item.type === "toolResult") {
		const first = item.text.trim().split("\n")[0] || "(no output)";
		return `← ${item.name}${item.isError ? " failed" : ""}: ${first.slice(0, 160)}`;
	}
	return item.text.split("\n").slice(0, 3).join("\n");
}

const SubagentParams = Type.Object({
	task: Type.String({ minLength: 1, description: "Self-contained task for a fresh child, or the next direction for a resumed child." }),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._:-]+$", description: "Short correlation label echoed in the result." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Pi model pattern or provider/id for a fresh child. With model policy enabled, use an exact id from subagent_models." })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level for a fresh child." })),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, description: "Tool allowlist for a fresh child. Include subagent explicitly to permit recursive delegation." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory for a fresh child. Defaults to the parent cwd." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Review horizon in milliseconds. Returns partial work and a resumable session on expiry." })),
	resume: Type.Optional(Type.String({ minLength: 1, description: "Exact absolute session JSONL path returned by an earlier subagent call." })),
});

const SUBAGENT_GUIDELINES = [
	"Use subagent for focused work that benefits from an isolated context; give it a self-contained task with relevant constraints and the desired output.",
	"Issue multiple independent subagent calls in one response to run them concurrently through Pi; avoid overlapping file edits.",
	"Choose the narrowest subagent tools set that can complete the task, and grant the subagent tool itself only when recursive delegation is genuinely needed.",
	"Use subagent timeoutMs as the next supervision point for longer work, not only as a hang guard.",
	"A subagent is instructed to return when it needs clarification or a decision; answer by resuming its session with the required direction.",
	"Prefer resuming a useful subagent session over starting again; after a timeout, resume it for a concise state assessment before deciding the next direction.",
	"Call subagent_models once when child model choice matters and reuse its compact catalog for later delegations.",
];

export const __testing = {
	allowedThinkingLevels,
	compactModelCatalog,
	envelope,
	loadModelPolicy,
	metadataPath,
	modelFacingResult,
	readChildMetadata,
	resolveFreshModel,
	runChild,
	statusOf,
	validateModelPolicy,
	writeChildMetadata,
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_models",
		label: "Subagent Models",
		description: "Return the configured child-model allowlist, permitted thinking levels, optional benchmarks, and default. No child is started.",
		promptSnippet: "Inspect the curated child-model catalog when model choice matters",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { policy, error } = loadModelPolicy();
			if (error) throw new Error(error);
			const validationErrors = validateModelPolicy(policy, ctx.modelRegistry);
			const catalog = compactModelCatalog(policy, validationErrors);
			return {
				content: [{ type: "text", text: JSON.stringify(catalog) }],
				details: catalog,
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run one synchronous, isolated, observable child Pi task. The result includes a persisted session path that can be resumed with new direction.",
		promptSnippet: "Delegate one focused task to an isolated, observable, resumable Pi session",
		promptGuidelines: SUBAGENT_GUIDELINES,
		parameters: SubagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be blank.");
			const { policy, error: policyError } = loadModelPolicy();
			if (policyError) throw new Error(policyError);
			const validationErrors = validateModelPolicy(policy, ctx.modelRegistry);
			if (validationErrors.length > 0) throw new Error(validationErrors.join("\n"));

			let resumePath: string | undefined;
			let config: RunConfig;
			if (params.resume) {
				if (params.model || params.thinking || params.tools || params.cwd) {
					throw new Error("A resumed subagent accepts only task, resume, label, and timeoutMs. Start a fresh child to change runtime configuration.");
				}
				resumePath = resolveResumePath(params.resume);
				const saved = readChildMetadata(resumePath);
				if (policy.enabled && !saved.model) {
					throw new Error("The resumed session does not record a verifiable model. Start a fresh child using the current model policy.");
				}
				if (policy.enabled && saved.model && !policy.allowed.has(saved.model)) {
					throw new Error(`The resumed session uses model "${saved.model}", which is no longer permitted.`);
				}
				const levels = saved.model ? allowedThinkingLevels(policy.metadata.get(saved.model)) : undefined;
				if (policy.enabled && levels && !saved.thinking) {
					throw new Error(`The resumed session does not record a thinking level required by the current policy for "${saved.model}".`);
				}
				if (policy.enabled && saved.thinking && levels && !levels.includes(saved.thinking)) {
					throw new Error(`The resumed session uses thinking level "${saved.thinking}", which is no longer permitted for "${saved.model}".`);
				}
				config = saved;
			} else {
				const selected = resolveFreshModel(params.model, params.thinking, policy);
				if (selected.error) throw new Error(selected.error);
				const inheritedTools = pi.getActiveTools().filter((name) => !INTERNAL_TOOL_NAMES.has(name));
				config = {
					cwd: path.resolve(params.cwd ?? ctx.cwd),
					model: selected.model,
					thinking: params.thinking,
					tools: params.tools ? [...new Set(params.tools)] : inheritedTools,
				};
			}

			const result = await runChild(
				config,
				params.task,
				params.label,
				params.timeoutMs,
				resumePath,
				signal,
				onUpdate,
			);
			return {
				content: [{ type: "text", text: modelFacingResult(result) }],
				details: { result },
				usage: result.usage,
			};
		},
		renderCall(args, theme) {
			const preview = args.task.length > 72 ? `${args.task.slice(0, 72)}…` : args.task;
			const identity = args.label ?? (args.resume ? "resume" : "child");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", identity)}\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},
		renderResult(toolResult, { expanded }, theme) {
			const details = toolResult.details as SubagentDetails | undefined;
			if (!details?.result) {
				const content = toolResult.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const result = details.result;
			const status = statusOf(result);
			const success = status === "done";
			const icon = status === "running"
				? theme.fg("warning", "⏳")
				: success
					? theme.fg("success", "✓")
					: theme.fg(status === "timeout" ? "warning" : "error", "✗");
			const title = result.label ?? (result.resumed ? "resumed child" : "child");
			const items = displayItems(result);

			if (!expanded) {
				const recent = items.slice(-COLLAPSED_ITEM_COUNT);
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(success ? "success" : "warning", status)}`;
				if (items.length > recent.length) text += `\n${theme.fg("muted", `… ${items.length - recent.length} earlier items`)}`;
				for (const item of recent) text += `\n${theme.fg(item.type === "toolResult" && item.isError ? "error" : "dim", compactItem(item))}`;
				for (const activity of result.toolActivity.filter((item) => item.status === "running")) {
					text += `\n${theme.fg("warning", `⚙ ${formatToolCall(activity.name, activity.args)}`)}`;
				}
				const stats = usageText(result);
				if (stats) text += `\n${theme.fg("dim", stats)}`;
				if (result.sessionFile) text += `\n${theme.fg("dim", `session: ${result.sessionFile}`)}`;
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(success ? "success" : "warning", status)}`, 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "── Task ──"), 0, 0));
			container.addChild(new Text(result.task, 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "── Activity ──"), 0, 0));
			for (const item of items) {
				if (item.type === "text") continue;
				container.addChild(new Text(theme.fg(item.type === "toolResult" && item.isError ? "error" : "dim", compactItem(item)), 0, 0));
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "── Result ──"), 0, 0));
			container.addChild(new Markdown(resultOutput(result), 0, 0, getMarkdownTheme()));
			const stats = usageText(result);
			if (stats) container.addChild(new Text(theme.fg("dim", stats), 0, 0));
			if (result.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${result.sessionFile}`), 0, 0));
			return container;
		},
	});
}
