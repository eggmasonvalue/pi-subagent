import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  envelope,
  formatDuration,
  modelFacingResult,
  readChildMetadata,
  type RunRequest,
  runChild,
  statusOf,
  structuredResult,
} from "../extensions/subagent/child.ts";
import registerSubagent, { __testing } from "../extensions/subagent/index.ts";

const fixture = path.resolve("test/fixtures/fake-pi.mjs");
const invocation = (args: string[]) => ({ command: process.execPath, args: [fixture, ...args] });

function run(t: test.TestContext, request: Partial<RunRequest> & { task: string }, invoke = invocation) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  return runChild({ config: { cwd: process.cwd(), thinking: "low", tools: ["read", "bash"] }, ...request }, { agentDir, invoke });
}

const usage = (totalTokens: number, cost = 0) => ({
  input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }, turns: 1,
});

test("registers two codemode-ready tools with parent guidance and the human-only viewer", () => {
  const tools: any[] = [];
  const commands: string[] = [];
  registerSubagent({
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on() {},
  } as any);

  assert.deepEqual(tools.map((tool) => tool.name), ["subagent_models", "subagent"]);
  assert.deepEqual(commands, ["subagents"]);
  assert.deepEqual(Object.keys(tools[1].parameters.properties), ["task", "label", "model", "thinking", "tools", "cwd", "timeoutMs", "resume"]);
  assert.deepEqual(Object.keys(tools[1].outputSchema.properties), ["status", "output", "error", "label", "session", "contextTokens", "contextWindow"]);
  assert.ok(tools[0].outputSchema.properties.models);
  assert.ok(tools[1].promptGuidelines.some((line: string) => line.includes("supervision checkpoint")));
  assert.ok(tools[1].promptGuidelines.some((line: string) => line.includes("Promise.all")));
  assert.deepEqual(tools[1].parameters.properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(Value.Check(tools[1].parameters, { task: "valid", thinking: "high" }), true);
  assert.equal(Value.Check(tools[1].parameters, { task: "valid", thinking: "invalid" }), false);
  assert.equal(Value.Check(tools[1].parameters, { task: "valid", resume: "" }), false);
});

test("fresh child streams, persists runtime metadata, and reports usage", async (t) => {
  const updates: string[] = [];
  const result = await run(t, { task: "finish", label: "smoke", onUpdate: (live) => updates.push(live.partialText) });

  assert.equal(statusOf(result), "done");
  assert.equal(result.model, "test-provider/test-model");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.cost.total, 0.033);
  assert.ok(updates.includes("finished"));
  assert.ok(result.sessionFile && fs.existsSync(result.sessionFile));
  const metadata = readChildMetadata(result.sessionFile!);
  assert.deepEqual(metadata.tools, ["read", "bash"]);
  assert.equal(metadata.thinking, "low");
  assert.equal(metadata.label, "smoke");
});

test("timeout returns streamed partial text and a resumable session", async (t) => {
  const result = await run(t, { task: "hang", timeoutMs: 500 });

  assert.equal(statusOf(result), "timeout");
  assert.equal(result.partialText, "partial checkpoint");
  assert.equal(result.usage.cost.total, 0.033);
  assert.ok(result.sessionFile && fs.existsSync(result.sessionFile));
  assert.match(modelFacingResult(result), /status=timeout/);
  assert.match(modelFacingResult(result), /partial checkpoint/);
  assert.deepEqual(structuredResult(result), {
    status: "timeout",
    output: "partial checkpoint",
    session: result.sessionFile,
    contextTokens: 18,
  });
});

test("abort returns partial text instead of throwing", async (t) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const result = await run(t, { task: "hang", signal: controller.signal });

  assert.equal(statusOf(result), "aborted");
  assert.equal(result.partialText, "partial checkpoint");
  assert.ok(result.sessionFile && fs.existsSync(result.sessionFile));
});

test("a run that fails mid-stream keeps its streamed usage", async (t) => {
  const result = await run(t, { task: "midstream-error" });
  assert.equal(statusOf(result), "failed");
  assert.equal(result.usage.totalTokens, 18);
  assert.equal(result.usage.cost.total, 0.033);
});

test("a child that exits non-zero fails and reports its stderr to scripts", async (t) => {
  const result = await run(t, { task: "crash" });
  assert.equal(statusOf(result), "failed");
  assert.match(structuredResult(result).error ?? "", /boom/);
});

