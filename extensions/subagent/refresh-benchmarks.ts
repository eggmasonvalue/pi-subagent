#!/usr/bin/env bun
/**
 * Refresh the benchmark cache for the models listed in settings.json "subagent.models".
 *
 * Usage: bun refresh-benchmarks.ts
 *
 * Only the thinking levels a model lists are benchmarked. Each source updates its own fields, so
 * a failed or partial lookup keeps the previous values.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, type Benchmarks, type LevelBenchmarks, readBenchmarks, writeBenchmarks } from "./benchmarks.ts";

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;
type Metrics = Record<string, number | undefined>;
type Lookup = (id: string, level: string) => Promise<Metrics | undefined>;

export interface Source {
	key: keyof LevelBenchmarks;
	name: string;
	/** Metrics whose absence makes a refresh incomplete. */
	required: string[];
	connect(fetcher: Fetch): Promise<Lookup>;
}

export interface Target {
	id: string;
	levels: string[];
}

const roundTo = (places: number) => (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : undefined;
const modelName = (id: string) => id.split("/").pop() ?? id;

// ── Artificial Analysis: one model page per thinking level ──────────────────────────────────────

const AA_BASE = "https://artificialanalysis.ai/models/";

function metric(html: string, patterns: RegExp[]): number | undefined {
	for (const pattern of patterns) {
		const value = Number(html.match(pattern)?.[1]);
		if (Number.isFinite(value)) return value;
	}
	return undefined;
}

export function extractMetrics(html: string, slug: string): Metrics | undefined {
	// Next.js embeds the model payload as a quoted string, so normalize its escaped quotes first.
	const source = html.replace(/\\"/g, '"');
	const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const scoped = [...source.matchAll(new RegExp(`"slug":"${escaped}"`, "g"))]
		.map((match) => source.slice(Math.max(0, (match.index ?? 0) - 1000), (match.index ?? 0) + 10000))
		.join("\\n");
	const result: Metrics = {
		intelligence: metric(scoped, [/intelligenceIndex["\\s:]+([0-9.]+)/, /artificialAnalysisIntelligenceIndex["\\s:]+([0-9.]+)/]),
		coding: metric(scoped, [/codingIndex["\\s:]+([0-9.]+)/, /artificialAnalysisCodingIndex["\\s:]+([0-9.]+)/]),
		// Current pages nest the value at intelligenceIndexCostPerTask.cost.total; older ones use a scalar.
		cost: metric(scoped, [
			/"intelligenceIndexCostPerTask"\s*:\s*\{\s*"cost"\s*:\s*\{\s*"total"\s*:\s*([0-9.]+)/,
			new RegExp(`"costPerIntelligenceIndexTask"\\s*:\\s*([0-9.]+)[^}]{0,160}"detailsUrl"\\s*:\\s*"/models/${escaped}"`),
			new RegExp(`"detailsUrl"\\s*:\\s*"/models/${escaped}"[^}]{0,160}"costPerIntelligenceIndexTask"\\s*:\\s*([0-9.]+)`),
		]),
	};
	return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

export const artificialAnalysis: Source = {
	key: "artificialAnalysis",
	name: "Artificial Analysis",
	required: ["intelligence", "cost"],
	async connect(fetcher) {
		const pages = new Map<string, Promise<Metrics | undefined>>();
		const page = (slug: string) => {
			if (!pages.has(slug)) {
				pages.set(slug, fetcher(`${AA_BASE}${slug}`)
					.then(async (response) => (response.ok ? extractMetrics(await response.text(), slug) : undefined))
					.catch(() => undefined));
			}
			return pages.get(slug)!;
		};
		return async (id, level) => {
			const base = modelName(id).toLowerCase().replace(/\./g, "-");
			// AA publishes a model's top effort without a suffix.
			for (const slug of level === "max" ? [`${base}-max`, base] : [`${base}-${level}`]) {
				const metrics = await page(slug);
				if (!metrics) continue;
				// AA displays sub-cent task costs with four decimal places, otherwise two.
				const cost = metrics.cost !== undefined && metrics.cost < 0.01 ? roundTo(4)(metrics.cost) : roundTo(2)(metrics.cost);
				return { intelligence: roundTo(2)(metrics.intelligence), coding: roundTo(2)(metrics.coding), cost };
			}
			return undefined;
		};
	},
};

export const SOURCES: Source[] = [artificialAnalysis];

// ── Driver ───────────────────────────────────────────────────────────────────────────────────────

export interface RefreshResult {
	benchmarks: Benchmarks;
	/** One line per model level and source: "+" changed, "=" unchanged, "!" not found. */
	report: string[];
	warnings: string[];
}

export async function refresh(targets: Target[], previous: Benchmarks, sources: Source[], fetcher: Fetch): Promise<RefreshResult> {
	const benchmarks: Benchmarks = structuredClone(previous);
	const report: string[] = [];
	const warnings: string[] = [];
	for (const source of sources) {
		const lookup = await source.connect(fetcher);
		for (const { id, levels } of targets) {
			for (const level of levels) {
				const where = `${source.name} ${id}/${level}`;
				const metrics = await lookup(id, level);
				if (!metrics) {
					report.push(`! ${where}: not found`);
					warnings.push(`${where}: no result`);
					continue;
				}
				const scores = ((benchmarks[id] ??= {})[level] ??= {});
				const before = (scores[source.key] ?? {}) as Metrics;
				const after: Metrics = { ...before };
				for (const [name, value] of Object.entries(metrics)) if (value !== undefined) after[name] = value;
				(scores as Record<string, Metrics>)[source.key] = after;
				const changes = Object.keys(after)
					.filter((name) => before[name] !== after[name])
					.map((name) => `${name} ${before[name] ?? "missing"} -> ${after[name]}`);
				const missing = source.required.filter((name) => metrics[name] === undefined);
				if (missing.length) warnings.push(`${where}: missing ${missing.join(", ")} (previous value kept)`);
				report.push(`${changes.length ? "+" : "="} ${where}: ${changes.join("; ") || "unchanged"}`);
			}
		}
	}
	return { benchmarks, report, warnings };
}

/** Models listed in the user's settings.json, with the levels to benchmark. */
export function readTargets(settingsFile = path.join(agentDir(), "settings.json")): { targets: Target[]; skipped: string[] } {
	const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { subagent?: { models?: Record<string, { thinking?: unknown } | null> } };
	const targets: Target[] = [];
	const skipped: string[] = [];
	for (const [id, entry] of Object.entries(settings.subagent?.models ?? {})) {
		if (Array.isArray(entry?.thinking) && entry.thinking.length) targets.push({ id, levels: entry.thinking.map(String) });
		else skipped.push(id);
	}
	return { targets, skipped };
}

export async function main(): Promise<void> {
	const { targets, skipped } = readTargets();
	const result = await refresh(targets, readBenchmarks(), SOURCES, fetch);
	writeBenchmarks(result.benchmarks);
	for (const line of result.report) console.log(line);
	for (const id of skipped) console.log(`- ${id}: no thinking list in settings.json, not benchmarked`);
	if (result.warnings.length) {
		console.warn(`\n${result.warnings.length} warning(s):`);
		for (const warning of result.warnings) console.warn(`  ! ${warning}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
