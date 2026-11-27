// /subagents: a read-only browser for the child sessions of the current branch. Human-only; the model
// never sees it. Finished calls come from the custom entries the tool appends to the branch, which
// also covers calls made from codemode scripts; running ones come from the in-memory registry the
// tool updates. A transcript is the child's own session file rendered with Pi's message and tool
// components, tailed as the running child appends to it.

import * as fs from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	copyToClipboard,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	CustomMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	parseSessionEntries,
	type SessionEntry,
	sessionEntryToContextMessages,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Key, Markdown, matchesKey, SelectList, Spacer, stripTerminalSequences, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { contextText, formatDuration, type RunSummary, statusOf, type SubagentResult } from "./child.ts";

/** Custom session entry recording one finished subagent call. */
export const RUN_ENTRY_TYPE = "subagent-run";

/** Subagent calls this process is running, keyed by tool call id, holding the result objects the tool mutates. */
export class LiveRuns {
	private readonly runs = new Map<string, SubagentResult>();
	private readonly listeners = new Set<() => void>();

	update(toolCallId: string, result: SubagentResult): void {
		this.runs.set(toolCallId, result);
		this.emit();
	}

	end(toolCallId: string): void {
		this.runs.delete(toolCallId);
		this.emit();
	}

	entries(): IterableIterator<[string, SubagentResult]> {
		return this.runs.entries();
	}

	isRunning(sessionFile: string): boolean {
		for (const result of this.runs.values()) if (result.sessionFile === sessionFile) return true;
		return false;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export interface ViewerDeps {
	runs: LiveRuns;
	/** This extension's own tool definitions, so nested subagent rows render as they do in the parent. */
	toolDefinitions: Record<string, ToolDefinition<any, any>>;
}

interface Child {
	sessionFile: string;
	label?: string;
	/** The assignment that created the child; names it when it has no label. */
	task: string;
	/** The latest call: live while running, final otherwise. */
	result: RunSummary & { partialText?: string };
	running: boolean;
	order: number;
}

/** Child sessions of a branch, one per session file, running first and then most recent first. */
function listChildren(branch: SessionEntry[], runs: LiveRuns): Child[] {
	const children = new Map<string, Child>();
	const record = (result: Child["result"], running: boolean, order: number) => {
		if (!result.sessionFile) return;
		const previous = children.get(result.sessionFile);
		children.set(result.sessionFile, {
			sessionFile: result.sessionFile,
			label: result.label ?? previous?.label,
			task: previous?.task ?? result.task,
			result,
			running,
			order,
		});
	};
	const calls: string[] = [];
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE && entry.data) {
			record(entry.data as RunSummary, false, Date.parse(entry.timestamp));
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			for (const part of entry.message.content) if (part.type === "toolCall") calls.push(part.id);
		}
	}
	// A running call belongs to this branch when it, or the codemode call whose script made it
	// ("<parent id>/<n>"), was issued on the branch.
	for (const [toolCallId, result] of runs.entries()) {
		if (calls.some((id) => toolCallId === id || toolCallId.startsWith(`${id}/`))) record(result, true, Number.POSITIVE_INFINITY);
	}
	return [...children.values()].sort((a, b) => b.order - a.order);
}

/** One-line status, e.g. "done · 1m 5s · provider/model high · ctx 42%/200k". */
function summaryLine(result: RunSummary): string {
	return [
		statusOf(result),
		formatDuration(Math.max(0, (result.endedAt ?? Date.now()) - result.startedAt)),
		[result.model, result.thinking].filter(Boolean).join(" "),
		contextText(result) && `ctx ${contextText(result)}`,
	].filter(Boolean).join(" · ");
}

function childName(child: Child): string {
	if (child.label) return child.label;
	const task = child.task.replace(/\s+/g, " ").trim();
	return task.length > 40 ? `${task.slice(0, 40)}…` : task;
}