test("resume keeps the session and saved runtime configuration", async (t) => {
  const first = await run(t, { task: "finish" });
  const { version: _, label: __, ...saved } = readChildMetadata(first.sessionFile!);
  let args: string[] = [];
  const resumed = await run(t, { config: saved, task: "continue", resume: first.sessionFile }, (childArgs) => {
    args = childArgs;
    return invocation(childArgs);
  });

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessionFile, first.sessionFile);
  assert.equal(args[args.indexOf("--model") + 1], "test-provider/test-model");
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
  assert.match(modelFacingResult(resumed), /resumed result/);
});

test("recursive delegation is loaded only when explicitly requested", async (t) => {
  let args: string[] = [];
  await run(t, { config: { cwd: process.cwd(), tools: ["subagent"] }, task: "finish" }, (childArgs) => {
    args = childArgs;
    return invocation(childArgs);
  });
  assert.ok(args.includes("--extension"));
  assert.equal(args[args.indexOf("--tools") + 1], "subagent");
});

test("live tool execution events and the session path surface while running", async (t) => {
  const states: string[][] = [];
  const sessions: (string | undefined)[] = [];
  const result = await run(t, {
    task: "activity",
    onUpdate(live) {
      states.push(live.toolActivity.map((item) => item.status));
      if (live.exitCode === -1) sessions.push(live.sessionFile);
    },
  });
  assert.ok(states.some((state) => state.includes("running")));
  assert.equal(result.toolActivity[0].status, "done");
  assert.ok(sessions.includes(result.sessionFile));
});

test("task text is transported over stdin and UTF-8 chunks are decoded safely", async (t) => {
  for (const task of ["--looks-like-a-flag", "@looks-like-a-file", "unicode"]) {
    let args: string[] = [];
    const result = await run(t, { task }, (childArgs) => {
      args = childArgs;
      return invocation(childArgs);
    });
    assert.equal(args.includes(task), false);
    assert.equal(statusOf(result), "done");
    if (task === "unicode") assert.match(modelFacingResult(result), /नमस्ते🙂/);
  }
});

test("tools inherit, replace, or adjust the inherited set", () => {
  const inherited = ["read", "bash", "edit"];
  const resolve = __testing.resolveChildTools;
  assert.deepEqual(resolve(inherited, undefined), inherited);
  assert.deepEqual(resolve(inherited, []), []);
  assert.deepEqual(resolve(inherited, ["read", "read"]), ["read"]);
  assert.deepEqual(resolve(inherited, ["-bash", "+subagent"]), ["read", "edit", "subagent"]);
  assert.throws(() => resolve(inherited, ["read", "-bash"]), /not a mix/);
  assert.throws(() => resolve(inherited, ["+"]), /Invalid tools entry/);
});

test("durations and elapsed badges are compact", () => {
  assert.deepEqual([750, 1_500, 59_960, 125_000, 3_599_000, 3_900_000].map(formatDuration), ["750ms", "1.5s", "1m", "2m 5s", "59m 59s", "1h 5m"]);
  assert.equal(__testing.elapsedBadge({ startedAt: 1_000 }, 6_000), "[⏱ 5s]");
  assert.equal(__testing.elapsedBadge({ startedAt: 1_000, timeoutMs: 120_000 }, 6_000), "[⏱ 5s / 2m]");
  assert.equal(__testing.elapsedBadge({ startedAt: 1_000, endedAt: 3_000 }, 60_000), "[⏱ 2s]");
});

test("the model-facing envelope keeps orchestration fields and excludes accounting details", () => {
  const result: any = {
    task: "done", label: "parallel-a", resumed: true, timeoutMs: 1000, exitCode: 0, model: "provider/model",
    contextWindow: 200_000, thinking: "high", stopReason: "stop", sessionFile: "/tmp/child.jsonl",
    toolActivity: [], messages: [], partialText: "finished", stderr: "", usage: usage(84_000, 0.25),
  };
  const output = modelFacingResult(result);
  assert.match(output, /^\[label=parallel-a status=done context=42%\/200k session=\/tmp\/child\.jsonl\]/);
  assert.match(envelope({ ...result, contextWindow: undefined }), /context=84k /);
  assert.doesNotMatch(envelope({ ...result, usage: usage(0) }), /context=/);
  assert.doesNotMatch(output, /model=|thinking=|turns=|cost=|timeoutMs=|resumed=|exit=/);
});

test("model-facing output is capped while scripts get it whole", () => {
  const text = "x".repeat(70_000);
  const result: any = {
    task: "large", resumed: false, exitCode: 0, toolActivity: [], partialText: "", stderr: "", usage: usage(0),
    messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
  };
  const output = modelFacingResult(result);
  assert.ok(Buffer.byteLength(output) < 53_000);
  assert.match(output, /Output truncated/);
  assert.equal(structuredResult(result).output, text);
});
