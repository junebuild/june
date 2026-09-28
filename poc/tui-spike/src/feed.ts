// A stand-in for the InboxEvent change feed (docs/rfc-email.md §9.2): a local
// SSE endpoint that emits pending-action events at a fixed rate, read back
// over real HTTP streaming so the TUI exercises the same path it will in P1c.

export type FakeEvent = { seq: number; from: string; subject: string };

// Fictional correspondents; mixed scripts and emoji on purpose (§5: CJK width).
const SUBJECTS = [
  "Refund request for order 1042",
  "請確認下週的交貨日期",
  "注文番号 3321 の返品について",
  "환불 요청 — 주문 7781",
  "Invoice overdue 🧾 — second reminder",
  "Café meeting moved to Thursday ☕",
  "Re: 合約條款第 4.2 節 🙏",
];
const FROM = ["alice@example.com", "王小明 <ming@example.tw>", "佐藤 <sato@example.jp>", "ops@example.org"];

export function fakeEvent(seq: number): FakeEvent {
  return { seq, from: FROM[seq % FROM.length]!, subject: SUBJECTS[seq % SUBJECTS.length]! };
}

export function startFeedServer(ratePerSec: number) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      let seq = Number(new URL(req.url).searchParams.get("cursor") ?? 0);
      let timer: ReturnType<typeof setInterval> | undefined;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => {
            seq++;
            controller.enqueue(enc.encode(`id: ${seq}\ndata: ${JSON.stringify(fakeEvent(seq))}\n\n`));
          }, 1000 / ratePerSec);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
}

export async function* subscribe(url: string, signal: AbortSignal): AsyncGenerator<FakeEvent> {
  const res = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as FakeEvent;
    }
  }
}

// A long TurnTrace for the detail pane: tool calls, results, reasoning lines.
export function fakeTrace(e: FakeEvent, lines = 2000): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const n = String(i).padStart(4, "0");
    switch (i % 4) {
      case 0:
        out.push(`${n}  tool_call   lookup_order {"order": ${1000 + ((e.seq + i) % 9000)}}`);
        break;
      case 1:
        out.push(`${n}  result      status=shipped carrier=黑貓宅急便 eta=2 days`);
        break;
      case 2:
        out.push(`${n}  reasoning   The customer (${e.from}) asks: ${e.subject}`);
        break;
      default:
        out.push(`${n}  draft       Thanks — 已收到您的來信，我們會在 24 小時內回覆 ✅`);
    }
  }
  return out;
}
