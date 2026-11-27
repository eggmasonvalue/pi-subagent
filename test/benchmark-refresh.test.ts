import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artificialAnalysis, type Fetch, readTargets, refresh } from "../extensions/subagent/refresh-benchmarks.ts";

const respond = (body: string, ok = true): ReturnType<Fetch> =>
  Promise.resolve({ ok, status: ok ? 200 : 404, statusText: ok ? "OK" : "Not Found", text: async () => body });

const fetcher: Fetch = (url) => {
  if (url.endsWith("model-low")) return respond('"slug":"model-low","artificialAnalysisIntelligenceIndex":61.234,"artificialAnalysisCodingIndex":72.345,"intelligenceIndexCostPerTask":{"cost":{"total":0.00456}}');
  return respond("", false);
};

test("targets are the models in settings.json that list thinking levels", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", subagent: { models: { "provider/model": { thinking: ["low", "high"] }, "provider/unlisted": {} } } }));
  assert.deepEqual(readTargets(file), { targets: [{ id: "provider/model", levels: ["low", "high"] }], skipped: ["provider/unlisted"] });
});

test("a refresh updates found levels and keeps values it could not refresh", async () => {
  const previous = {
    "provider/model": {
      low: { artificialAnalysis: { intelligence: 1, custom: 7 } as any },
      high: { artificialAnalysis: { intelligence: 40 } },
    },
  };
  const { benchmarks, report, warnings } = await refresh(
    [{ id: "provider/model", levels: ["low", "high"] }],
    previous,
    [artificialAnalysis],
    fetcher,
  );

  assert.deepEqual(benchmarks["provider/model"].low, { artificialAnalysis: { intelligence: 61.23, coding: 72.35, cost: 0.0046, custom: 7 } });
  assert.deepEqual(benchmarks["provider/model"].high, { artificialAnalysis: { intelligence: 40 } });
  assert.equal(previous["provider/model"].low.artificialAnalysis.intelligence, 1, "the input is not mutated");
  assert.deepEqual(report, [
    "+ Artificial Analysis provider/model/low: intelligence 1 -> 61.23; coding missing -> 72.35; cost missing -> 0.0046",
    "! Artificial Analysis provider/model/high: not found",
  ]);
  assert.equal(warnings.length, 1);
});
