// Benchmark cache read by subagent_models and written by refresh-benchmarks.ts. It is generated data,
// kept apart from the hand-written policy in settings.json.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LevelBenchmarks {
	artificialAnalysis?: { intelligence?: number; coding?: number; cost?: number };
}

/** Scores by provider/id, then thinking level. */
export type Benchmarks = Record<string, Record<string, LevelBenchmarks>>;

// Standalone scripts cannot rely on Pi's getAgentDir(), so this mirrors it.
export const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const benchmarksPath = (): string => path.join(agentDir(), "pi-subagent", "benchmarks.json");

export function readBenchmarks(file = benchmarksPath()): Benchmarks {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Benchmarks : {};
	} catch {
		return {};
	}
}

export function writeBenchmarks(benchmarks: Benchmarks, file = benchmarksPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(benchmarks, null, 2)}\n`);
}
