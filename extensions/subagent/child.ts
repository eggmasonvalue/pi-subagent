// One child Pi process: spawn it in JSON mode, stream its events into a result, and persist what a
// resume needs next to its session.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, type JsonAgentSessionEvent, truncateHead } from "@earendil-works/pi-coding-agent";

const CHILD_SYSTEM_GUIDANCE =
	"Work independently on the delegated task. If you cannot proceed reliably without clarification, a decision, or missing information, stop and return the precise question or blocker to your supervisor. Do not guess or wait. Your supervisor can resume this session with an answer.";
const METADATA_SUFFIX = ".subagent.json";
export const INTERNAL_TOOL_NAMES = new Set(["subagent", "subagent_models"]);

export interface RunConfig {
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools: string[];
}

interface ChildMetadata extends RunConfig {
	version: 2;
	label?: string;
}

export interface UsageStats extends Usage {
	turns: number;
}

export interface ToolActivity {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
}

export type Status = "running" | "done" | "failed" | "timeout" | "aborted";

export interface SubagentResult {
	task: string;
	label?: string;
	resumed: boolean;
	timeoutMs?: number;
	startedAt: number;
	endedAt?: number;
	/** -1 while running. */
	exitCode: number;
	messages: Message[];
	toolActivity: ToolActivity[];
	partialText: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	contextWindow?: number;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionFile?: string;
}

/** What /subagents needs about one finished call, persisted as a custom session entry. */
export type RunSummary = Pick<
	SubagentResult,
	"task" | "label" | "resumed" | "timeoutMs" | "startedAt" | "endedAt" | "exitCode" | "stopReason" | "model" | "thinking" | "contextWindow" | "sessionFile"
> & { usage: { totalTokens: number } };

export function summarize(result: SubagentResult): RunSummary {
	const { task, label, resumed, timeoutMs, startedAt, endedAt, exitCode, stopReason, model, thinking, contextWindow, sessionFile } = result;
	return { task, label, resumed, timeoutMs, startedAt, endedAt, exitCode, stopReason, model, thinking, contextWindow, sessionFile, usage: { totalTokens: result.usage.totalTokens } };
}

const emptyUsage = (): UsageStats => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	turns: 0,
});

function addUsage(total: UsageStats, usage: Usage): void {
	total.input += usage.input || 0;
	total.output += usage.output || 0;
	total.cacheRead += usage.cacheRead || 0;
	total.cacheWrite += usage.cacheWrite || 0;
	// The last turn's total is the context fill, not a sum.
	total.totalTokens = usage.totalTokens || total.totalTokens;
	total.cost.input += usage.cost?.input || 0;
	total.cost.output += usage.cost?.output || 0;
	total.cost.cacheRead += usage.cost?.cacheRead || 0;
	total.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	total.cost.total += usage.cost?.total || 0;
}

// ── Resume metadata ──────────────────────────────────────────────────────────────────────────────

const metadataPath = (sessionFile: string) => `${sessionFile}${METADATA_SUFFIX}`;

export function writeChildMetadata(sessionFile: string, metadata: Omit<ChildMetadata, "version">): void {
	const destination = metadataPath(sessionFile);
	const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify({ version: 2, ...metadata }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, destination);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function readChildMetadata(sessionFile: string): ChildMetadata {
	const file = metadataPath(sessionFile);
	let value: Partial<ChildMetadata>;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`Subagent runtime metadata not found or invalid: ${file}`);
	}
	if (value?.version !== 2 || typeof value.cwd !== "string" || !Array.isArray(value.tools)) {
		throw new Error(`Invalid subagent runtime metadata: ${file}`);
	}
	const string = (field: unknown) => (typeof field === "string" ? field : undefined);
	return {
		version: 2,
		label: string(value.label),
		cwd: value.cwd,
		model: string(value.model),
		thinking: string(value.thinking) as ThinkingLevel | undefined,
		tools: value.tools.filter((tool): tool is string => typeof tool === "string"),
	};
}

export function resolveResumePath(input: string): string {
	let expanded = input.trim();
	if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = path.join(os.homedir(), expanded.slice(2));
	if (!path.isAbsolute(expanded) || path.extname(expanded) !== ".jsonl") {
		throw new Error("`resume` must be the exact absolute JSONL path returned by an earlier subagent call.");
	}
	const resolved = path.resolve(expanded);
	if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`Subagent session not found: ${resolved}`);
	return resolved;
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────────

export function statusOf(result: Pick<SubagentResult, "exitCode" | "stopReason">): Status {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "timeout") return "timeout";
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode !== 0 || result.stopReason === "error") return "failed";
	return "done";
}

