// The "client" vendor: the NORMAL React build (no react-server condition) +
// react-dom SSR + the Flight client. Client-graph modules (the SSR entry and
// "use client" components) resolve their react imports here, giving a SECOND
// React instance in the same isolate, distinct from the react-server vendor.
// React is CJS — `export *` won't surface its named exports, so list them.
export {
  createContext,
  createElement,
  forwardRef,
  Fragment as ReactFragment,
  memo,
  startTransition,
  Suspense,
  use,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
// Default export = the React object, for deps that do `import React from "react"`
// (e.g. zustand's CJS-interop-safe `import ReactExports from "react"`).
export { default } from "react";
export { Fragment, jsx, jsxs } from "react/jsx-runtime";
export { renderToReadableStream } from "react-dom/server.edge";
export { createFromReadableStream } from "react-server-dom-webpack/client.edge";
