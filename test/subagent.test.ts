import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import registerSubagent, { __testing } from "../extensions/subagent/index.ts";

const fixture = path.resolve("test/fixtures/fake-pi.mjs");
const invocation = (args: string[]) => ({ command: process.execPath, args: [fixture, ...args] });

function tempAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
}

function runConfig(cwd: string) {
  return { cwd, model: undefined, thinking: "low", tools: ["read", "bash"] };
}

test("registers the minimal two-tool surface with parent guidance", () => {
  const tools: any[] = [];
  registerSubagent({
    registerTool(tool: any) {
      tools.push(tool);
    },
  } as any);

  assert.deepEqual(tools.map((tool) => tool.name), ["subagent_models", "subagent"]);
  assert.deepEqual(Object.keys(tools[0].parameters.properties), []);
  assert.deepEqual(Object.keys(tools[1].parameters.properties), [
    "task",
    "label",
    "model",
    "thinking",
    "tools",
    "cwd",
    "timeoutMs",
    "resume",
  ]);
  assert.ok(tools[1].promptSnippet.includes("isolated"));
  assert.ok(tools[1].promptGuidelines.some((line: string) => line.includes("clarification")));
  assert.ok(tools[1].promptGuidelines.some((line: string) => line.includes("concurrently")));
  assert.equal(Value.Check(tools[1].parameters, { task: "valid", thinking: "high" }), true);
  assert.equal(Value.Check(tools[1].parameters, { task: "valid", thinking: "invalid" }), false);
  assert.equal(Value.Check(tools[1].parameters, { task: "valid", resume: "" }), false);
});

test("fresh child streams, persists runtime metadata, and reports usage", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const updates: string[] = [];
  const result = await __testing.runChild(
    runConfig(process.cwd()),
    "finish",
    "smoke",
    undefined,
    undefined,
    undefined,
    (partial: any) => updates.push(partial.content[0].text),
    { agentDir, invoke: invocation },
  );

  assert.equal(__testing.statusOf(result), "done");
  assert.equal(result.model, "test-provider/test-model");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.cost.total, 0.033);
  assert.ok(updates.includes("finished"));
  assert.ok(result.sessionFile && fs.existsSync(result.sessionFile));
  assert.equal(path.dirname(result.sessionFile!), path.join(agentDir, "sessions", "subagent"));
  assert.match(path.basename(result.sessionFile!), /\.jsonl$/);
  const metadata = __testing.readChildMetadata(result.sessionFile!);
  assert.deepEqual(metadata.tools, ["read", "bash"]);
  assert.equal(metadata.thinking, "low");
});

test("timeout returns streamed partial text and a resumable session", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const result = await __testing.runChild(
    runConfig(process.cwd()),
    "hang",
    undefined,
    500,
    undefined,
    undefined,
    undefined,
    { agentDir, invoke: invocation },
  );

  assert.equal(__testing.statusOf(result), "timeout");
  assert.equal(result.partialText, "partial checkpoint");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.cost.total, 0.033);
  assert.ok(result.sessionFile && fs.existsSync(result.sessionFile));
  assert.match(__testing.modelFacingResult(result), /status=timeout/);
  assert.match(__testing.modelFacingResult(result), /partial checkpoint/);
});

test("abort returns partial text instead of throwing", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const result = await __testing.runChild(
    runConfig(process.cwd()),
    "hang",
    undefined,
    undefined,
    undefined,
    controller.signal,
    undefined,
    { agentDir, invoke: invocation },
  );

  assert.equal(__testing.statusOf(result), "aborted");
  assert.equal(result.partialText, "partial checkpoint");
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.cost.total, 0.033);
  assert.ok(result.sessionFile && fs.existsSync(result.sessionFile));
});

