import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type FakeEvent, fakeTrace, subscribe } from "./feed";
import { metrics } from "./metrics";

const KEEP = 500;

// Cap the list at KEEP, but never drop the selected event: the operator is
// looking at it.
function keepSelected(next: FakeEvent[], selectedSeq: number | null): FakeEvent[] {
  if (next.length <= KEEP) return next;
  const kept = next.slice(0, KEEP);
  if (selectedSeq === null || kept.some((e) => e.seq === selectedSeq)) return kept;
  const sel = next.find((e) => e.seq === selectedSeq);
  if (sel) kept[KEEP - 1] = sel;
  return kept;
}

export type AppProps = {
  feedUrl: string;
  openEditor: (text: string) => number;
  quit: (reason: string, code: number) => void;
  // Keys that arrived before this component could listen (main.tsx).
  drainEarlyKeys: () => KeyEvent[];
};

export function App({ feedUrl, openEditor, quit, drainEarlyKeys }: AppProps) {
  const [events, setEvents] = useState<FakeEvent[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const trace = useRef<ScrollBoxRenderable>(null);
  const list = useRef<ScrollBoxRenderable>(null);
  // Read by the feed loop, which must not evict the selected event.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedSeq;
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    metrics.mounts++;
  }, []);

  useEffect(() => {
    metrics.sizes.push([width, height]);
  }, [width, height]);

  // One subscription for the component's lifetime. A second one after an
  // $EDITOR round-trip would mean the tree was remounted (§4).
  useEffect(() => {
    const ac = new AbortController();
    metrics.activeSubscriptions++;
    metrics.maxActiveSubscriptions = Math.max(metrics.maxActiveSubscriptions, metrics.activeSubscriptions);
    (async () => {
      for await (const e of subscribe(feedUrl, ac.signal)) {
        metrics.events++;
        setEvents((prev) => keepSelected([e, ...prev], selectedRef.current));
      }
    })().catch(() => {});
    return () => {
      metrics.activeSubscriptions--;
      ac.abort();
    };
  }, [feedUrl]);

  const selectedIndex = Math.max(0, events.findIndex((e) => e.seq === selectedSeq));
  const selected = events[selectedIndex];
  const lines = useMemo(() => (selected ? fakeTrace(selected) : []), [selected?.seq]);

  // New events are prepended, pushing an older selection down ~20 rows/s:
  // keep it in view. With nothing selected, the newest row is highlighted and
  // the list stays at the top. Both halves of this were measured (the
  // harness's "selected row stays on screen" check, 20 samples):
  // - useLayoutEffect, not useEffect: a passive effect runs after OpenTUI has
  //   already drawn a frame with the new row inserted (9–18/20 visible).
  // - From the data, not scrollChildIntoView: at commit time the new rows are
  //   not laid out yet, so it scrolls one row short (0/20). Every row is one
  //   line, so the selected row sits at selectedIndex.
  useLayoutEffect(() => {
    const box = list.current;
    if (!box || selectedSeq === null) return;
    const height = box.viewport.height;
    if (selectedIndex < box.scrollTop) box.scrollTop = selectedIndex;
    else if (selectedIndex >= box.scrollTop + height) box.scrollTop = selectedIndex - height + 1;
  }, [selectedSeq, selectedIndex, events]);

  // A functional update, so several queued moves replayed in one pass each
  // take effect instead of all starting from the same selectedIndex.
  const move = (delta: number) =>
    setSelectedSeq((prev) => {
      const i = Math.max(0, events.findIndex((e) => e.seq === prev));
      return events[Math.min(events.length - 1, Math.max(0, i + delta))]?.seq ?? prev;
    });

  const handle = (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return quit("ctrl-c", 130);
    switch (key.name) {
      case "q":
        return quit("q", 0);
      case "j":
      case "down":
        return move(1);
      case "k":
      case "up":
        return move(-1);
      case "pagedown":
        return trace.current?.scrollBy(20);
      case "pageup":
        return trace.current?.scrollBy(-20);
      case "g":
        return key.shift ? trace.current?.scrollTo(trace.current.scrollHeight) : trace.current?.scrollTo(0);
      case "e": {
        const code = openEditor(selected ? `To: ${selected.from}\nSubject: Re: ${selected.subject}\n\n` : "");
        setNote(`editor exited ${code}`);
        return;
      }
    }
    // A crash outside React's render path: the uncaughtException hook must
    // still restore the terminal (§4).
    if (key.sequence === "!") {
      setTimeout(() => {
        throw new Error("tui-spike: deliberate crash");
      }, 0);
    }
  };

  // Typeahead. OpenTUI emits keys as soon as the renderer exists, but
  // useKeyboard only listens once its effect has run: a key typed during
  // startup reached no listener (measured: `q` sent before the first frame was
  // lost 5/5, while OpenTUI's own keyInput saw it 5/5), so main.tsx buffers
  // them. Replaying is not enough on its own: before the first event arrives
  // the list is empty and `j` would be spent on nothing. So quit keys act at
  // once, and every other key — early or live — waits in `pending` until the
  // list has data, then runs in order.
  const ready = events.length > 0;
  const pending = useRef<KeyEvent[]>([]);
  const immediate = (key: KeyEvent) => (key.ctrl && key.name === "c") || key.name === "q" || key.sequence === "!";
  const onKey = (key: KeyEvent) => {
    if (!ready && !immediate(key)) pending.current.push(key);
    else handle(key);
  };
  useKeyboard(onKey);
  // Declared after useKeyboard, so it runs after the subscription exists.
  useEffect(() => {
    for (const key of drainEarlyKeys()) onKey(key);
  }, []);
  useEffect(() => {
    if (ready) for (const key of pending.current.splice(0)) handle(key);
  }, [ready]);

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {/* Yoga defaults flexShrink to 0: without shrink and minHeight 0 the panes
          take their content height and push the status line onto the border. */}
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        <scrollbox ref={list} title={`pending (${events.length})`} style={{ border: true, width: "45%" }}>
          {events.map((e, i) => (
            <text
              key={e.seq}
              content={`${String(e.seq).padStart(5)}  ${e.subject}`}
              wrapMode="none"
              truncate
              fg={i === selectedIndex ? "#000000" : "#d0d0d0"}
              bg={i === selectedIndex ? "#7aa2f7" : undefined}
            />
          ))}
        </scrollbox>
        <scrollbox ref={trace} title={selected ? `trace #${selected.seq}` : "trace"} style={{ border: true, flexGrow: 1 }}>
          {lines.map((l, i) => (
            <text key={i} content={l} wrapMode="none" truncate />
          ))}
        </scrollbox>
      </box>
      <text
        content={` j/k select · PgUp/PgDn g/G trace · e editor · q quit · events ${metrics.events} · ${width}x${height} ${note}`}
        fg="#888888"
        wrapMode="none"
        truncate
        style={{ height: 1, flexShrink: 0 }}
      />
    </box>
  );
}
