import { existsSync, unwatchFile, watchFile } from "node:fs";
import { resolve } from "node:path";
import {
	cfgExtensionTranscriptPresenters,
	compactText,
	settings as hostSettings,
	styledSpans,
	theme,
} from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import {
	CONFIG_PATH,
	loadSettings,
	MODES,
	type Mode,
	saveSettings,
	type Settings,
	TOOL_DISPLAYS,
	type ToolDisplay,
	toolDisplay,
} from "./config";
import { buildRow, type ToolBlock } from "./rows";

const STATS_TYPE = "omp-activity:stats";
const STATS_CONTENT = "[omp-activity run stats]";
const PRESENTER_SETTING = "/settings → Tools → Extensions → Extension Transcript Presenters";

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface Run {
	calls: string[];
	active: boolean;
	/** Ended with a visible final answer: `live` may drop its routine rows. */
	answered: boolean;
	startedAt: number;
	actions: number;
	errors: number;
	usage: Usage;
	/** Latest call id per tool name, for `newest` cards. */
	newest: Map<string, string>;
}

interface StatsDetails extends Usage {
	actions: number;
	errors: number;
	elapsedMs: number;
	endedAt: number;
}

type Message = {
	role?: string;
	stopReason?: string;
	timestamp?: number;
	isError?: boolean;
	customType?: string;
	details?: unknown;
	usage?: Partial<Usage>;
	content?: unknown;
};

function newRun(startedAt: number): Run {
	return {
		calls: [],
		active: true,
		answered: false,
		startedAt,
		actions: 0,
		errors: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		newest: new Map(),
	};
}

function contentParts(message: Message): Array<Record<string, unknown>> {
	return Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
}

/** A run ends answered when its last message is an assistant stop with visible text and no tool call. */
function endedWithAnswer(last: Message | undefined): boolean {
	if (last?.role !== "assistant" || (last.stopReason !== "stop" && last.stopReason !== "length")) return false;
	const parts = contentParts(last);
	if (parts.some(part => part.type === "toolCall")) return false;
	return parts.some(part => part.type === "text" && typeof part.text === "string" && part.text.trim() !== "");
}

function addUsage(run: Run, usage: Partial<Usage> | undefined): void {
	if (!usage) return;
	run.usage.input += usage.input ?? 0;
	run.usage.output += usage.output ?? 0;
	run.usage.cacheRead += usage.cacheRead ?? 0;
	run.usage.cacheWrite += usage.cacheWrite ?? 0;
}

function tokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function elapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clock(ts: number): string {
	return new Date(ts).toTimeString().slice(0, 8);
}

function statsLine(d: StatsDetails): string {
	const prompt = d.input + d.cacheRead + d.cacheWrite;
	const pieces = [
		`${d.actions} actions`,
		...(d.errors ? [`${d.errors} failed`] : []),
		`↑${tokens(prompt)}${d.cacheRead ? ` (${tokens(d.cacheRead)} cached)` : ""}`,
		`↓${tokens(d.output)}`,
		elapsed(d.elapsedMs),
	];
	const body = `[ ${pieces.join(" · ")} ] — ${clock(d.endedAt)}`;
	return d.errors ? theme.fg("warning", body) : theme.fg("dim", body);
}

class StatsRow {
	constructor(
		private readonly details: StatsDetails,
		private readonly enabled: () => boolean,
	) {}
	render(width: number): string[] {
		return this.enabled() ? [truncateToWidth(statsLine(this.details), width)] : [];
	}
	invalidate(): void {}
	isTranscriptBlockCompact(): boolean {
		return true;
	}
}