function statusIcon(child: Child, theme: Theme): string {
	const status = statusOf(child.result);
	if (status === "running") return theme.fg("warning", "⏳");
	return status === "done" ? theme.fg("success", "✓") : theme.fg(status === "timeout" ? "warning" : "error", "✗");
}

/** "↑/↓ scroll · esc close" from the user's configured keys. */
function hints(keybindings: KeybindingsManager, entries: [ids: string[], label: string][]): string {
	return entries
		.map(([ids, label]) => `${ids.map((id) => keybindings.getKeys(id as never).join("/")).filter(Boolean).join(" ")} ${label}`)
		.join(" · ");
}

function builtInToolDefinitions(cwd: string): Record<string, ToolDefinition<any, any>> {
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		powershell: createPowerShellToolDefinition(cwd),
	} as Record<string, ToolDefinition<any, any>>;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** Session branch from root to the last entry, the way Pi itself reads a conversation. */
function branchOf(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry);
	return branch.reverse();
}

function sessionEntries(content: string): SessionEntry[] {
	return parseSessionEntries(content).filter((entry): entry is SessionEntry => entry.type !== "session");
}

type TranscriptAction = "copy" | undefined;

// Pi's transcript components emit OSC sequences such as semantic-prompt marks for the main screen.
// Inside an overlay they would desynchronize the terminal from the redraw, so they are dropped;
// colour (SGR) is kept.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

class Transcript implements Component {
	private readonly body = new Container();
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private readonly tools: Record<string, ToolDefinition<any, any>>;
	private offset = 0;
	private expanded = false;
	private follow = true;
	private scroll = 0;
	private layout = { lines: 0, viewport: 1, prompts: [] as number[] };
	private stopLive?: () => void;
	private readonly child: Child;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly hints: string;
	private readonly deps: ViewerDeps;
	private readonly cwd: string;
	private readonly done: (action: TranscriptAction) => void;

	constructor(
		child: Child,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		deps: ViewerDeps,
		cwd: string,
		done: (action: TranscriptAction) => void,
	) {
		this.child = child;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.hints = hints(keybindings, [
			[["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"], "home/end scroll"],
			[["tui.altScreen.previousPrompt", "tui.altScreen.nextPrompt"], "prompts"],
			[["app.tools.expand"], "expand"],
			[["tui.select.confirm"], "copy open command"],
			[["tui.select.cancel"], "close"],
		]);
		this.deps = deps;
		this.cwd = cwd;
		this.done = done;
		this.tools = { ...builtInToolDefinitions(cwd), ...deps.toolDefinitions };
		const content = this.readFrom(0);
		for (const entry of branchOf(sessionEntries(content))) this.appendEntry(entry);
		if (child.running) {
			// Event-driven while the child runs: every update the tool receives is a chance to pick up
			// newly persisted entries; a one-second tick keeps the elapsed time moving between them.
			const unsubscribe = deps.runs.subscribe(() => this.refresh());
			const ticker = setInterval(() => this.tui.requestRender(), 1000);
			this.stopLive = () => {
				unsubscribe();
				clearInterval(ticker);
			};
		}
	}

	dispose(): void {
		this.stopLive?.();
	}

	/** Complete lines appended since `start`; a line still being written is left for the next read. */
	private readFrom(start: number): string {
		let text: string;
		try {
			const size = fs.statSync(this.child.sessionFile).size;
			if (size <= start) return "";
			const buffer = Buffer.alloc(size - start);
			const fd = fs.openSync(this.child.sessionFile, "r");
			try {
				fs.readSync(fd, buffer, 0, buffer.length, start);
			} finally {
				fs.closeSync(fd);
			}
			text = buffer.toString("utf8");
		} catch {
			return "";
		}
		const complete = text.slice(0, text.lastIndexOf("\n") + 1);
		this.offset = start + Buffer.byteLength(complete);
		return complete;
	}

