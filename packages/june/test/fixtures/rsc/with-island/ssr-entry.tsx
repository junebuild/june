// No hand-written webpack shim: importing _rsc-client.gen installs __webpack_require__
// and exposes the moduleMap the Flight consumer resolves client references against.
import { MODULE_MAP } from "./_rsc-client.gen";
import { flightToHtml } from "../../../../src/rsc-runtime/flight-to-html";
export const renderHtml = (flight: string): Promise<string> => flightToHtml(flight, MODULE_MAP);
