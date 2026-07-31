// A minimal stand-in for @anthropic-ai/sdk so the fixture build can RESOLVE
// and BUNDLE the static import the generated entry emits (linkJunejs symlinks
// this under node_modules/@anthropic-ai/sdk). Never invoked by the tests — the
// assertions stop at the built artifact. Keeping the repo free of the real SDK
// preserves core's "helpful error without the optional peer" test.
export default class Anthropic {
  constructor(opts) {
    this.apiKey = opts?.apiKey;
  }
  messages = {
    stream() {
      throw new Error("@anthropic-ai/sdk stub: not a real transport");
    },
  };
}