	private refresh(): void {
		for (const entry of sessionEntries(this.readFrom(this.offset))) this.appendEntry(entry);
		if (!this.deps.runs.isRunning(this.child.sessionFile)) {
			this.child.running = false;
			this.stopLive?.();
			this.stopLive = undefined;
		}
		this.tui.requestRender();
	}

	private appendEntry(entry: SessionEntry): void {
		for (const message of sessionEntryToContextMessages(entry)) {
			const start = this.body.children.length;
			this.appendMessage(message);
			if (this.expanded) for (const component of this.body.children.slice(start)) setExpanded(component, true);
		}
	}

	private appendMessage(message: AgentMessage): void {
		const markdown = getMarkdownTheme();
		switch (message.role) {
			case "user": {
				const text = messageText(message);
				if (!text) return;
				if (this.body.children.length > 0) this.body.addChild(new Spacer(1));
				this.body.addChild(new UserMessageComponent(text, markdown));
				return;
			}
			case "assistant": {
				this.body.addChild(new AssistantMessageComponent(message, false, markdown));
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const row = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false }, this.tools[part.name], this.tui, this.cwd);
					row.setArgsComplete();
					row.markExecutionStarted();
					this.body.addChild(row);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						row.updateResult({ content: [{ type: "text", text: message.errorMessage || message.stopReason }], isError: true });
					} else {
						this.pendingTools.set(part.id, row);
					}
				}
				return;
			}
			case "toolResult": {
				const row = this.pendingTools.get(message.toolCallId);
				if (!row) return;
				this.pendingTools.delete(message.toolCallId);
				// Recorded tool output can carry terminal control sequences (shell-integration marks,
				// cursor moves) that would corrupt the overlay; colour is lost, nothing else is.
				const content = message.content.map((part) => (part.type === "text" ? { ...part, text: stripTerminalSequences(part.text) } : part));
				row.updateResult({ ...message, content }, false);
				setExpanded(row, this.expanded);
				return;
			}
			case "compactionSummary":
				this.body.addChild(new Spacer(1));
				this.body.addChild(new CompactionSummaryMessageComponent(message, markdown));
				return;
			case "branchSummary":
				this.body.addChild(new Spacer(1));
				this.body.addChild(new BranchSummaryMessageComponent(message, markdown));
				return;
			case "custom":
				if (message.display) this.body.addChild(new CustomMessageComponent(message, undefined, markdown));
				return;
			default:
				return;
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const prompts: number[] = [];
		for (const component of this.body.children) {
			if (component instanceof UserMessageComponent) prompts.push(lines.length);
			lines.push(...component.render(width));
		}
		const partial = this.child.running ? (this.child.result.partialText ?? "").trim() : "";
		if (partial) lines.push(...new Markdown(partial, 1, 0, getMarkdownTheme()).render(width));

		const viewport = Math.max(1, this.tui.terminal.rows - 2);
		const max = Math.max(0, lines.length - viewport);
		this.scroll = this.follow ? max : Math.min(Math.max(0, this.scroll), max);
		this.layout = { lines: lines.length, viewport, prompts };

		const header = `${statusIcon(this.child, theme)} ${theme.fg("toolTitle", theme.bold(childName(this.child)))} ${theme.fg("dim", summaryLine(this.child.result))}`;
		const position = lines.length > viewport ? ` · ${Math.round(((this.scroll + viewport) / lines.length) * 100)}%` : "";
		const footer = theme.fg("dim", `${this.hints}${position}`);
		const window = lines.slice(this.scroll, this.scroll + viewport);
		while (window.length < viewport) window.push("");
		return [header, ...window, footer].map((line) => truncateToWidth(line.replace(OSC, ""), width));
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const { lines, viewport, prompts } = this.layout;
		const max = Math.max(0, lines - viewport);
		const scrollTo = (target: number) => {
			this.scroll = Math.min(Math.max(0, target), max);
			this.follow = this.scroll >= max;
		};
		if (kb.matches(data, "tui.select.cancel")) return this.done(undefined);
		if (kb.matches(data, "tui.select.confirm")) return this.done("copy");
		if (kb.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			for (const component of this.body.children) setExpanded(component, this.expanded);
		} else if (kb.matches(data, "tui.altScreen.previousPrompt")) scrollTo(prompts.filter((line) => line < this.scroll).at(-1) ?? 0);
		else if (kb.matches(data, "tui.altScreen.nextPrompt")) scrollTo(prompts.find((line) => line > this.scroll) ?? max);
		else if (kb.matches(data, "tui.select.up")) scrollTo(this.scroll - 1);
		else if (kb.matches(data, "tui.select.down")) scrollTo(this.scroll + 1);
		else if (kb.matches(data, "tui.select.pageUp")) scrollTo(this.scroll - viewport);
		else if (kb.matches(data, "tui.select.pageDown")) scrollTo(this.scroll + viewport);
		else if (matchesKey(data, Key.home)) scrollTo(0);
		else if (matchesKey(data, Key.end)) scrollTo(max);
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.body.invalidate();
	}
}

