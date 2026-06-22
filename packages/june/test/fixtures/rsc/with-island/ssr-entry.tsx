import { Tabs } from "./Tabs";
import { flightToHtml } from "../../../../src/rsc-runtime/flight-to-html";

const CLIENT_MODULES: Record<string, unknown> = { "rsc/Tabs": { Tabs } };
const g = globalThis as Record<string, unknown>;
g.__webpack_require__ = (id: string) => CLIENT_MODULES[id];
g.__webpack_chunk_load__ = () => Promise.resolve();

// moduleMap[id][exportName] = chunk descriptor — how client.edge resolves a ref.
const moduleMap = { "rsc/Tabs": { Tabs: { id: "rsc/Tabs", chunks: [], name: "Tabs" } } };

export const renderHtml = (flight: string): Promise<string> => flightToHtml(flight, moduleMap);
