/** Transcript rendering shared by a chat and a sub-agent's live view. */
import { ArrowDown } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AgentMessage } from "../lib/omp";
import type { ToolExecution, TranscriptItem } from "../store/session-events";
import { AssistantMessage, CommandOutputCard, EventRow, GenericMessage, NoticeCard, UserCard } from "./Cards";
import { isPlanSubmitAbort } from "./planAbort";

/** Items to show: tool results render inside their tool card, not on their own. */
export function visibleTranscriptItems(items: TranscriptItem[], toolResults: Record<string, AgentMessage>): TranscriptItem[] {
	return items.filter(item => !(item.kind === "message" && item.message.role === "toolResult" && item.message.toolCallId && toolResults[item.message.toolCallId]));
}

export function TranscriptItems({
	items,
	toolExec,
	toolResults,
	chatId,
	readOnly,
}: {
	/** Already filtered with {@link visibleTranscriptItems}. */
	items: TranscriptItem[];
	toolExec: Record<string, ToolExecution>;
	toolResults: Record<string, AgentMessage>;
	chatId?: string;
	/** A sub-agent's transcript: no message actions that would act on `chatId`'s own session. */
	readOnly?: boolean;
}) {
	return (
		<>
			{items.map((item, index) => {
				switch (item.kind) {
					case "message": {
						const m = item.message;
						if (m.role === "user") return <UserCard key={item.key} message={m} chatId={chatId} readOnly={readOnly} />;
						if (m.role === "assistant")
							return (
								<AssistantMessage
									key={item.key}
									message={m}
									streaming={!!item.streaming}
									toolExec={toolExec}
									toolResults={toolResults}
									chatId={chatId}
									readOnly={readOnly}
									hideAbort={isPlanSubmitAbort(items, index, toolResults)}
								/>
							);
						return <GenericMessage key={item.key} message={m} />;
					}
					case "command_output":
						return <CommandOutputCard key={item.key} text={item.text} ts={item.ts} />;
					case "notice":
						return <NoticeCard key={item.key} item={item} />;
					case "event":
						return <EventRow key={item.key} label={item.label} detail={item.detail} />;
					default:
						return null;
				}
			})}
		</>
	);
}

/** Keep a scroller pinned to the bottom while the reader is near it. */
export function useStickToBottom() {
	const scroller = useRef<HTMLDivElement>(null);
	const [stick, setStick] = useState(true);
	const onScroll = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
	}, []);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick) el.scrollTop = el.scrollHeight;
	});
	const toLatest = useCallback(() => {
		setStick(true);
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, []);
	return { scroller, onScroll, stick, toLatest };
}

/** The "Latest" button shown while scrolled up. */
export function LatestButton({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" className="gy-btn sticky bottom-2 left-full mr-2 shadow" onClick={onClick}>
			<ArrowDown size={13} /> Latest
		</button>
	);
}
