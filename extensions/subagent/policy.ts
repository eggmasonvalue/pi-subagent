// Child-model policy: the `subagent` key of Pi's settings.json. Subagent defaults are deliberately
// independent of the main agent's: a supervisor talks to humans, a child talks to its supervisor.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { Benchmarks, LevelBenchmarks } from "./benchmarks.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export interface ModelEntry {
	/** Permitted thinking levels; omitted permits every level Pi supports for the model. */
	thinking?: ThinkingLevel[];
	description?: string;
}

export interface Policy {
	/** Permitted child models keyed by exact provider/id; undefined permits any model Pi accepts. */
	models?: Map<string, ModelEntry>;
	defaultModel?: string;
	defaultThinking?: ThinkingLevel;
}

export interface Selection {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface ModelRegistryView {
	getAll(): Model<any>[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
	typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
const invalid = (detail: string) => new Error(`Invalid "subagent" in settings.json: ${detail}`);

/** Parse `settings.subagent`. Malformed settings throw rather than silently loosening the policy. */
export function parsePolicy(value: unknown): Policy {
	if (value === undefined) return {};
	if (!isRecord(value)) throw invalid("expected an object.");
	const { models, defaultModel, defaultThinking } = value;
	if (defaultModel !== undefined && (typeof defaultModel !== "string" || !defaultModel)) throw invalid('"defaultModel" must be a provider/id string.');
	if (defaultThinking !== undefined && !isThinkingLevel(defaultThinking)) {
		throw invalid(`"defaultThinking" must be one of ${THINKING_LEVELS.join(", ")}.`);
	}
	const policy: Policy = { defaultModel, defaultThinking };
	if (models === undefined) return policy;
	if (!isRecord(models)) throw invalid('"models" must be an object keyed by provider/id.');

	policy.models = new Map();
	for (const [id, raw] of Object.entries(models)) {
		// null lets project settings withdraw a model the user settings permit.
		if (raw === null) continue;
		if (!isRecord(raw)) throw invalid(`models["${id}"] must be an object.`);
		const { thinking, description } = raw;
		if (thinking !== undefined && (!Array.isArray(thinking) || !thinking.every(isThinkingLevel))) {
			throw invalid(`models["${id}"].thinking must be a list of ${THINKING_LEVELS.join(", ")}.`);
		}
		if (description !== undefined && typeof description !== "string") throw invalid(`models["${id}"].description must be a string.`);
		policy.models.set(id, { thinking, description });
	}
	if (policy.models.size === 0) throw invalid('"models" permits no model.');
	if (defaultModel && !policy.models.has(defaultModel)) throw invalid('"defaultModel" must be one of "models".');
	return policy;
}

function findModel(registry: ModelRegistryView, id: string): Model<any> | undefined {
	return registry.getAll().find((model) => `${model.provider}/${model.id}` === id);
}

/** Levels the policy permits for a model, narrowed to those Pi supports; throws when the model is not usable. */
function permittedLevels(models: Map<string, ModelEntry>, id: string, registry: ModelRegistryView): ThinkingLevel[] {
	const entry = models.get(id);
	if (!entry) throw new Error(`Model "${id}" is not permitted. Call subagent_models for permitted models.`);
	const model = findModel(registry, id);
	if (!model) throw new Error(`Permitted model "${id}" is not known to Pi.`);
	const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return entry.thinking ? supported.filter((level) => entry.thinking!.includes(level)) : supported;
}

/**
 * Complete and check a child's model and thinking level against the policy. Without a model list any
 * selection passes through; with one, both must resolve to permitted values, never to the main
 * agent's defaults. `fallback` fills an omitted thinking level when the model permits it.
 */
export function enforce(policy: Policy, selection: Selection, registry: ModelRegistryView, fallback?: ThinkingLevel): Selection {
	if (!policy.models) return { model: selection.model, thinking: selection.thinking ?? fallback };
	const { model, thinking } = selection;
	if (!model) throw new Error('No model given and settings.json "subagent.defaultModel" is unset. Call subagent_models for permitted models.');
	const levels = permittedLevels(policy.models, model, registry);
	const permitted = `Permitted for "${model}": ${levels.join(", ") || "none"}.`;
	if (thinking) {
		if (!levels.includes(thinking)) throw new Error(`Thinking level "${thinking}" is not permitted. ${permitted}`);
		return { model, thinking };
	}
	if (fallback && levels.includes(fallback)) return { model, thinking: fallback };
	if (levels.length === 1) return { model, thinking: levels[0] };
	const missing = fallback ? `the subagent default "${fallback}" is not permitted` : 'settings.json "subagent.defaultThinking" is unset';
	throw new Error(`No thinking level given and ${missing}. ${permitted}`);
}

/** Selection for a fresh child: explicit arguments, then the subagent defaults. */
export function resolveFresh(policy: Policy, requested: Selection, registry: ModelRegistryView): Selection {
	return enforce(policy, { model: requested.model ?? policy.defaultModel, thinking: requested.thinking }, registry, policy.defaultThinking);
}

/** Problems that block only the calls that select the affected model. */
export function policyIssues(policy: Policy, registry: ModelRegistryView): string[] {
	if (!policy.models) return [];
	const issues: string[] = [];
	for (const [id, entry] of policy.models) {
		const model = findModel(registry, id);
		if (!model) {
			issues.push(`"${id}" is not known to Pi.`);
			continue;
		}
		const supported = getSupportedThinkingLevels(model);
		for (const level of entry.thinking ?? []) {
			if (!supported.includes(level)) issues.push(`"${id}" does not support thinking level "${level}".`);
		}
	}
	if (policy.defaultModel && policy.defaultThinking) {
		try {
			enforce(policy, { model: policy.defaultModel, thinking: policy.defaultThinking }, registry);
		} catch (error) {
			issues.push(`Defaults: ${(error as Error).message}`);
		}
	}
	return issues;
}

export interface CatalogModel {
	id: string;
	thinking: ThinkingLevel[];
	description?: string;
	benchmarks?: Record<string, LevelBenchmarks>;
}

export interface Catalog {
	/** False when settings.json lists no models, so any model Pi accepts is permitted. */
	restricted: boolean;
	defaultModel?: string;
	defaultThinking?: ThinkingLevel;
	models: CatalogModel[];
	issues: string[];
}

export function buildCatalog(policy: Policy, registry: ModelRegistryView, benchmarks: Benchmarks): Catalog {
	const models = [...(policy.models ?? [])].map(([id, entry]): CatalogModel => {
		let thinking: ThinkingLevel[] = [];
		try {
			thinking = permittedLevels(policy.models!, id, registry);
		} catch {
			// Reported in issues.
		}
		const scores = Object.fromEntries(thinking.filter((level) => benchmarks[id]?.[level]).map((level) => [level, benchmarks[id][level]]));
		return {
			id,
			thinking,
			...(entry.description ? { description: entry.description } : {}),
			...(Object.keys(scores).length ? { benchmarks: scores } : {}),
		};
	});
	return {
		restricted: Boolean(policy.models),
		...(policy.defaultModel ? { defaultModel: policy.defaultModel } : {}),
		...(policy.defaultThinking ? { defaultThinking: policy.defaultThinking } : {}),
		models,
		issues: policyIssues(policy, registry),
	};
}

function levelText(level: string, scores: LevelBenchmarks | undefined): string {
	const aa = scores?.artificialAnalysis;
	if (!aa) return level;
	const quality = [aa.intelligence, aa.coding].filter((value) => typeof value === "number").map((value) => value!.toFixed(1)).join("/");
	return `${level} (AA ${quality || "?"}${typeof aa.cost === "number" ? ` $${aa.cost}` : ""})`;
}

export function catalogText(catalog: Catalog): string {
	const defaults = [catalog.defaultModel, catalog.defaultThinking && `thinking ${catalog.defaultThinking}`].filter(Boolean).join(", ");
	const lines = [defaults ? `Defaults: ${defaults}.` : "No subagent defaults: pass model and thinking."];
	if (!catalog.restricted) {
		lines.push("Any model Pi accepts is permitted; omitted values use the defaults above, then the child Pi's own.");
	} else {
		lines.push("Pass a model id below as subagent.model and one of its levels as subagent.thinking. AA = Artificial Analysis intelligence/coding index, $ = cost per benchmark task.");
		for (const model of catalog.models) {
			lines.push("", model.description ? `${model.id}: ${model.description}` : model.id);
			lines.push(`  ${model.thinking.map((level) => levelText(level, model.benchmarks?.[level])).join(" · ") || "unusable"}`);
		}
	}
	if (catalog.issues.length) lines.push("", "Issues:", ...catalog.issues.map((issue) => `- ${issue}`));
	return lines.join("\n");
}
