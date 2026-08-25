import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const DEFAULT_ALLOWLIST_PATH = path.join(agentDir, "pi-subagent", "models-allowlist.json");

export type ModelAllowlistEntry = {
	id: string;
	levels?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
};

export type ModelAllowlistConfig = {
	allowed?: (string | ModelAllowlistEntry)[];
	[key: string]: unknown;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the active v2 policy, not the copy next to an installed package. */
export function resolveAllowlistPath(explicitPath?: string): string {
	const value = explicitPath?.trim();
	if (!value) return DEFAULT_ALLOWLIST_PATH;
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2));
	return path.resolve(value);
}

/** Accept both a convenient positional path and the documented --config form. */
export function allowlistPathFromArgs(args: string[] = process.argv.slice(2)): string {
	if (args.length === 0) return DEFAULT_ALLOWLIST_PATH;
	if (args.length === 1 && !args[0].startsWith("-")) return resolveAllowlistPath(args[0]);

	if (args.length === 2 && (args[0] === "--config" || args[0] === "--allowlist" || args[0] === "-c")) {
		return resolveAllowlistPath(args[1]);
	}
	if (args.length === 1 && args[0].startsWith("--config=")) return resolveAllowlistPath(args[0].slice("--config=".length));
	if (args.length === 1 && args[0].startsWith("--allowlist=")) return resolveAllowlistPath(args[0].slice("--allowlist=".length));

	throw new Error("Usage: bun refresh-*-benchmarks.ts [--config PATH]");
}

export function readAllowlist(configPath: string): ModelAllowlistConfig {
	const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
	if (!isRecord(parsed)) throw new Error(`Model allowlist must be a JSON object: ${configPath}`);
	if (parsed.allowed !== undefined && !Array.isArray(parsed.allowed)) {
		throw new Error(`Model allowlist field "allowed" must be an array: ${configPath}`);
	}
	return parsed as ModelAllowlistConfig;
}

export function writeAllowlist(configPath: string, config: ModelAllowlistConfig): void {
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
