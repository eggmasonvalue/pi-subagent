import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { __testing, LiveRuns, RUN_ENTRY_TYPE } from "../extensions/subagent/viewer.ts";

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

const runEntry = (timestamp: string, summary: Record<string, unknown>): any => ({
  type: "custom",
  customType: RUN_ENTRY_TYPE,
  id: `run-${timestamp}`,
  parentId: null,
  timestamp,
  data: result(summary),
});

const callsEntry = (ids: string[], name = "subagent"): any => ({
  type: "message",
  id: `calls-${ids.join("-")}`,
  parentId: null,
  timestamp: "2026-01-01T00:00:00Z",
  message: { role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name, arguments: {} })) },
});

test("children are one row per session, running first, carrying their original label and task", () => {
  const runs = new LiveRuns();
  const branch = [
    callsEntry(["a", "b"]),
    runEntry("2026-01-01T00:00:00Z", { sessionFile: "/a.jsonl", label: "audit", task: "audit auth" }),
    runEntry("2026-01-01T00:01:00Z", { sessionFile: "/b.jsonl", task: "map tests" }),
    callsEntry(["c", "live"]),
    runEntry("2026-01-01T00:02:00Z", { sessionFile: "/a.jsonl", resumed: true, task: "continue" }),
    { type: "message", id: "d", parentId: null, timestamp: "2026-01-01T00:03:00Z", message: { role: "user", content: "hi" } },
  ];
  runs.update("live", result({ sessionFile: "/c.jsonl", task: "live work", exitCode: -1 }));

  const children = __testing.listChildren(branch, runs);
  assert.deepEqual(children.map((child) => child.sessionFile), ["/c.jsonl", "/a.jsonl", "/b.jsonl"]);
  assert.equal(children[0].running, true);
  assert.equal(children[1].label, "audit");
  assert.equal(children[1].task, "audit auth");
  assert.equal(children[1].result.task, "continue");
});

test("children started by a codemode script are listed under the script's call", () => {
  const runs = new LiveRuns();
  const branch = [callsEntry(["script"], "codemode")];
  runs.update("script/1", result({ sessionFile: "/one.jsonl", label: "one", exitCode: -1 }));
  runs.update("script/2", result({ sessionFile: "/two.jsonl", label: "two", exitCode: -1 }));
  runs.update("elsewhere/1", result({ sessionFile: "/other.jsonl", exitCode: -1 }));
  assert.deepEqual(__testing.listChildren(branch, runs).map((child) => child.label).sort(), ["one", "two"]);

  // A finished call leaves the registry; its custom entry takes over.
  runs.end("script/1");
  const persisted = [...branch, runEntry("2026-01-01T00:05:00Z", { sessionFile: "/one.jsonl", label: "one" })];
  assert.deepEqual(__testing.listChildren(persisted, runs).map((child) => [child.label, child.running]), [["two", true], ["one", false]]);
  assert.equal(runs.isRunning("/one.jsonl"), false);
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
  const child = __testing.listChildren([callsEntry(["call"])], runs)[0];
  const tui: any = { terminal: { rows: 40 }, requestRender() {} };
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const keybindings: any = { matches: () => false, getKeys: (id: string) => (id === "app.tools.expand" ? ["ctrl+o"] : []) };
  const deps: any = { runs, toolDefinitions: {} };
  const transcript = new __testing.Transcript(child, tui, theme, keybindings, deps, directory, () => {});
  t.after(() => transcript.dispose());

  const first = transcript.render(100).join("\n");
  assert.match(first, /scout/);
  assert.match(first, /inspect the repo/);
  assert.match(first, /README\.md/);
  assert.match(first, /still thinking/);
  assert.doesNotMatch(first, /\x1b\]/);
  assert.match(first, /Took 1\.2s/);
  assert.match(first, /ctrl\+o expand/);
  assert.equal(transcript.render(100).length, 40);

  fs.appendFileSync(file, line({ type: "message", id: "a2", parentId: "r1", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "found the readme" }], provider: "p", model: "m", api: "openai-responses", usage, stopReason: "stop", timestamp: Date.now() } }));
  live.partialText = "";
  runs.end("call");
  const second = transcript.render(100).join("\n");
  assert.match(second, /found the readme/);
  assert.doesNotMatch(second, /still thinking/);
});
