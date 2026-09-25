// turn-events.ts — one turn's live TurnEvents as an AsyncIterable, for a consumer in the
// SAME process as the session: the Durable Object's delivered renders (agent-durable.ts)
// and the native host's ChannelContext.runStream/resumeStream (agent-native.ts).

import type { AgentSession, TurnEvent } from "@junejs/core/agent-runtime";

// Subscribes eagerly at call time — not at first iteration — so the sseTurnStream timing
// guarantee carries over (call this synchronously after start()/resume(), before any event
// can emit); events landing before the consumer catches up are buffered. Ends after the
// turn's terminal event (completed, failed, cancelled, or input.requested — a park ends
// this stream; a later resume is a new one), and an early consumer exit (for-await
// break/return) unsubscribes rather than buffering forever.
export function observeTurnEvents(session: AgentSession, turnId: string): AsyncIterable<TurnEvent> {
  const queue: TurnEvent[] = [];
  let terminal = false;
  let notify: (() => void) | undefined;
  const unsub = session.observe((e) => {
    queue.push(e);
    if (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.cancelled" || e.type === "input.requested") terminal = true;
    notify?.();
  }, { turnId });
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<TurnEvent>> {
          for (;;) {
            const e = queue.shift();
            if (e) return { value: e, done: false };
            if (terminal) { unsub(); return { value: undefined, done: true }; }
            await new Promise<void>((resolve) => { notify = resolve; });
            notify = undefined;
          }
        },
        async return(): Promise<IteratorResult<TurnEvent>> {
          unsub();
          terminal = true;
          queue.length = 0;
          return { value: undefined, done: true };
        },
      };
    },
  };
}
