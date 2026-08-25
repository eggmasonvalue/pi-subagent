import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refreshArtificialAnalysis } from "../extensions/subagent/refresh-aa-benchmarks.ts";
import { refreshDeepSWE } from "../extensions/subagent/refresh-deepswe-benchmarks.ts";
import {
	DEFAULT_ALLOWLIST_PATH,
	allowlistPathFromArgs,
	resolveAllowlistPath,
} from "../extensions/subagent/benchmark-config.ts";

test("benchmark refreshes use the user policy by default and accept an override", () => {
	assert.equal(resolveAllowlistPath(), DEFAULT_ALLOWLIST_PATH);
	assert.equal(allowlistPathFromArgs(["--config", "~/policy.json"]), path.join(os.homedir(), "policy.json"));
	assert.equal(allowlistPathFromArgs(["/tmp/policy.json"]), path.resolve("/tmp/policy.json"));
});

test("benchmark refreshes preserve config, model, level, and benchmark fields", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-benchmark-test-"));
	const configPath = path.join(directory, "models-allowlist.json");
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

	fs.writeFileSync(
		configPath,
		JSON.stringify({
			enabled: true,
			default: "provider/model",
			customRoot: { keep: true },
			allowed: [
				"provider/plain",
				{
					id: "provider/model",
					customModelField: "keep",
					levels: {
						low: { customLevelField: "keep", artificialAnalysis: { customMetric: "keep", intelligence: 1 } },
						high: { untouched: true, deepSWE: { customMetric: "keep", pass: 0.1 } },
					},
				},
			],
		}),
	);

	await refreshArtificialAnalysis(configPath, async (url) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		text: async () =>
			url.endsWith("model-low")
				? '"slug":"model-low","artificialAnalysisIntelligenceIndex":61.234,"artificialAnalysisCodingIndex":72.345'
				: '"slug":"model-high"',
	})).then(({ config }) => fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`));

	await refreshDeepSWE(configPath, async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({ rows: [{ model: "model", reasoning_effort: "high", pass_at_1: 0.61234, mean_cost_usd: 1.23456 }] }),
	})).then(({ config }) => fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`));

	const result = JSON.parse(fs.readFileSync(configPath, "utf8"));
	assert.deepEqual(result.customRoot, { keep: true });
	assert.equal(result.allowed[0], "provider/plain");
	assert.equal(result.allowed[1].customModelField, "keep");
	assert.deepEqual(result.allowed[1].levels.low, {
		customLevelField: "keep",
		artificialAnalysis: { customMetric: "keep", intelligence: 61.23, coding: 72.35 },
	});
	assert.deepEqual(result.allowed[1].levels.high, {
		untouched: true,
		deepSWE: { customMetric: "keep", pass: 0.612, cost: 1.235 },
	});
});
