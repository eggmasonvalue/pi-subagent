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

export type RefreshResult = { config: ModelAllowlistConfig; entries: number; rows: number; warnings: string[] };

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
	for (const row of rows) {
		if (!row.model || !row.reasoning_effort) continue;
		byModelAndLevel.set(`${normalize(row.model)}\0${row.reasoning_effort}`, row);
	}

	const warnings: string[] = [];
	const updatedAllowed = [] as NonNullable<ModelAllowlistConfig["allowed"]>;
	for (const entry of allowed) {
		if (typeof entry === "string" || !isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.levels)) {
			updatedAllowed.push(entry);
			continue;
		}

		const levels = entry.levels;
		const modelKey = normalize(entry.id.split("/").pop() ?? entry.id);
		const updatedLevels = { ...levels };
		for (const level of Object.keys(levels)) {
			const levelConfig = levels[level];
			if (!isRecord(levelConfig)) continue;
			const row = byModelAndLevel.get(`${modelKey}\0${level}`);
			if (!row) {
				warnings.push(`${entry.id}/${level}: no DeepSWE result`);
				continue;
			}

			const deepSWE = isRecord(levelConfig.deepSWE) ? levelConfig.deepSWE : {};
			const pass = round(row.pass_at_1);
			const cost = round(row.mean_cost_usd);
			updatedLevels[level] = {
				...levelConfig,
				deepSWE: {
					...deepSWE,
					...(pass === undefined ? {} : { pass }),
					...(cost === undefined ? {} : { cost }),
				},
			};
		}
		updatedAllowed.push({ ...entry, levels: updatedLevels });
	}

	return { config: { ...raw, allowed: updatedAllowed }, entries: allowed.length, rows: rows.length, warnings };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const configPath = allowlistPathFromArgs(args);
	const result = await refreshDeepSWE(configPath);
	writeAllowlist(configPath, result.config);
	console.log(`Updated ${result.entries} allowlisted model(s) from ${result.rows} DeepSWE row(s) (${configPath}).`);
	for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
