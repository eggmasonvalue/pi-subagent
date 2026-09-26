#!/usr/bin/env bun
/**
 * Refresh compact DeepSWE benchmark data in the active v2 policy.
 *
 * Usage: bun refresh-deepswe-benchmarks.ts [--config PATH]
 */

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

const LEADERBOARD_URL = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";

type Row = {
	model: string;
	reasoning_effort?: string;
	pass_at_1?: number;
	mean_cost_usd?: number;
};

export type BenchmarkJsonResponse = {
	ok: boolean;
	status: number;
	statusText: string;
	json(): Promise<unknown>;
};
export type BenchmarkFetch = (url: string) => Promise<BenchmarkJsonResponse>;

const normalize = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

const round = (value: number | undefined) =>
	typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;

function defaultFetch(url: string): Promise<BenchmarkJsonResponse> {
	return fetch(url);
}

type MetricName = "pass" | "cost";
type MetricChange = { before: unknown; after: number | undefined };
export type RefreshLevelReport = {
	id: string;
	level: string;
	status: "updated" | "unchanged" | "failed";
	changes: Partial<Record<MetricName, MetricChange>>;
	missing: MetricName[];
};
export type RefreshResult = {
	config: ModelAllowlistConfig;
	entries: number;
	levels: number;
	updatedEntries: number;
	updatedLevels: number;
	unchangedLevels: number;
	rows: number;
	reports: RefreshLevelReport[];
	warnings: string[];
};

export async function refreshDeepSWE(
	configPath = DEFAULT_ALLOWLIST_PATH,
	fetcher: BenchmarkFetch = defaultFetch,
): Promise<RefreshResult> {
	const raw = readAllowlist(configPath);
	const allowed = raw.allowed ?? [];
	const response = await fetcher(LEADERBOARD_URL);
	if (!response.ok) throw new Error(`DeepSWE request failed: ${response.status} ${response.statusText}`);
	const payload = (await response.json()) as { rows?: Row[] };
	const rows = Array.isArray(payload.rows) ? payload.rows : [];

	const byModelAndLevel = new Map<string, Row>();
	const benchmarkModels = new Set<string>();
	for (const row of rows) {
		if (typeof row.model !== "string" || !row.model.trim()) continue;
		const modelKey = normalize(row.model);
		benchmarkModels.add(modelKey);
		if (typeof row.reasoning_effort !== "string" || !row.reasoning_effort.trim()) continue;
		byModelAndLevel.set(`${modelKey}\0${row.reasoning_effort.trim().toLowerCase()}`, row);
	}

	const warnings: string[] = [];
	const reports: RefreshLevelReport[] = [];
	const updatedAllowed = [] as NonNullable<ModelAllowlistConfig["allowed"]>;
	let levels = 0;
	let updatedEntries = 0;
	let updatedLevels = 0;
	let unchangedLevels = 0;
	for (const entry of allowed) {
		if (typeof entry === "string" || !isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.levels)) {
			updatedAllowed.push(entry);
			continue;
		}

		const levelsConfig = entry.levels;
		const modelKey = normalize(entry.id.split("/").pop() ?? entry.id);
		const hasModel = benchmarkModels.has(modelKey);
		if (!hasModel) {
			warnings.push(
				`${entry.id}: no DeepSWE model match; available models: ${[...benchmarkModels].sort().join(", ") || "none"}`,
			);
		}

		const nextLevels = { ...levelsConfig };
		let entryUpdated = false;
		for (const level of Object.keys(levelsConfig)) {
			const levelConfig = levelsConfig[level];
			if (!isRecord(levelConfig)) continue;
			levels++;

			if (!hasModel) {
				reports.push({ id: entry.id, level, status: "failed", changes: {}, missing: ["pass", "cost"] });
				continue;
			}
			const row = byModelAndLevel.get(`${modelKey}\0${level.trim().toLowerCase()}`);
			if (!row) {
				warnings.push(`${entry.id}/${level}: no DeepSWE result for this reasoning effort`);
				reports.push({ id: entry.id, level, status: "failed", changes: {}, missing: ["pass", "cost"] });
				continue;
			}

			const pass = round(row.pass_at_1);
			const cost = round(row.mean_cost_usd);
			if (pass === undefined && cost === undefined) {
				warnings.push(`${entry.id}/${level}: DeepSWE row has no usable metrics`);
				reports.push({ id: entry.id, level, status: "failed", changes: {}, missing: ["pass", "cost"] });
				continue;
			}

			const deepSWE = isRecord(levelConfig.deepSWE) ? levelConfig.deepSWE : {};
			const nextDeepSWE = {
				...deepSWE,
				...(pass === undefined ? {} : { pass }),
				...(cost === undefined ? {} : { cost }),
			};
			const changes: Partial<Record<MetricName, MetricChange>> = {};
			for (const [name, value] of [["pass", pass], ["cost", cost]] as const) {
				if (value !== undefined && deepSWE[name] !== nextDeepSWE[name]) {
					changes[name] = { before: deepSWE[name], after: value };
				}
			}
			const missing = (["pass", "cost"] as const).filter((name) => (name === "pass" ? pass : cost) === undefined);
			if (missing.length > 0) {
				warnings.push(`${entry.id}/${level}: missing DeepSWE metric(s): ${missing.join(", ")} (old value preserved)`);
			}
			const status = Object.keys(changes).length > 0 ? "updated" : "unchanged";
			if (status === "updated") {
				entryUpdated = true;
				updatedLevels++;
			} else {
				unchangedLevels++;
			}
			reports.push({ id: entry.id, level, status, changes, missing });
			nextLevels[level] = { ...levelConfig, deepSWE: nextDeepSWE };
		}
		if (entryUpdated) updatedEntries++;
		updatedAllowed.push({ ...entry, levels: nextLevels });
	}

	return {
		config: { ...raw, allowed: updatedAllowed },
		entries: allowed.length,
		levels,
		updatedEntries,
		updatedLevels,
		unchangedLevels,
		rows: rows.length,
		reports,
		warnings,
	};
}

function display(value: unknown): string {
	return value === undefined ? "missing" : String(value);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const configPath = allowlistPathFromArgs(args);
	const result = await refreshDeepSWE(configPath);
	writeAllowlist(configPath, result.config);

	console.log(`DeepSWE refresh (${configPath})`);
	console.log(
		`Entries: ${result.entries} | rows: ${result.rows} | levels: ${result.levels} | updated: ${result.updatedLevels} | unchanged: ${result.unchangedLevels} | failed: ${result.reports.filter((report) => report.status === "failed").length} | warnings: ${result.warnings.length}`,
	);
	for (const report of result.reports) {
		if (report.status === "failed") {
			console.log(`  ! ${report.id}/${report.level}: no usable result`);
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
