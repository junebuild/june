// A Shape-B channel: default-export a `(env) => Channel` factory so the signing
// secret resolves from the worker/DO env at request time — secrets don't exist
// at module scope on workerd. The compiled module keeps the factory unresolved;
// the DO (and durableChannelSurface) resolve it with their own env.
import { crispChannel } from "@junejs/core/channels";

export default (env: { CRISP_SIGNATURE_SECRET?: string; CRISP_IDENTIFIER?: string; CRISP_KEY?: string }) =>
  crispChannel({
    signingSecret: env.CRISP_SIGNATURE_SECRET ?? "",
    identifier: env.CRISP_IDENTIFIER ?? "",
    key: env.CRISP_KEY ?? "",
  });
