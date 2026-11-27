import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, catalogText, enforce, parsePolicy, policyIssues, resolveFresh } from "../extensions/subagent/policy.ts";

// "provider/reasoner" supports off..high, "provider/capped" off..medium, "provider/plain" only off.
const registry = {
  getAll: () => [
    { provider: "provider", id: "reasoner", reasoning: true },
    { provider: "provider", id: "capped", reasoning: true, thinkingLevelMap: { high: null } },
    { provider: "provider", id: "plain", reasoning: false },
  ],
} as any;

const restricted = parsePolicy({
  defaultModel: "provider/reasoner",
  defaultThinking: "high",
  models: {
    "provider/reasoner": { thinking: ["low", "high"], description: "workhorse" },
    "provider/capped": { thinking: ["low", "high"] },
    "provider/plain": {},
    "provider/retired": {},
    "provider/withdrawn": null,
  },
});

test("parses settings.json subagent into a keyed model map", () => {
  assert.deepEqual(parsePolicy(undefined), {});
  assert.deepEqual([...restricted.models!.keys()], ["provider/reasoner", "provider/capped", "provider/plain", "provider/retired"]);
  assert.deepEqual(restricted.models!.get("provider/reasoner"), { thinking: ["low", "high"], description: "workhorse" });
  assert.deepEqual(parsePolicy({ defaultModel: "any/model", defaultThinking: "low" }), { defaultModel: "any/model", defaultThinking: "low" });
});

test("malformed settings fail loudly instead of loosening the policy", () => {
  assert.throws(() => parsePolicy([]), /expected an object/);
  assert.throws(() => parsePolicy({ defaultThinking: "extreme" }), /defaultThinking/);
  assert.throws(() => parsePolicy({ models: { "p/m": { thinking: ["impossible"] } } }), /thinking must be a list/);
  assert.throws(() => parsePolicy({ models: { "p/m": "yes" } }), /must be an object/);
  assert.throws(() => parsePolicy({ models: {} }), /permits no model/);
  assert.throws(() => parsePolicy({ defaultModel: "p/other", models: { "p/m": {} } }), /defaultModel/);
});

test("without a model list, selections pass through after subagent defaults", () => {
  const open = parsePolicy({ defaultModel: "p/m", defaultThinking: "low" });
  assert.deepEqual(resolveFresh(open, {}, registry), { model: "p/m", thinking: "low" });
  assert.deepEqual(resolveFresh(open, { model: "sonnet", thinking: "high" }, registry), { model: "sonnet", thinking: "high" });
  assert.deepEqual(resolveFresh({}, {}, registry), { model: undefined, thinking: undefined });
});

test("with a model list, model and thinking resolve to permitted values only", () => {
  assert.deepEqual(resolveFresh(restricted, {}, registry), { model: "provider/reasoner", thinking: "high" });
  assert.deepEqual(resolveFresh(restricted, { thinking: "low" }, registry), { model: "provider/reasoner", thinking: "low" });
  // Configured levels are narrowed to what Pi says the model supports; a single usable level needs no argument.
  assert.deepEqual(resolveFresh(restricted, { model: "provider/capped" }, registry), { model: "provider/capped", thinking: "low" });
  const maxDefault = parsePolicy({ defaultThinking: "max", models: { "provider/reasoner": { thinking: ["low", "high"] } } });
  assert.throws(() => resolveFresh(maxDefault, { model: "provider/reasoner" }, registry), /default "max" is not permitted\. Permitted for "provider\/reasoner": low, high\./);
  assert.deepEqual(resolveFresh(restricted, { model: "provider/plain" }, registry), { model: "provider/plain", thinking: "off" });
  assert.throws(() => resolveFresh(restricted, { thinking: "medium" }, registry), /"medium" is not permitted/);
  assert.throws(() => resolveFresh(restricted, { model: "provider/other" }, registry), /not permitted/);
  assert.throws(() => resolveFresh(restricted, { model: "provider/withdrawn" }, registry), /not permitted/);
  assert.throws(() => resolveFresh(restricted, { model: "provider/retired" }, registry), /not known to Pi/);
});

test("subagent defaults never fall back to the main agent's", () => {
  const noDefaults = parsePolicy({ models: { "provider/reasoner": {} } });
  assert.throws(() => resolveFresh(noDefaults, {}, registry), /defaultModel" is unset/);
  assert.throws(() => resolveFresh(noDefaults, { model: "provider/reasoner" }, registry), /defaultThinking" is unset/);
  assert.throws(() => enforce(noDefaults, { model: "provider/reasoner" }, registry), /defaultThinking" is unset/);
});

test("stale entries are reported without blocking other models", () => {
  assert.deepEqual(policyIssues(restricted, registry), [
    '"provider/capped" does not support thinking level "high".',
    '"provider/retired" is not known to Pi.',
  ]);
});

test("the catalog lists permitted levels with their benchmarks", () => {
  const catalog = buildCatalog(restricted, registry, {
    "provider/reasoner": {
      high: { artificialAnalysis: { intelligence: 55.12, coding: 70.8, cost: 4.63 } },
      medium: { artificialAnalysis: { intelligence: 50 } },
    },
  });
  assert.equal(catalog.restricted, true);
  assert.equal(catalog.defaultModel, "provider/reasoner");
  assert.deepEqual(catalog.models[0], {
    id: "provider/reasoner",
    thinking: ["low", "high"],
    description: "workhorse",
    benchmarks: { high: { artificialAnalysis: { intelligence: 55.12, coding: 70.8, cost: 4.63 } } },
  });
  assert.deepEqual(catalog.models.find((model) => model.id === "provider/retired")?.thinking, []);

  const text = catalogText(catalog);
  assert.match(text, /Defaults: provider\/reasoner, thinking high\./);
  assert.match(text, /provider\/reasoner: workhorse\n {2}low · high \(AA 55\.1\/70\.8 \$4\.63\)/);
  assert.match(text, /Issues:\n- "provider\/capped"/);
  assert.match(catalogText(buildCatalog({}, registry, {})), /Any model Pi accepts is permitted/);
});