test("resume keeps the session and saved runtime configuration", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const first = await __testing.runChild(
    runConfig(process.cwd()),
    "finish",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { agentDir, invoke: invocation },
  );
  const saved = __testing.readChildMetadata(first.sessionFile!);
  let resumedArgs: string[] = [];
  const resumed = await __testing.runChild(
    saved,
    "continue",
    undefined,
    undefined,
    first.sessionFile,
    undefined,
    undefined,
    {
      agentDir,
      invoke: (args) => {
        resumedArgs = args;
        return invocation(args);
      },
    },
  );

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessionFile, first.sessionFile);
  assert.equal(resumedArgs[resumedArgs.indexOf("--model") + 1], "test-provider/test-model");
  assert.equal(resumedArgs[resumedArgs.indexOf("--thinking") + 1], "low");
  assert.equal(resumedArgs[resumedArgs.indexOf("--tools") + 1], "read,bash");
  assert.match(__testing.modelFacingResult(resumed), /resumed result/);
});

test("recursive delegation is loaded only when explicitly requested", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  let childArgs: string[] = [];
  await __testing.runChild(
    { cwd: process.cwd(), model: undefined, thinking: undefined, tools: ["subagent"] },
    "finish",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      agentDir,
      invoke: (args) => {
        childArgs = args;
        return invocation(args);
      },
    },
  );

  assert.ok(childArgs.includes("--extension"));
  assert.equal(childArgs[childArgs.indexOf("--tools") + 1], "subagent");
});

test("live tool execution events are surfaced in updates", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const states: string[][] = [];
  const result = await __testing.runChild(
    runConfig(process.cwd()),
    "activity",
    undefined,
    undefined,
    undefined,
    undefined,
    (partial: any) => states.push(partial.details.result.toolActivity.map((item: any) => item.status)),
    { agentDir, invoke: invocation },
  );

  assert.ok(states.some((state) => state.includes("running")));
  assert.equal(result.toolActivity[0].status, "done");
});

test("task text is transported over stdin and UTF-8 chunks are decoded safely", async (t) => {
  const agentDir = tempAgentDir();
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  for (const task of ["--looks-like-a-flag", "@looks-like-a-file", "unicode"]) {
    let childArgs: string[] = [];
    const result = await __testing.runChild(
      runConfig(process.cwd()),
      task,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        agentDir,
        invoke: (args) => {
          childArgs = args;
          return invocation(args);
        },
      },
    );
    assert.equal(childArgs.includes(task), false);
    assert.equal(__testing.statusOf(result), "done");
    if (task === "unicode") assert.match(__testing.modelFacingResult(result), /नमस्ते🙂/);
  }
});

test("model policy loads a curated catalog and rejects unknown thinking levels", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-policy-test-"));
  const configPath = path.join(directory, "models-allowlist.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    default: "provider/model",
    allowed: [{
      id: "provider/model",
      levels: { impossible: {} },
      description: "test model",
    }],
  }));

  const { policy, error } = __testing.loadModelPolicy(configPath);
  assert.equal(error, undefined);
  const catalog = __testing.compactModelCatalog(policy, []);
  assert.deepEqual(catalog.models, [["provider/model", "impossible: unbenchmarked", "test model"]]);
  const validation = __testing.validateModelPolicy(policy, {
    getAll: () => [{ provider: "provider", id: "model", reasoning: true }],
  });
  assert.match(validation.join("\n"), /not recognized by Pi/);
});

test("model policy enforces exact models and thinking levels", () => {
  const policy = {
    enabled: true,
    allowed: new Set(["provider/model"]),
    metadata: new Map([
      ["provider/model", { id: "provider/model", levels: { low: {}, high: {} } }],
    ]),
    defaultModel: "provider/model",
    configPath: "policy.json",
  };

  assert.deepEqual(__testing.resolveFreshModel(undefined, "high", policy as any), { model: "provider/model" });
  assert.match(__testing.resolveFreshModel(undefined, undefined, policy as any).error!, /Thinking level is required/);
  assert.match(__testing.resolveFreshModel("other/model", "high", policy as any).error!, /not allowed/);
  assert.match(__testing.resolveFreshModel("provider/model", "max", policy as any).error!, /Thinking level/);
});

test("model-facing output is capped", () => {
  const result: any = {
    task: "large",
    resumed: false,
    exitCode: 0,
    toolActivity: [],
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(70_000) }],
      provider: "test",
      model: "model",
      api: "openai-responses",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    }],
    partialText: "",
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, turns: 1 },
  };
  const output = __testing.modelFacingResult(result);
  assert.ok(Buffer.byteLength(output) < 53_000);
  assert.match(output, /Output truncated/);
});
