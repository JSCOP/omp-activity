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

	const sync = mode => {
		try {
			const subagent = !mode.collabGuest && mode.viewSession !== mode.session;
			const hook = store.hook;
			hook?.onView(
				subagent ? { cwd: mode.viewSession.sessionManager?.getCwd?.() ?? "", times: callTimes(mode.viewSession) } : undefined,
			);
			if (!subagent || !hook?.enabled()) return;
			// omp cleared the presenters synchronously at the start of the render; blocks drawn so far get redrawn.
			const presenters = mode.session?.extensionRunner?.getTranscriptPresenters?.() ?? [];
			if (setTranscriptPresenters(presenters)) mode.refreshTranscriptPresentation();
		} catch {
			// Display only: never break omp's render over this.
		}
	};
	proto.renderInitialMessages = function (this: unknown, ...args: unknown[]) {
		const result = original.apply(this, args);
		sync(this);
		return Promise.resolve(result).finally(() => sync(this));
	};
	store.installed = true;
	return true;
}
