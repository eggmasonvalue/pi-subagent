import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { __testing, LiveRuns } from "../extensions/subagent/viewer.ts";

const result = (overrides: Record<string, unknown>): any => ({
  task: "task",
  resumed: false,
  startedAt: 0,
  exitCode: 0,
  messages: [],
  toolActivity: [],
  partialText: "",
  stderr: "",
  usage: { totalTokens: 0 },
  ...overrides,
});

const toolResultEntry = (id: string, timestamp: string, details: unknown): any => ({
  type: "message",
  id,
  parentId: null,
  timestamp,
  message: { role: "toolResult", toolName: "subagent", toolCallId: id, content: [], details, isError: false },
});

test("children are one row per session, running first, carrying their original label and task", () => {
  const runs = new LiveRuns();
  const branch = [
    toolResultEntry("a", "2026-01-01T00:00:00Z", { result: result({ sessionFile: "/a.jsonl", label: "audit", task: "audit auth" }) }),
    toolResultEntry("b", "2026-01-01T00:01:00Z", { result: result({ sessionFile: "/b.jsonl", task: "map tests" }) }),
    toolResultEntry("c", "2026-01-01T00:02:00Z", { result: result({ sessionFile: "/a.jsonl", resumed: true, task: "continue" }) }),
    { type: "message", id: "d", parentId: null, timestamp: "2026-01-01T00:03:00Z", message: { role: "user", content: "hi" } },
  ];
  runs.update("live", result({ sessionFile: "/c.jsonl", task: "live work", exitCode: -1 }));

  const children = __testing.listChildren(branch, runs);
  assert.deepEqual(children.map((child) => child.sessionFile), ["/c.jsonl", "/a.jsonl", "/b.jsonl"]);
  assert.equal(children[0].running, true);
  assert.equal(children[1].label, "audit");
  assert.equal(children[1].task, "audit auth");
  assert.equal(children[1].result.task, "continue");

  runs.end("live");
  assert.equal(__testing.listChildren(branch, runs).length, 2);
});

test("a session branch follows parent links from the last entry", () => {
  const entries: any[] = [
    { id: "1", parentId: null },
    { id: "2", parentId: "1" },
    { id: "abandoned", parentId: "1" },
    { id: "3", parentId: "2" },
  ];
  assert.deepEqual(__testing.branchOf(entries).map((entry) => entry.id), ["1", "2", "3"]);
});

test("transcript renders a child session, strips terminal sequences, and tails appended entries", (t) => {
  initTheme(undefined, false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-viewer-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "child.jsonl");
  const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
  const now = new Date().toISOString();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  fs.writeFileSync(file, [
    line({ type: "session", version: 3, id: "s", timestamp: now, cwd: directory }),
    line({ type: "message", id: "u1", parentId: null, timestamp: now, message: { role: "user", content: "inspect the repo", timestamp: Date.now() } }),
    line({ type: "message", id: "a1", parentId: "u1", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], provider: "p", model: "m", api: "openai-responses", usage, stopReason: "toolUse", timestamp: Date.now() } }),
    line({ type: "message", id: "r1", parentId: "a1", timestamp: now, message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "\x1b]133;A\x07README.md" }], isError: false, timestamp: Date.now(), durationMs: 1200 } }),
  ].join(""));

  const runs = new LiveRuns();
  const live = result({ sessionFile: file, label: "scout", exitCode: -1, partialText: "still thinking" });
  runs.update("call", live);
  const child = __testing.listChildren([], runs)[0];
  const tui: any = { terminal: { rows: 40 }, requestRender() {} };
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const keybindings: any = { matches: () => false };
  const deps: any = { runs, statusOf: () => "running", summarize: () => "running", toolDefinitions: {} };
  const transcript = new __testing.Transcript(child, tui, theme, keybindings, deps, directory, () => {});
  t.after(() => transcript.dispose());

  const first = transcript.render(100).join("\n");
  assert.match(first, /scout/);
  assert.match(first, /inspect the repo/);
  assert.match(first, /README\.md/);
  assert.match(first, /still thinking/);
  assert.doesNotMatch(first, /\x1b\]/);
  assert.match(first, /Took 1\.2s/);
  assert.equal(transcript.render(100).length, 40);

  fs.appendFileSync(file, line({ type: "message", id: "a2", parentId: "r1", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "found the readme" }], provider: "p", model: "m", api: "openai-responses", usage, stopReason: "stop", timestamp: Date.now() } }));
  live.partialText = "";
  runs.end("call");
  const second = transcript.render(100).join("\n");
  assert.match(second, /found the readme/);
  assert.doesNotMatch(second, /still thinking/);
});
