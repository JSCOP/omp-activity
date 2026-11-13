/**
 * Presenter rows in a focused subagent view (`Alt+A` → open).
 *
 * omp installs transcript presenters only while the main session is viewed: focusing a subagent re-renders
 * through `InteractiveMode.renderInitialMessages`, which clears them, so the subagent's blocks draw stock cards.
 * This wraps that method once per process and puts the main session's presenters back for the subagent view.
 * Runtime only: omp's files stay untouched, so omp updates keep working.
 */
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent";
import { setTranscriptPresenters } from "@oh-my-pi/pi-tui/chat/transcript-presentation";

export interface SubagentView {
	cwd: string;
	/** Tool call id → time: the issuing assistant message's for history, first sight for live calls. */
	times: Map<string, number>;
}

interface Hook {
	enabled(): boolean;
	/** `undefined` when the main session is viewed again. */
	onView(view: SubagentView | undefined): void;
}

// One wrapper per process, shared by every load of this plugin; the latest main-session load owns the hook.
const store: { hook?: Hook; installed?: boolean } = ((globalThis as Record<symbol, unknown>)[
	Symbol.for("omp-activity.subagent-view")
] ??= {}) as { hook?: Hook; installed?: boolean };

export function setSubagentViewHook(hook: Hook): void {
	store.hook = hook;
}

function callTimes(session): Map<string, number> {
	const times = new Map<string, number>();
	let entries: Array<{ message?: { role?: string; timestamp?: number; content?: unknown } }> = [];
	try {
		entries = session?.sessionManager?.getBranch?.() ?? [];
	} catch {
		return times;
	}
	for (const { message } of entries) {
		if (message?.role !== "assistant" || !Array.isArray(message.content) || typeof message.timestamp !== "number") continue;
		for (const part of message.content) {
			if (part?.type === "toolCall" && typeof part.id === "string") times.set(part.id, message.timestamp);
		}
	}
	return times;
}

/** Returns false when this omp lacks the methods the wrapper relies on; the subagent view then keeps stock cards. */
export function installSubagentView(): boolean {
	if (store.installed) return true;
	const proto = (InteractiveMode as { prototype?: Record<string, unknown> } | undefined)?.prototype;
	const original = proto?.renderInitialMessages;
	if (typeof original !== "function" || typeof proto.refreshTranscriptPresentation !== "function") return false;

	const isSubagentView = mode => !mode.collabGuest && mode.viewSession !== mode.session;
	/**
	 * Before the render: the focus controller has already switched `viewSession`, so the presenter must answer for
	 * the new view from the first block drawn (a stale subagent state would mis-time main blocks and keep `live` rows).
	 */
	const enter = mode => {
		try {
			const view = mode.viewSession;
			store.hook?.onView(
				isSubagentView(mode) ? { cwd: view.sessionManager?.getCwd?.() ?? "", times: callTimes(view) } : undefined,
			);
		} catch {
			store.hook?.onView(undefined);
		}
	};
	/** After omp's own gate cleared the presenters: put the main session's back for a subagent view. */
	const reinstall = mode => {
		try {
			if (!isSubagentView(mode) || !store.hook?.enabled()) return;
			const presenters = mode.session?.extensionRunner?.getTranscriptPresenters?.() ?? [];
			if (setTranscriptPresenters(presenters)) mode.refreshTranscriptPresentation();
		} catch {
			// Display only: never break omp's render over this.
		}
	};
	proto.renderInitialMessages = function (this: unknown, ...args: unknown[]) {
		enter(this);
		const result = original.apply(this, args);
		reinstall(this); // omp clears the presenters synchronously before its first await
		return Promise.resolve(result).finally(() => reinstall(this));
	};
	store.installed = true;
	return true;
}
