import { theme } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "./config";

/** What a finished `live` run keeps: changes, commits and agent spawns stay; routine reads/searches/commands go. */
export type Category = "change" | "git" | "task" | "routine";

export interface ToolBlock {
	id: string;
	toolName: string;
	args?: Record<string, unknown>;
	result?: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> };
	isError: boolean;
	isPartial: boolean;
	/** write only: the target did not exist when the call started. Unknown (history) counts as an overwrite. */
	created?: boolean;
}

export interface Row {
	label: string;
	category: Category;
}

const TOOL_COLOR: Record<string, string> = {
	read: "accent",
	grep: "mdLink",
	glob: "mdLink",
	find: "mdLink",
	bash: "warning",
	eval: "warning",
	edit: "success",
	write: "success",
	delete: "error",
	task: "customMessageLabel",
	git: "accent",
	todo: "muted",
	wait: "muted",
	mcp: "mdLink",
	xd: "mdLink",
};

const COMMIT_BANNER = /^\[(?:detached HEAD|[^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{4,64})\] ?(.*)$/m;

function str(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Cut to `max` terminal columns (wide CJK characters count two). */
function clipWidth(text: string, max: number): string {
	if (Bun.stringWidth(text) <= max) return text;
	let out = "";
	let width = 0;
	for (const ch of text) {
		const w = Bun.stringWidth(ch);
		if (width + w > max - 1) break;
		out += ch;
		width += w;
	}
	return `${out}…`;
}

function lineCount(text: string): number {
	if (!text) return 0;
	const lines = text.split("\n");
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Project-relative display path. Windows-aware: case-insensitive prefix, either slash. */
export function displayPath(path: string, cwd: string, enabled: boolean): string {
	if (!enabled || !cwd || !path || path.includes("://")) return path;
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const p = norm(path);
	const root = norm(cwd);
	const fold = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
	if (fold(p) === fold(root)) return ".";
	if (fold(p).startsWith(`${fold(root)}/`)) return p.slice(root.length + 1);
	return p;
}

function resultText(block: ToolBlock): string {
	return (block.result?.content ?? [])
		.map(part => (typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.slice(0, 8192);
}

function duration(ms: unknown): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/** Path named by a hashline edit's `[path#TAG]` header. */
function editInputPath(input: unknown): string {
	const match = typeof input === "string" ? /^\[([^\]#\n]+)#[0-9A-F]{4}\]/m.exec(input) : null;
	return match?.[1] ?? "";
}

interface Parts {
	name: string;
	/** Primary argument (path, pattern, command). */
	arg: string;
	/** Already-styled trailing facts (counts, duration, diff stats). */
	meta: string[];
	category: Category;
	/** Replaces intent/arg as the main text (git commits). */
	main?: string;
}

function parts(block: ToolBlock, cwd: string, settings: Settings): Parts {
	const a = block.args ?? {};
	const d = block.result?.details ?? {};
	const done = !block.isPartial;
	const path = (p: unknown) => displayPath(str(p), cwd, settings.compactPaths);
	const p: Parts = { name: block.toolName, arg: "", meta: [], category: "routine" };

	// A write to xd://<device> invokes that device (MCP tools included); it changes no file.
	// The short name keeps the tool column aligned; the device goes in the argument.
	const rawPath = str(a.path ?? a.file_path);
	if (block.toolName === "write" && rawPath.startsWith("xd://")) {
		const device = rawPath.slice(5);
		p.name = device.startsWith("mcp__") ? "mcp" : "xd";
		p.arg = device.replace(/^mcp__/, "");
		return p;
	}

	switch (block.toolName) {
		case "read":
			p.arg = path(a.path ?? a.file_path);
			break;
		case "grep": {
			p.arg = str(a.pattern);
			const scope = str(a.path);
			if (scope && scope !== ".") p.arg += ` in ${path(scope)}`;
			if (done && typeof d.matchCount === "number") {
				const files = typeof d.fileCount === "number" ? ` / ${count(d.fileCount, "file")}` : "";
				p.meta.push(theme.fg("dim", `${count(d.matchCount, "match", "matches")}${files}`));
			}
			break;
		}
		case "glob":
		case "find":
			p.arg = str(a.path ?? a.pattern ?? a.query);
			if (done && typeof d.fileCount === "number") p.meta.push(theme.fg("dim", count(d.fileCount, "file")));
			break;
		case "bash": {
			const command = str(a.command);
			p.arg = command;
			if (a.cwd) p.meta.push(theme.fg("dim", `in ${path(a.cwd)}`));
			if (done) {
				const time = duration(d.wallTimeMs);
				if (time) p.meta.push(theme.fg("dim", time));
				if (typeof d.exitCode === "number" && d.exitCode !== 0) p.meta.push(theme.fg("error", `exit ${d.exitCode}`));
			}
			if (done && !block.isError && /\bgit\b[^;|]*\bcommit\b/.test(command)) {
				const banner = COMMIT_BANNER.exec(resultText(block));
				if (banner) {
					p.name = "git";
					p.category = "git";
					p.main = `commit ${theme.fg("warning", `\x1b[1m${banner[1]}\x1b[22m`)} ${clip(str(banner[2]), 80)}`;
				}
			}
			break;
		}
		case "edit": {
			p.arg = path(d.path ?? a.path ?? editInputPath(a.input));
			if (!done || block.isError) break;
			p.category = "change";
			if (d.op === "delete") {
				p.name = "delete";
				const removed = lineCount(typeof d.oldText === "string" ? d.oldText : "");
				if (removed) p.meta.push(theme.fg("error", `-${removed}`));
				break;
			}
			if (typeof d.diff === "string") {
				let added = 0;
				let removed = 0;
				for (const line of d.diff.split("\n")) {
					if (/^\+\s*\d+\|/.test(line)) added++;
					else if (/^-\s*\d+\|/.test(line)) removed++;
				}
				p.meta.push(`${theme.fg("success", `+${added}`)}${theme.fg("dim", "|")}${theme.fg("error", `${removed}`)}`);
			}
			break;
		}
		case "write":
			p.arg = path(d.resolvedPath ?? a.path ?? a.file_path);
			if (done && !block.isError) {
				p.category = "change";
				if (typeof a.content === "string") {
					const lines = lineCount(a.content);
					// Only a new file's lines are all additions; an overwrite's real diff is unknown here.
					p.meta.push(block.created ? theme.fg("success", `+${lines} new`) : theme.fg("dim", count(lines, "line")));
				}
			}
			break;
		case "task": {
			const tasks = Array.isArray(a.tasks) ? (a.tasks as Array<Record<string, unknown>>) : [];
			const names = tasks.map(t => str(t.name) || str(t.agent) || "task");
			p.arg = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
			p.category = "task";
			break;
		}
		case "todo": {
			const ops = Array.isArray(a.ops) ? (a.ops as Array<Record<string, unknown>>) : [a];
			p.arg = ops.map(op => [str(op.op), str(op.task) || str(op.phase)].filter(Boolean).join(" ")).join("; ");
			break;
		}
		default:
			p.arg = str(a.path ?? a.pattern ?? a.command ?? a.query ?? a.url ?? a.title);
	}
	return p;
}

/** `width`: terminal columns; the argument gets whatever the rest of the row leaves, so the meta after it stays visible. */
export function buildRow(block: ToolBlock, time: string, cwd: string, settings: Settings, width: number): Row {
	const p = parts(block, cwd, settings);
	const intent = str(block.args?.i);
	const status = block.isPartial
		? theme.fg("warning", "◌")
		: block.isError
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");
	const name = theme.fg(TOOL_COLOR[p.name] ?? "toolTitle", `\x1b[1m${p.name.padEnd(5)}\x1b[22m`);

	let main = p.main ?? (settings.showIntent && intent ? intent : p.arg || intent);
	if (block.isError) main = theme.fg("error", main);
	const sep = theme.fg("dim", "  · ");
	const head = settings.showTime && time ? `${theme.fg("dim", time)} ` : "";
	const before = `${head}${status} ${name} ${main}`;
	const after = p.meta.map(m => `${sep}${m}`).join("");
	let arg = "";
	if (!p.main && settings.showIntent && intent && settings.showArgs && p.arg) {
		// omp draws "• " before the label and cuts the row at the terminal edge.
		const room = width - 2 - Bun.stringWidth(`${before}${after}`) - Bun.stringWidth(sep);
		if (room >= 8) arg = `${sep}${theme.fg("muted", clipWidth(p.arg, room))}`;
	}
	return { label: `${before}${arg}${after}`, category: p.category };
}
