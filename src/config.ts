import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How a finished run's tool rows are kept. `off` hands every block back to omp's own cards. */
export type Mode = "compact" | "live" | "clear" | "off";
/** Per-tool override: rows follow the mode, `newest` keeps the live card of the latest call, `open` always draws omp's card, `hide` draws nothing. */
export type ToolDisplay = "rows" | "newest" | "open" | "hide";

export interface Settings {
	mode: Mode;
	showTime: boolean;
	/** Show the call's intent (`i`) as the main text; off shows the primary argument instead. */
	showIntent: boolean;
	/** Append the primary argument after the intent in muted color. */
	showArgs: boolean;
	/** One stats row under each finished run. */
	stats: boolean;
	/** Shorten paths inside the session cwd to project-relative form. */
	compactPaths: boolean;
	/** Condense non-blocking advisor notes to one row each. */
	compactAdvisor: boolean;
	tools: Record<string, ToolDisplay>;
	cycleKey: string;
	/** Draw these rows in a focused subagent view too (omp itself draws stock cards there). */
	subagentView: boolean;
}

export const MODES: readonly Mode[] = ["compact", "live", "clear", "off"];
export const TOOL_DISPLAYS: readonly ToolDisplay[] = ["rows", "newest", "open", "hide"];

export const DEFAULT_TOOLS: Readonly<Record<string, ToolDisplay>> = { ask: "open", wait: "newest", todo: "newest" };

export const DEFAULTS: Settings = {
	mode: "live",
	showTime: true,
	showIntent: true,
	showArgs: true,
	stats: true,
	compactPaths: true,
	compactAdvisor: false,
	tools: {},
	cycleKey: "alt+c",
	subagentView: true,
};

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
export const CONFIG_PATH = join(agentDir, "omp-activity.json");

const BOOLEAN_KEYS = ["showTime", "showIntent", "showArgs", "stats", "compactPaths", "compactAdvisor", "subagentView"] as const;

/** Read the config, keeping only well-typed fields; a missing or broken file yields the defaults. */
export function loadSettings(): Settings {
	const settings: Settings = { ...DEFAULTS, tools: {} };
	let raw: Record<string, unknown>;
	try {
		raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
	} catch {
		return settings;
	}
	if (MODES.includes(raw.mode as Mode)) settings.mode = raw.mode as Mode;
	for (const key of BOOLEAN_KEYS) if (typeof raw[key] === "boolean") settings[key] = raw[key] as boolean;
	if (typeof raw.cycleKey === "string" && raw.cycleKey.trim()) settings.cycleKey = raw.cycleKey.trim();
	if (raw.tools && typeof raw.tools === "object") {
		for (const [name, value] of Object.entries(raw.tools)) {
			if (TOOL_DISPLAYS.includes(value as ToolDisplay)) settings.tools[name] = value as ToolDisplay;
		}
	}
	return settings;
}

/** Atomic write so a crash mid-save never leaves a truncated config. */
export function saveSettings(settings: Settings): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const tmp = `${CONFIG_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, "\t")}\n`);
	renameSync(tmp, CONFIG_PATH);
}

export function toolDisplay(settings: Settings, toolName: string): ToolDisplay {
	return settings.tools[toolName] ?? DEFAULT_TOOLS[toolName] ?? "rows";
}
