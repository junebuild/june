import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type FakeEvent, fakeTrace, subscribe } from "./feed";
import { metrics } from "./metrics";

const KEEP = 500;

export type AppProps = {
  feedUrl: string;
  openEditor: (text: string) => number;
  quit: (reason: string, code: number) => void;
};

export function App({ feedUrl, openEditor, quit }: AppProps) {
  const [events, setEvents] = useState<FakeEvent[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const trace = useRef<ScrollBoxRenderable>(null);
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
        setEvents((prev) => [e, ...prev].slice(0, KEEP));
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

  const move = (delta: number) => {
    const next = events[Math.min(events.length - 1, Math.max(0, selectedIndex + delta))];
    if (next) setSelectedSeq(next.seq);
  };

  useKeyboard((key) => {
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
  });

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {/* Yoga defaults flexShrink to 0: without shrink and minHeight 0 the panes
          take their content height and push the status line onto the border. */}
      <box style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, minHeight: 0 }}>
        <scrollbox title={`pending (${events.length})`} style={{ border: true, width: "45%" }}>
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