export default function ompActivity(pi) {
	let settings: Settings = loadSettings();
	let cwd = "";
	/** Context of the latest event: the only route to `ui.refreshTranscript` outside handlers. */
	let ui: { refreshTranscript?: (ids: string[]) => void; notify?: (m: string, t?: string) => void } | undefined;
	let active: Run | undefined;
	const callRun = new Map<string, Run>();
	const callTime = new Map<string, number>();
	const advisorIds = new Set<string>();
	/** write call id → target absent at start (new file). */
	const writeCreated = new Map<string, boolean>();
	let presenterHintShown = false;
	let statsTimer: NodeJS.Timeout | undefined;

	const refresh = (ids: Iterable<string>) => {
		try {
			ui?.refreshTranscript?.([...ids]);
		} catch {
			// The session that owned this ui is gone.
		}
	};
	// callTime also holds blocks drawn before any run claimed them (history drawn ahead of session_start).
	const drawnIds = () => new Set([...callTime.keys(), ...callRun.keys(), ...advisorIds]);
	const refreshAll = () => refresh(drawnIds());

	/** Read-modify-write: another session may have saved since this one loaded its copy. */
	function update(change: Partial<Settings>): void {
		settings = { ...loadSettings(), ...change };
		saveSettings(settings);
		refreshAll();
	}

	// Every running session follows a change saved by any of them, as omp's own settings do.
	// The cycle shortcut is bound once at load, so a changed `cycleKey` still needs a restart.
	const onConfigChange = () => {
		const next = loadSettings();
		if (JSON.stringify(next) === JSON.stringify(settings)) return;
		settings = next;
		refreshAll();
	};
	watchFile(CONFIG_PATH, { interval: 1000, persistent: false }, onConfigChange);
	pi.on("session_shutdown", () => unwatchFile(CONFIG_PATH, onConfigChange));

	function attach(id: string, run: Run, at: number): void {
		if (!callRun.has(id)) {
			callRun.set(id, run);
			run.calls.push(id);
		}
		if (!callTime.has(id)) callTime.set(id, at);
	}

	/**
	 * Rebuild runs, call times and outcomes from the session branch (resume, tree, branch, compaction),
	 * then redraw both the blocks drawn before (they may hold first-seen times) and the rebuilt ones.
	 */
	function rebuild(ctx): void {
		const before = drawnIds();
		active = undefined;
		callRun.clear();
		callTime.clear();
		advisorIds.clear();
		writeCreated.clear();
		clearTimeout(statsTimer);
		cwd = ctx?.sessionManager?.getCwd?.() ?? ctx?.cwd ?? cwd;
		let entries: Array<{ type?: string; message?: Message }> = [];
		try {
			entries = ctx?.sessionManager?.getBranch?.() ?? [];
		} catch {
			refresh(before);
			return;
		}
		let run: Run | undefined;
		let last: Message | undefined;
		const close = () => {
			if (!run) return;
			run.active = false;
			run.answered = endedWithAnswer(last);
		};
		for (const entry of entries) {
			const message = entry.type === "message" ? entry.message : undefined;
			if (!message) continue;
			if (message.role === "user") {
				close();
				run = newRun(message.timestamp ?? 0);
				last = undefined;
				continue;
			}
			if (!run) run = newRun(message.timestamp ?? 0);
			if (message.role === "assistant") {
				last = message;
				addUsage(run, message.usage);
				for (const part of contentParts(message)) {
					if (part.type === "toolCall" && typeof part.id === "string") attach(part.id, run, message.timestamp ?? 0);
				}
			} else if (message.role === "toolResult" && message.isError) {
				run.errors++;
			}
		}
		close();
		refresh(new Set([...before, ...drawnIds()]));
	}

	function hintPresenterSetting(ctx): void {
		if (presenterHintShown || !ctx?.hasUI) return;
		let enabled: boolean | undefined;
		try {
			enabled = cfgExtensionTranscriptPresenters?.get(hostSettings);
		} catch {
			enabled = undefined;
		}
		if (enabled !== false) return;
		presenterHintShown = true;
		ctx.ui.notify(`omp-activity draws nothing until transcript presenters are on: ${PRESENTER_SETTING}`, "warning");
	}

	/** `agent_end` fires while the session is still busy; a stats message sent then stays hidden until the next turn. */
	function sendStatsWhenIdle(ctx, details: StatsDetails): void {
		const attempt = (tries: number) => {
			statsTimer = setTimeout(() => {
				let idle = false;
				try {
					idle = ctx.isIdle();
				} catch {
					return;
				}
				if (!idle) {
					if (tries < 600) attempt(tries + 1);
					return;
				}
				pi.sendMessage(
					{ customType: STATS_TYPE, content: STATS_CONTENT, display: true, details },
					{ deliverAs: "nextTurn" },
				);
			}, 50);
			statsTimer.unref?.();
		};
		attempt(0);
	}

	const track = (event: string, handler: (event, ctx) => void) =>
		pi.on(event, (e, ctx) => {
			if (ctx?.ui) ui = ctx.ui;
			handler(e, ctx);
		});

	track("session_start", (_e, ctx) => {
		rebuild(ctx);
		hintPresenterSetting(ctx);
	});
	track("session_switch", (e, ctx) => {
		if (e?.reason !== "fork") rebuild(ctx);
	});
	for (const event of ["session_tree", "session_branch", "session_compact"]) track(event, (_e, ctx) => rebuild(ctx));
	for (const event of ["session_before_switch", "session_before_tree", "session_before_branch"])
		track(event, () => clearTimeout(statsTimer));

	track("agent_start", () => {
		if (active?.active) {
			active.active = false;
			refresh(active.calls);
		}
		active = newRun(Date.now());
	});

	track("message_end", e => {
		const message: Message | undefined = e?.message;
		if (!active || message?.role !== "assistant") return;
		addUsage(active, message.usage);
		for (const part of contentParts(message)) {
			if (part.type === "toolCall" && typeof part.id === "string") attach(part.id, active, Date.now());
		}
	});

	track("tool_execution_start", e => {
		if (!active || typeof e?.toolCallId !== "string") return;
		callTime.set(e.toolCallId, Date.now());
		attach(e.toolCallId, active, Date.now());
		active.actions++;
		const target = e.toolName === "write" ? e.args?.path : undefined;
		if (typeof target === "string" && !target.includes("://")) writeCreated.set(e.toolCallId, !existsSync(resolve(cwd, target)));
		const previous = active.newest.get(e.toolName);
		active.newest.set(e.toolName, e.toolCallId);
		if (previous && toolDisplay(settings, e.toolName) === "newest") refresh([previous]);
	});

	track("tool_execution_end", e => {
		if (active && e?.isError) active.errors++;
	});

	track("agent_end", (e, ctx) => {
		if (e?.willContinue || !active) return;
		const run = active;
		const messages: Message[] = Array.isArray(e?.messages) ? e.messages : [];
		run.active = false;
		run.answered = endedWithAnswer(messages[messages.length - 1]);
		refresh(run.calls);
		if (settings.stats && run.actions + run.usage.output > 0) {
			const now = Date.now();
			sendStatsWhenIdle(ctx, {
				...run.usage,
				actions: run.actions,
				errors: run.errors,
				elapsedMs: now - run.startedAt,
				endedAt: now,
			});
		}
	});

	// The stats row is for the user only; it never reaches the model.
	pi.on("context", event => {
		const messages = event.messages.filter(m => m.role !== "custom" || m.customType !== STATS_TYPE);
		return messages.length === event.messages.length ? undefined : { messages };
	});

	pi.registerMessageRenderer(STATS_TYPE, message => new StatsRow(message.details as StatsDetails, () => settings.stats));

	pi.registerTranscriptPresenter(block => {
		if (block.type === "message") {
			const message: Message = block.message;
			if (message?.customType !== "advisor") return undefined;
			advisorIds.add(block.id);
			if (!settings.compactAdvisor || settings.mode === "off") return undefined;
			const details = message.details;
			const notes: Array<{ note?: unknown; severity?: unknown }> | undefined =
				details && typeof details === "object" && "notes" in details && Array.isArray(details.notes) ? details.notes : undefined;
			if (!Array.isArray(notes) || notes.length === 0) return undefined;
			if (notes.some(n => typeof n.note !== "string" || (n.severity !== undefined && n.severity !== "nit" && n.severity !== "concern")))
				return undefined;
			const rows = notes.map(n => {
				const severity = n.severity ?? "nit";
				const tag = theme.fg(severity === "concern" ? "warning" : "muted", `[${severity}]`);
				const first = String(n.note).split("\n").find(line => line.trim()) ?? "";
				return compactText(styledSpans(`${theme.fg("customMessageLabel", "advisor")} ${tag} ${first.trim()}`));
			});
			return { compact: { label: rows[0], rows: rows.slice(1) } };
		}
		if (block.type !== "toolCall") return undefined;

		const tool = block as ToolBlock;
		if (!callRun.has(tool.id)) {
			if (active?.active) attach(tool.id, active, Date.now());
			else callTime.set(tool.id, callTime.get(tool.id) ?? Date.now());
		}
		if (settings.mode === "off") return undefined;

		const display: ToolDisplay = toolDisplay(settings, tool.toolName);
		if (display === "open") return "full";
		if (display === "hide") return "hidden";
		const run = callRun.get(tool.id);
		const running = run?.active === true;
		if (display === "newest" && running && (tool.isPartial || run.newest.get(tool.toolName) === tool.id)) return "full";

		const at = callTime.get(tool.id);
		const row = buildRow(
			{ ...tool, isPartial: running && tool.isPartial, created: writeCreated.get(tool.id) },
			at ? clock(at) : "",
			cwd,
			settings,
		);
		// No run record: history the rebuild could not place, drawn as answered.
		const answered = run ? !running && run.answered : true;
		if (settings.mode === "live" && answered && row.category === "routine") return "hidden";
		if (settings.mode === "clear" && row.category !== "git") return "hidden";
		return { compact: { label: compactText(styledSpans(row.label)) } };
	});

	const nextMode = (mode: Mode): Mode => MODES[(MODES.indexOf(mode) + 1) % MODES.length];

	pi.registerShortcut(settings.cycleKey, {
		description: "Cycle omp-activity display: compact / live / clear / off",
		handler: ctx => {
			if (ctx?.ui) ui = ctx.ui;
			update({ mode: nextMode(loadSettings().mode) });
			ui?.notify?.(`Activity: ${settings.mode}`, "info");
		},
	});

	const BOOLEAN_OPTIONS: Array<[keyof Settings, string]> = [
		["showTime", "시각 표시"],
		["showIntent", "의도 문구 표시"],
		["showArgs", "의도 뒤에 경로/명령 표시"],
		["stats", "실행 통계 줄"],
		["compactPaths", "프로젝트 상대 경로"],
		["compactAdvisor", "advisor nit/concern 한 줄"],
	];

	pi.registerCommand("activity", {
		description: "omp-activity settings: mode, options, per-tool display",
		handler: async (args: string, ctx) => {
			if (ctx?.ui) ui = ctx.ui;
			const [key, value, extra] = args.trim().split(/\s+/).filter(Boolean);
			const notify = (m: string) => ctx.ui.notify(m, "info");
			if (key) {
				if (key === "mode" && MODES.includes(value as Mode)) update({ mode: value as Mode });
				else if (key === "tool" && value && TOOL_DISPLAYS.includes(extra as ToolDisplay))
					update({ tools: { ...settings.tools, [value]: extra as ToolDisplay } });
				else if (BOOLEAN_OPTIONS.some(([k]) => k === key) && (value === "on" || value === "off"))
					update({ [key]: value === "on" } as Partial<Settings>);
				else
					return notify(
						`usage: /activity [mode ${MODES.join("|")}] [<${BOOLEAN_OPTIONS.map(([k]) => k).join("|")}> on|off] [tool <name> ${TOOL_DISPLAYS.join("|")}]`,
					);
				return notify(`omp-activity: ${key} ${value}${extra ? ` ${extra}` : ""} (saved to ${CONFIG_PATH})`);
			}

			const modeItem = `모드: ${settings.mode}`;
			const toolItem = "도구별 표시…";
			const items = [
				modeItem,
				...BOOLEAN_OPTIONS.map(([k, label]) => `${label}: ${settings[k] ? "on" : "off"}`),
				toolItem,
			];
			const picked = await ctx.ui.select("omp-activity", items);
			if (!picked) return;
			if (picked === modeItem) {
				const mode = await ctx.ui.select("모드 (compact: 전부 유지 / live: 답변 후 변경·커밋만 / clear: 커밋만 / off: omp 카드)", [
					...MODES,
				]);
				if (mode) update({ mode: mode as Mode });
				return;
			}
			if (picked === toolItem) {
				const name = (await ctx.ui.input("도구 이름 (예: bash, read, wait)"))?.trim();
				if (!name) return;
				const display = await ctx.ui.select(`${name}: 현재 ${toolDisplay(settings, name)}`, [...TOOL_DISPLAYS]);
				if (display) update({ tools: { ...settings.tools, [name]: display as ToolDisplay } });
				return;
			}
			const option = BOOLEAN_OPTIONS[items.indexOf(picked) - 1];
			if (option) update({ [option[0]]: !settings[option[0]] } as Partial<Settings>);
		},
	});
}
