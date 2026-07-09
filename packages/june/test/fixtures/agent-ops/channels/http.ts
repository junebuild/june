// A channel is another file in the directory. httpChannel() serves POST /message
// (a durable turn) — the same agent, reachable over HTTP.
import { httpChannel } from "@junejs/core/channels";

export default httpChannel();