/** The child's last words: in-progress text after a timeout or abort, else its last assistant text. */
export function finalText(result: SubagentResult): string {
	if (result.partialText.trim()) return result.partialText.trim();
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const message = result.messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
		if (text) return text;
	}
	return "";
}

export function resultOutput(result: SubagentResult): string {
	const parts: string[] = [];
	if (result.errorMessage) parts.push(`Error: ${result.errorMessage}`);
	parts.push(finalText(result) || result.stderr.trim());
	return parts.filter(Boolean).join("\n\n") || "(no output)";
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Compact duration: "750ms", "1.5s", "2m 5s", "1h 5m". */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 59_950) return `${Math.round(ms / 100) / 10}s`;
	const [step, unit, subunit] = ms < 3_599_500 ? [1000, "m", "s"] : [60_000, "h", "m"];
	const total = Math.round(ms / step);
	const rest = total % 60;
	return `${Math.floor(total / 60)}${unit}${rest ? ` ${rest}${subunit}` : ""}`;
}

/** Last turn's tokens against the model's window, e.g. "42%/200k"; just the tokens if the window is unknown. */
export function contextText(result: Pick<RunSummary, "usage" | "contextWindow">): string {
	const used = result.usage.totalTokens;
	if (!used) return "";
	if (!result.contextWindow) return formatTokens(used);
	return `${Math.round((used / result.contextWindow) * 100)}%/${formatTokens(result.contextWindow)}`;
}

export function envelope(result: SubagentResult): string {
	const context = contextText(result);
	return `[${[
		result.label && `label=${result.label}`,
		`status=${statusOf(result)}`,
		context && `context=${context}`,
		result.sessionFile && `session=${result.sessionFile}`,
	].filter(Boolean).join(" ")}]`;
}

/** Text for the parent model: the envelope, then the output capped at Pi's standard limits. */
export function modelFacingResult(result: SubagentResult): string {
	const output = resultOutput(result);
	const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return `${envelope(result)}\n${output}`;
	const hint = result.sessionFile
		? ` Read the last assistant message in the child session JSONL at ${result.sessionFile} if the complete response is needed.`
		: " The complete response may be available in the child session JSONL.";
	return `${envelope(result)}\n${truncated.content}\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines, ${truncated.outputBytes} of ${truncated.totalBytes} bytes.]${hint}`;
}

/** What a codemode script receives: the same facts as the text, with the output uncapped. */
export function structuredResult(result: SubagentResult) {
	const status = statusOf(result) as Exclude<Status, "running">;
	const error = [result.errorMessage, status === "failed" && result.stderr.trim().slice(-4000)].filter(Boolean).join("\n");
	return {
		status,
		output: finalText(result),
		...(error ? { error } : {}),
		...(result.label ? { label: result.label } : {}),
		...(result.sessionFile ? { session: result.sessionFile } : {}),
		...(result.usage.totalTokens ? { contextTokens: result.usage.totalTokens } : {}),
		...(result.contextWindow ? { contextWindow: result.contextWindow } : {}),
	};
}

// ── Process ──────────────────────────────────────────────────────────────────────────────────────

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	// Bun-compiled binaries report a virtual entry: "/$bunfs/root/..." on POSIX, "B:/~BUN/root/..." on Windows.
	const virtual = script !== undefined && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script));
	if (script && !virtual && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	if (!/^(node|bun)(\.exe)?$/.test(path.basename(process.execPath).toLowerCase())) return { command: process.execPath, args };
	return { command: "pi", args };
}

