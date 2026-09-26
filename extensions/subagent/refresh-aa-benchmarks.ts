#!/usr/bin/env bun
/** Refresh per-thinking-level Artificial Analysis data in the active v2 policy. */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_ALLOWLIST_PATH,
	allowlistPathFromArgs,
	isRecord,
	readAllowlist,
	type ModelAllowlistConfig,
	writeAllowlist,
} from "./benchmark-config.ts";

const AA_BASE = "https://artificialanalysis.ai/models/";

type Metrics = { intelligence?: number; coding?: number; cost?: number };
export type BenchmarkFetchResponse = {
	ok: boolean;
	status: number;
	statusText: string;
	text(): Promise<string>;
};
export type BenchmarkFetch = (url: string) => Promise<BenchmarkFetchResponse>;

const round = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
// AA displays sub-cent task costs with four decimal places, otherwise two.
const roundCost = (value: unknown) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const places = value < 0.01 ? 4 : 2;
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
};
const number = (value: string | undefined) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};
const metric = (html: string, patterns: RegExp[]) => {
	for (const pattern of patterns) {
		const match = html.match(pattern);
		const value = number(match?.[1]);
		if (value !== undefined) return value;
	}
	return undefined;
};

export function extractMetrics(html: string, slug: string): Metrics | null {
	// Next.js embeds the model payload as a quoted string, so normalize its escaped
	// quotes before looking for fields. This also keeps fixtures/plain JSON working.
	const source = html.replace(/\\"/g, '"');
	const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const indexes = [...source.matchAll(new RegExp(`"slug":"${escaped}"`, "g"))]
		.map((m) => m.index ?? -1)
		.filter((i) => i >= 0);
	const windows = indexes.map((index) => source.slice(Math.max(0, index - 1000), index + 10000));
	const scoped = windows.join("\\n");
	const result: Metrics = {
		intelligence: metric(scoped, [
			/intelligenceIndex["\\s:]+([0-9.]+)/,
			/artificialAnalysisIntelligenceIndex["\\s:]+([0-9.]+)/,
		]),
		coding: metric(scoped, [
			/codingIndex["\\s:]+([0-9.]+)/,
			/artificialAnalysisCodingIndex["\\s:]+([0-9.]+)/,
		]),
		// Current AA pages nest the value at intelligenceIndexCostPerTask.cost.total.
		// Keep the older scalar forms for pages/caches that have not migrated yet.
		cost: metric(scoped, [
			/"intelligenceIndexCostPerTask"\s*:\s*\{\s*"cost"\s*:\s*\{\s*"total"\s*:\s*([0-9.]+)/,
			new RegExp(`"costPerIntelligenceIndexTask"\\s*:\\s*([0-9.]+)[^}]{0,160}"detailsUrl"\\s*:\\s*"/models/${escaped}"`),
			new RegExp(`"detailsUrl"\\s*:\\s*"/models/${escaped}"[^}]{0,160}"costPerIntelligenceIndexTask"\\s*:\\s*([0-9.]+)`),
		]),
	};
	return Object.values(result).some((value) => value !== undefined) ? result : null;
}

function defaultFetch(url: string): Promise<BenchmarkFetchResponse> {
	return fetch(url);
}

function applyMetrics(level: Record<string, unknown>, metrics: Metrics): Record<string, unknown> {
	const artificialAnalysis = isRecord(level.artificialAnalysis) ? level.artificialAnalysis : {};
	return {
		...level,
		artificialAnalysis: {
			...artificialAnalysis,
			...(metrics.intelligence === undefined ? {} : { intelligence: round(metrics.intelligence) }),
			...(metrics.coding === undefined ? {} : { coding: round(metrics.coding) }),
			...(metrics.cost === undefined ? {} : { cost: roundCost(metrics.cost) }),
		},
	};
}

type MetricName = keyof Metrics;
type MetricChange = { before: unknown; after: number | undefined };
export type RefreshLevelReport = {
	id: string;
	level: string;
	slug?: string;
	status: "updated" | "unchanged" | "failed";
	changes: Partial<Record<MetricName, MetricChange>>;
	missing: MetricName[];
};
export type RefreshResult = {
	config: ModelAllowlistConfig;
	entries: number;
	levels: number;
	updatedLevels: number;
	unchangedLevels: number;
	reports: RefreshLevelReport[];
	warnings: string[];
};

export async function refreshArtificialAnalysis(
	configPath = DEFAULT_ALLOWLIST_PATH,
	fetcher: BenchmarkFetch = defaultFetch,
): Promise<RefreshResult> {
	const config = readAllowlist(configPath);
	const allowed = config.allowed ?? [];
	const cache = new Map<string, Metrics | null>();
	const warnings: string[] = [];
	const reports: RefreshLevelReport[] = [];
	let levels = 0;
	let updatedLevels = 0;
	let unchangedLevels = 0;

	async function fetchMetrics(slug: string): Promise<Metrics | null> {
		if (cache.has(slug)) return cache.get(slug) ?? null;
		try {
			const response = await fetcher(`${AA_BASE}${slug}`);
			if (!response.ok) {
				cache.set(slug, null);
				return null;
			}
			const result = extractMetrics(await response.text(), slug);
			cache.set(slug, result);
			return result;
		} catch {
			cache.set(slug, null);
			return null;
		}
	}

	const updatedAllowed = [] as NonNullable<ModelAllowlistConfig["allowed"]>;
	for (const entry of allowed) {
		if (typeof entry === "string" || !isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.levels)) {
			updatedAllowed.push(entry);
			continue;
		}

		const base = (entry.id.split("/").pop() ?? entry.id).toLowerCase().replace(/\./g, "-");
		const nextLevels = { ...entry.levels };
		for (const level of Object.keys(entry.levels)) {
			const levelConfig = entry.levels[level];
			if (!isRecord(levelConfig)) continue;
			levels++;
			const slugs = level === "max" ? [`${base}-${level}`, base] : [`${base}-${level}`];
			let metrics: Metrics | null = null;
			let slug: string | undefined;
			for (const candidate of slugs) {
				metrics = await fetchMetrics(candidate);
				if (metrics) {
					slug = candidate;
					break;
				}
			}
			if (!metrics) {
				const warning = `${entry.id}/${level}: no Artificial Analysis page or metrics`;
				warnings.push(warning);
				reports.push({ id: entry.id, level, status: "failed", changes: {}, missing: ["intelligence", "cost"] });
				continue;
			}

			const nextLevel = applyMetrics(levelConfig, metrics);
			const before = isRecord(levelConfig.artificialAnalysis) ? levelConfig.artificialAnalysis : {};
			const after = isRecord(nextLevel.artificialAnalysis) ? nextLevel.artificialAnalysis : {};
			const changes: Partial<Record<MetricName, MetricChange>> = {};
			for (const name of ["intelligence", "coding", "cost"] as const) {
				if (metrics[name] !== undefined && before[name] !== after[name]) {
					changes[name] = { before: before[name], after: after[name] as number | undefined };
				}
			}
			const missing = (["intelligence", "cost"] as const).filter((name) => metrics[name] === undefined);
			if (missing.length > 0) {
				const warning = `${entry.id}/${level}: missing Artificial Analysis metric(s): ${missing.join(", ")} (old value preserved)`;
				warnings.push(warning);
			}
			const status = Object.keys(changes).length > 0 ? "updated" : "unchanged";
			if (status === "updated") updatedLevels++;
			else unchangedLevels++;
			reports.push({ id: entry.id, level, slug, status, changes, missing });
			nextLevels[level] = nextLevel;
		}
		updatedAllowed.push({ ...entry, levels: nextLevels });
	}

	return {
		config: { ...config, allowed: updatedAllowed },
		entries: allowed.length,
		levels,
		updatedLevels,
		unchangedLevels,
		reports,
		warnings,
	};
}

function display(value: unknown): string {
	return value === undefined ? "missing" : String(value);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const configPath = allowlistPathFromArgs(args);
	const result = await refreshArtificialAnalysis(configPath);
	writeAllowlist(configPath, result.config);

	console.log(`Artificial Analysis refresh (${configPath})`);
	console.log(
		`Entries: ${result.entries} | levels: ${result.levels} | updated: ${result.updatedLevels} | unchanged: ${result.unchangedLevels} | failed: ${result.reports.filter((report) => report.status === "failed").length} | warnings: ${result.warnings.length}`,
	);
	for (const report of result.reports) {
		if (report.status === "failed") {
			console.log(`  ! ${report.id}/${report.level}: no metrics found`);
			continue;
		}
		const changes = Object.entries(report.changes)
			.map(([name, change]) => `${name} ${display(change?.before)} -> ${display(change?.after)}`)
			.join("; ");
		const missing = report.missing.length > 0 ? `; missing ${report.missing.join(", ")} (old value preserved)` : "";
		console.log(`  ${report.status === "updated" ? "+" : "="} ${report.id}/${report.level}: ${changes || "unchanged"}${missing}`);
	}
	if (result.warnings.length > 0) {
		console.warn("Warnings:");
		for (const warning of result.warnings) console.warn(`  ! ${warning}`);
		// A partial refresh is unsafe to treat as a successful data update.
		process.exitCode = 1;
	}
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
