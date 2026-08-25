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
	const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const indexes = [
		...[...html.matchAll(new RegExp(`\\\\"slug\\\\":\\\\"${escaped}\\\\"`, "g"))].map((m) => m.index ?? -1),
		...[...html.matchAll(new RegExp(`"slug":"${escaped}"`, "g"))].map((m) => m.index ?? -1),
	].filter((i) => i >= 0);
	const windows = indexes.map((index) => html.slice(Math.max(0, index - 1000), index + 10000));
	const result: Metrics = {
		intelligence: metric(windows.join("\\n"), [
			/intelligenceIndex["\\s:]+([0-9.]+)/,
			/artificialAnalysisIntelligenceIndex["\\s:]+([0-9.]+)/,
		]),
		coding: metric(windows.join("\\n"), [
			/codingIndex["\\s:]+([0-9.]+)/,
			/artificialAnalysisCodingIndex["\\s:]+([0-9.]+)/,
		]),
		cost: metric(html, [
			new RegExp(`costPerIntelligenceIndexTask["\\s:]+([0-9.]+)[^}]{0,160}detailsUrl["\\s:]+/models/${escaped}`),
			new RegExp(`detailsUrl["\\s:]+/models/${escaped}[^}]{0,160}costPerIntelligenceIndexTask["\\s:]+([0-9.]+)`),
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
			...(metrics.cost === undefined ? {} : { cost: round(metrics.cost) }),
		},
	};
}

export type RefreshResult = { config: ModelAllowlistConfig; entries: number; warnings: string[] };

export async function refreshArtificialAnalysis(
	configPath = DEFAULT_ALLOWLIST_PATH,
	fetcher: BenchmarkFetch = defaultFetch,
): Promise<RefreshResult> {
	const config = readAllowlist(configPath);
	const allowed = config.allowed ?? [];
	const cache = new Map<string, Metrics | null>();
	const warnings: string[] = [];

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
		const updatedLevels = { ...entry.levels };
		for (const level of Object.keys(entry.levels)) {
			const levelConfig = entry.levels[level];
			if (!isRecord(levelConfig)) continue;
			const slugs = level === "max" ? [`${base}-${level}`, base] : [`${base}-${level}`];
			let metrics: Metrics | null = null;
			for (const slug of slugs) {
				metrics = await fetchMetrics(slug);
				if (metrics) break;
			}
			if (!metrics) {
				warnings.push(`${entry.id}/${level}: no Artificial Analysis page or metrics`);
				continue;
			}
			updatedLevels[level] = applyMetrics(levelConfig, metrics);
		}
		updatedAllowed.push({ ...entry, levels: updatedLevels });
	}

	return { config: { ...config, allowed: updatedAllowed }, entries: allowed.length, warnings };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const configPath = allowlistPathFromArgs(args);
	const result = await refreshArtificialAnalysis(configPath);
	writeAllowlist(configPath, result.config);
	console.log(`Updated ${result.entries} allowlisted model(s) from Artificial Analysis (${configPath}).`);
	for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