function killTree(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	if (process.platform === "win32" && proc.pid) {
		const killer = spawn("taskkill.exe", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
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

function firstSessionFile(sessionDir: string): string | undefined {
	try {
		const file = fs.readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"));
		return file && path.join(sessionDir, file);
	} catch {
		return undefined; // Not created yet.
	}
}

export interface RunRequest {
	config: RunConfig;
	task: string;
	label?: string;
	timeoutMs?: number;
	/** Session to continue; a fresh child gets a new run directory. */
	resume?: string;
	signal?: AbortSignal;
	/** Called with the live result whenever it changes. */
	onUpdate?: (result: SubagentResult) => void;
}

export interface RunDependencies {
	agentDir?: string;
	invoke?: (args: string[]) => { command: string; args: string[] };
}

type ChildEvent = JsonAgentSessionEvent | { type: "session"; id: string };

export async function runChild(request: RunRequest, dependencies: RunDependencies = {}): Promise<SubagentResult> {
	const { config, task, label, timeoutMs, resume, signal, onUpdate } = request;
	const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const sessionDir = path.join(dependencies.agentDir ?? getAgentDir(), "sessions", "subagent", runId);
	if (!resume) await fs.promises.mkdir(sessionDir, { recursive: true });

	const args = ["--mode", "json", "-p", ...(resume ? ["--session", resume] : ["--session-dir", sessionDir])];
	if (config.model) args.push("--model", config.model);
	if (config.thinking) args.push("--thinking", config.thinking);
	args.push(...(config.tools.length ? ["--tools", config.tools.join(",")] : ["--no-tools"]));
	if (config.tools.some((tool) => INTERNAL_TOOL_NAMES.has(tool))) args.push("--extension", path.join(import.meta.dirname, "index.ts"));
	args.push("--append-system-prompt", CHILD_SYSTEM_GUIDANCE);

	const result: SubagentResult = {
		task,
		label,
		resumed: Boolean(resume),
		timeoutMs,
		startedAt: Date.now(),
		exitCode: -1,
		messages: [],
		toolActivity: [],
		partialText: "",
		stderr: "",
		usage: emptyUsage(),
		model: config.model,
		thinking: config.thinking,
		sessionFile: resume,
	};
	const update = () => onUpdate?.(result);

	let stoppedBy: "timeout" | "aborted" | undefined;
	let turnUsage: Usage | undefined;

	const handle = (event: ChildEvent) => {
		// Pi creates the session file when it persists the first message, after the session event.
		if (!result.sessionFile && (result.sessionFile = firstSessionFile(sessionDir))) update();
		switch (event.type) {
			case "message_start":
				if (event.message.role !== "assistant") return;
				result.partialText = "";
				turnUsage = undefined;
				result.usage.turns++;
				return;
			case "message_update":
				turnUsage = event.usage;
				if (event.assistantMessageEvent.type === "text_delta") {
					result.partialText += event.assistantMessageEvent.delta;
					update();
				}
				return;
			case "tool_execution_start":
				result.toolActivity.push({ id: event.toolCallId, name: event.toolName, args: event.args ?? {}, status: "running" });
				update();
				return;
			case "tool_execution_end": {
				const activity = result.toolActivity.find((item) => item.id === event.toolCallId);
				if (activity) activity.status = event.isError ? "error" : "done";
				update();
				return;
			}
			case "message_end": {
				const message = event.message as Message;
				result.messages.push(message);
				if (message.role === "assistant") {
					result.partialText = "";
					// A terminal error message may carry no usage after usage was already streamed.
					const usage = message.usage ?? turnUsage;
					turnUsage = undefined;
					if (usage) addUsage(result.usage, usage);
					if (!config.model && message.model) config.model = result.model = `${message.provider}/${message.model}`;
					if (message.stopReason) result.stopReason = message.stopReason;
					if (message.errorMessage) result.errorMessage = message.errorMessage;
				}
				update();
				return;
			}
		}
	};

	result.exitCode = await new Promise<number>((resolve) => {
		const invocation = (dependencies.invoke ?? piInvocation)(args);
		const proc = spawn(invocation.command, invocation.args, { cwd: config.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let timer: ReturnType<typeof setTimeout> | undefined;

		const stop = (reason: "timeout" | "aborted") => {
			if (stoppedBy) return;
			stoppedBy = reason;
			killTree(proc);
		};
		const onAbort = () => stop("aborted");
		const finish = (code: number) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(code);
		};
		const processLines = (text: string) => {
			for (const line of text.split("\n")) {
				let event: ChildEvent;
				try {
					event = JSON.parse(line);
				} catch {
					continue; // Blank or not an event.
				}
				if (event?.type) handle(event);
			}
		};

		proc.stdin.on("error", () => {});
		proc.stdin.end(task);
		proc.stdout.on("data", (data) => {
			buffer += decoder.write(data);
			const end = buffer.lastIndexOf("\n");
			if (end < 0) return;
			processLines(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
		});
		proc.stderr.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code, killedBy) => {
			processLines(buffer + decoder.end());
			// A child killed from outside, not by a timeout or abort, failed.
			if (code === null && !stoppedBy) result.errorMessage ??= `Child terminated by ${killedBy ?? "a signal"}.`;
			finish(code ?? 1);
		});
		proc.on("error", (error) => {
			result.errorMessage = error.message;
			finish(1);
		});

		if (timeoutMs) timer = setTimeout(() => stop("timeout"), timeoutMs);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});

	if (turnUsage) addUsage(result.usage, turnUsage);
	if (!resume) {
		result.sessionFile ??= firstSessionFile(sessionDir);
		try {
			if (!result.sessionFile) throw new Error("Child session was not created; this run cannot be resumed.");
			writeChildMetadata(result.sessionFile, { label, ...config });
		} catch (error) {
			result.errorMessage = result.sessionFile
				? `Child finished, but resume metadata could not be saved: ${(error as Error).message}`
				: (error as Error).message;
			if (!stoppedBy) result.exitCode = 1;
		}
	}
	if (stoppedBy) result.stopReason = stoppedBy;
	result.endedAt = Date.now();
	return result;
}