function setExpanded(component: Component, expanded: boolean): void {
	(component as { setExpanded?: (value: boolean) => void }).setExpanded?.(expanded);
}

function pickChild(ctx: ExtensionContext, children: Child[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const list = new SelectList(
			children.map((child) => ({
				value: child.sessionFile,
				label: `${statusIcon(child, theme)} ${childName(child)}`,
				description: summaryLine(child.result),
			})),
			Math.min(children.length, 12),
			getSelectListTheme(),
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagents on this branch")), 0, 0));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", hints(keybindings, [
			[["tui.select.up", "tui.select.down"], "navigate"],
			[["tui.select.confirm"], "open"],
			[["tui.select.cancel"], "close"],
		])), 0, 0));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export function registerViewer(pi: ExtensionAPI, deps: ViewerDeps): void {
	let sessionManager: ExtensionContext["sessionManager"] | undefined;
	pi.on("session_start", (_event, ctx) => {
		sessionManager = ctx.sessionManager;
	});

	pi.registerCommand("subagents", {
		description: "Browse this branch's subagent sessions, live while they run",
		getArgumentCompletions(prefix) {
			if (!sessionManager) return null;
			const labels = new Map<string, Child>();
			for (const child of listChildren(sessionManager.getBranch(), deps.runs)) {
				if (child.label?.startsWith(prefix) && !labels.has(child.label)) labels.set(child.label, child);
			}
			return [...labels].map(([label, child]) => ({ value: label, label, description: summaryLine(child.result) }));
		},
		async handler(args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagents requires the interactive TUI.", "error");
				return;
			}
			const children = listChildren(ctx.sessionManager.getBranch(), deps.runs);
			if (children.length === 0) {
				ctx.ui.notify("No subagent sessions on this branch yet.", "info");
				return;
			}
			const wanted = args.trim();
			let child = wanted ? children.find((candidate) => candidate.label === wanted) : undefined;
			if (wanted && !child) ctx.ui.notify(`No subagent labelled "${wanted}" on this branch.`, "warning");
			if (!child) {
				const file = await pickChild(ctx, children);
				child = children.find((candidate) => candidate.sessionFile === file);
			}
			if (!child) return;

			const selected = child;
			const action = await ctx.ui.custom<TranscriptAction>(
				(tui, theme, keybindings, done) => new Transcript(selected, tui, theme, keybindings, deps, ctx.cwd, done),
				{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
			);
			if (action !== "copy") return;
			const command = `pi --session "${selected.sessionFile}"`;
			try {
				await copyToClipboard(command);
				ctx.ui.notify(`Copied: ${command}`, "info");
			} catch {
				ctx.ui.notify(`Clipboard unavailable. Open it with: ${command}`, "warning");
			}
		},
	});
}

export const __testing = { listChildren, branchOf, Transcript };
