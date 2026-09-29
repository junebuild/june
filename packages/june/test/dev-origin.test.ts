// `june dev` is a local server — what DNS rebinding targets (#308). It binds
// 127.0.0.1 by default and refuses /mcp and /api for a Host that isn't local.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

import { devAllowedHosts, devUrl, startDevServer, type DevServer } from "../src/dev";

const ROOT = fileURLToPath(new URL("../../../examples/basic", import.meta.url));
const discover = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
});

let server: DevServer;
beforeAll(async () => {
  server = await startDevServer({ appDir: `${ROOT}/app`, port: 4531 });
});
afterAll(() => server.stop(true));

const mcp = (host: string) =>
  fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: { host, origin: `http://${host}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    body: discover,
  });

describe("june dev and DNS rebinding", () => {
  test("a rebound Host (the official conformance scenario) gets 403; localhost is served", async () => {
    expect((await mcp("evil.example.com")).status).toBe(403);
    expect((await mcp(`localhost:${server.port}`)).status).toBe(200);
    expect((await mcp(`127.0.0.1:${server.port}`)).status).toBe(200);
  });

  test("the page itself is unaffected: the check covers /mcp and /api only", async () => {
    expect((await fetch(`${server.url}/`, { headers: { host: "evil.example.com" } })).status).toBe(200);
  });

  test("it binds 127.0.0.1: a LAN address can't reach it", async () => {
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (!lan) return; // no LAN interface on this machine — nothing to prove
    const reached = await new Promise<boolean>((resolve) => {
      const socket = connect(server.port, lan);
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    expect(reached).toBe(false);
  });
});

describe("devUrl", () => {
  test("localhost for loopback and wildcard binds; the bound address otherwise", () => {
    expect(devUrl("127.0.0.1", 3000)).toBe("http://localhost:3000");
    expect(devUrl("0.0.0.0", 3000)).toBe("http://localhost:3000");
    expect(devUrl("::", 3000)).toBe("http://localhost:3000");
    expect(devUrl("192.168.1.20", 3000)).toBe("http://192.168.1.20:3000");
    expect(devUrl("fe80::1", 3000)).toBe("http://[fe80::1]:3000");
    expect(devUrl("my-mac.local", 3000)).toBe("http://my-mac.local:3000");
  });
});

describe("devAllowedHosts", () => {
  test("localhost and its subdomains, plus the config's, plus a NAMED --host", () => {
    expect(devAllowedHosts(undefined, "127.0.0.1")).toEqual(["localhost", ".localhost"]);
    expect(devAllowedHosts([".trycloudflare.com"], "0.0.0.0")).toEqual(["localhost", ".localhost", ".trycloudflare.com"]);
    expect(devAllowedHosts(undefined, "My-Mac.local")).toEqual(["localhost", ".localhost", "my-mac.local"]);
    expect(devAllowedHosts(undefined, "::")).toEqual(["localhost", ".localhost"]); // an IP is always allowed anyway
  });
});
