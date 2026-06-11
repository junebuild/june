// The "react-server" vendor: react (react-server build) + the Flight renderer,
// bundled once and re-exported. App modules in the server graph import "react"
// and "react-server-dom-webpack/server.edge"; the custom loader resolves BOTH to
// this module, so un-bundled app code shares one react-server React instance.
export { Fragment, jsx, jsxs } from "react/jsx-runtime";
export {
  decodeReply,
  registerClientReference,
  registerServerReference,
  renderToReadableStream,
} from "react-server-dom-webpack/server.edge";
