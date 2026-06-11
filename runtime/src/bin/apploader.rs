// Real-runtime core: a custom ModuleLoader that loads UN-BUNDLED app modules and
// resolves the `react-server` condition PER GRAPH, in one V8 isolate:
//
//   server graph (entry-server -> page)   react-* -> vendor-server.mjs (react-server)
//   client graph (entry-ssr -> Counter)   react-* -> vendor-client.mjs (normal React)
//
// Two React instances, one isolate. The server graph renders Flight (with a
// client reference for Counter); the client graph consumes that Flight and SSRs
// it to HTML, resolving the reference to the real Counter. This is full RSC SSR
// with a client component, all from un-bundled app code.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use anyhow::anyhow;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as UrlPath, State,
    },
    http::{HeaderMap, StatusCode, Uri},
    response::sse::{Event, KeepAlive, Sse},
    response::{Html, IntoResponse, Response},
    Router,
};
use crossbeam_channel::{bounded, Receiver, Sender};
use notify::{Config, PollWatcher, RecursiveMode, Watcher};
use regex::Regex;
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};
use deno_ast::{
    EmitOptions, JsxAutomaticOptions, JsxRuntime, MediaType, ParseParams, TranspileModuleOptions,
    TranspileOptions,
};
use tokio::sync::oneshot;
use deno_core::{
    op2, FsModuleLoader, JsRuntime, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse,
    ModuleLoader, ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, OpState,
    ResolutionKind, RuntimeOptions,
};
use deno_error::JsErrorBox as ModuleLoaderError;
use deno_permissions::{PermissionsContainer, RuntimePermissionDescriptorParser};

/// Transpile TS/TSX/JSX to JS with React's automatic JSX runtime
/// (`import { jsx } from "react/jsx-runtime"`), so app code can be real `.tsx`.
// ---- React Compiler (facebook/react#36173, merged 2026-06-09) ---------------
// Opt-in via JUNE_REACT_COMPILER=1 (upstream calls the Rust port experimental):
// auto-memoize "use client" modules as a source→source pre-pass in the ONE
// transpile funnel below (SSR loader + /@june/client both call it). Pipeline:
// deno_ast type-strip KEEPING JSX (the compiler parses JS/JSX only, verified)
// → react_compiler_swc transform → the normal JSX transpile. Strings cross the
// swc 18/21 boundary; see docs/react-compiler-poc.md.
fn react_compiler_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("JUNE_REACT_COMPILER").map(|v| v == "1").unwrap_or(false))
}

fn maybe_react_compile(specifier: &ModuleSpecifier, source: &str) -> Option<String> {
    if !react_compiler_enabled() {
        return None;
    }
    let media = MediaType::from_specifier(specifier);
    if !matches!(media, MediaType::Tsx | MediaType::Jsx) {
        return None;
    }
    // Client components only: server components re-render per request, so
    // memoization there is low-value (and hooks don't run server-side anyway).
    let first = source
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("//"))?;
    if !(first.starts_with("\"use client\"") || first.starts_with("'use client'")) {
        return None;
    }

    // 1) strip TS types, KEEP JSX (jsx: None) — the compiler rejects TS syntax.
    let stripped = if media == MediaType::Tsx {
        let parsed = deno_ast::parse_module(ParseParams {
            specifier: specifier.clone(),
            text: source.into(),
            media_type: media,
            capture_tokens: false,
            scope_analysis: false,
            maybe_syntax: None,
        })
        .ok()?;
        parsed
            .transpile(
                &TranspileOptions { jsx: None, ..Default::default() },
                &TranspileModuleOptions::default(),
                &EmitOptions::default(),
            )
            .ok()?
            .into_source()
            .text
    } else {
        source.to_string()
    };

    // 2) auto-memoize (infer mode: components + hooks, like the Babel plugin)
    let options: react_compiler::entrypoint::plugin_options::PluginOptions =
        deno_core::serde_json::from_str(&format!(
            r#"{{"shouldCompile":true,"enableReanimated":false,"isDev":true,"filename":{:?},"compilationMode":"infer"}}"#,
            specifier.path()
        ))
        .ok()?;
    let result = react_compiler_swc::transform_source(&stripped, options);
    let module = result.module?;
    Some(react_compiler_swc::emit(&module))
}

fn transpile_source(
    specifier: &ModuleSpecifier,
    source: String,
) -> Result<String, ModuleLoaderError> {
    // React Compiler pre-pass (no-op unless JUNE_REACT_COMPILER=1).
    let (source, media_override) = match maybe_react_compile(specifier, &source) {
        Some(compiled) => (compiled, Some(MediaType::Jsx)), // types already stripped
        None => (source, None),
    };
    let media_type = media_override.unwrap_or_else(|| MediaType::from_specifier(specifier));
    let parsed = deno_ast::parse_module(ParseParams {
        specifier: specifier.clone(),
        text: source.into(),
        media_type,
        capture_tokens: false,
        scope_analysis: false,
        maybe_syntax: None,
    })
    .map_err(|e| ModuleLoaderError::generic(format!("parse {specifier}: {e}")))?;

    let options = TranspileOptions {
        jsx: Some(JsxRuntime::Automatic(JsxAutomaticOptions {
            development: false,
            import_source: Some("react".to_string()),
        })),
        ..Default::default()
    };
    let result = parsed
        .transpile(&options, &TranspileModuleOptions::default(), &EmitOptions::default())
        .map_err(|e| ModuleLoaderError::generic(format!("transpile {specifier}: {e}")))?;
    Ok(result.into_source().text)
}

// ---- dev: un-bundled client module serving + Fast Refresh ----

/// Load the dep pre-bundle manifest (npm specifier -> served /@june/deps URL).
fn load_deps_manifest(cwd: &Path) -> HashMap<String, String> {
    let path = cwd.join("runtime/dist/deps/manifest.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let re = Regex::new(r#""([^"]+)"\s*:\s*"([^"]+)""#).unwrap();
    re.captures_iter(&text)
        .map(|c| (c[1].to_string(), c[2].to_string()))
        .collect()
}

/// Collapse `.`/`..` in a path without touching the filesystem.
fn normalize_rel(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Rewrite a client module's import specifiers for the browser: react-family and
/// pre-bundled npm -> their /@june/deps URL; relative app imports -> /@june/client
/// URLs. Bare specifiers we didn't pre-bundle are left as-is.
fn rewrite_client_imports(code: &str, module_rel: &str, deps: &HashMap<String, String>) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(from\s*|import\s*)(["'])([^"']+)(["'])"#).unwrap());
    let dir = Path::new(module_rel).parent().unwrap_or_else(|| Path::new(""));
    re.replace_all(code, |caps: &regex::Captures| {
        let (kw, q, spec) = (&caps[1], &caps[2], &caps[3]);
        let mapped = if let Some(url) = deps.get(spec) {
            url.clone()
        } else if spec.starts_with('.') {
            format!("/@june/client/{}", normalize_rel(&dir.join(spec)).to_string_lossy())
        } else {
            spec.to_string()
        };
        format!("{kw}{q}{mapped}{q}")
    })
    .into_owned()
}

/// Fast Refresh footer: register each component-like (capitalized) export under a
/// stable family id, so an edit can `performReactRefresh()` it. The `typeof` guard
/// keeps re-exported (non-local) names from throwing.
fn refresh_footer(module_rel: &str, exports: &[String]) -> String {
    let mut regs = String::new();
    for name in exports {
        if name == "default" || !name.chars().next().is_some_and(|c| c.is_uppercase()) {
            continue;
        }
        let id = format!("{module_rel} {name}");
        regs.push_str(&format!(
            "  if (typeof {name} !== \"undefined\") window.$RefreshReg$({name}, {id:?});\n"
        ));
    }
    if regs.is_empty() {
        return String::new();
    }
    format!("\nif (typeof window !== \"undefined\" && window.$RefreshReg$) {{\n{regs}}}\n")
}

#[derive(Clone, Default)]
struct RenderOutput(Rc<RefCell<Option<String>>>);
#[derive(Clone, Default)]
struct FlightOutput(Rc<RefCell<Option<String>>>);
#[derive(Clone, Default)]
struct StylesOutput(Rc<RefCell<Option<String>>>);

#[op2(fast)]
fn op_set_html(state: &mut OpState, #[string] html: String) {
    let out = state.borrow::<RenderOutput>().clone();
    *out.0.borrow_mut() = Some(html);
}

#[op2(fast)]
fn op_set_flight(state: &mut OpState, #[string] flight: String) {
    let out = state.borrow::<FlightOutput>().clone();
    *out.0.borrow_mut() = Some(flight);
}

#[op2(fast)]
fn op_set_styles(state: &mut OpState, #[string] styles: String) {
    let out = state.borrow::<StylesOutput>().clone();
    *out.0.borrow_mut() = Some(styles);
}

/// Fill a byte buffer from the OS CSPRNG — the backbone of `crypto.getRandomValues`
/// (deno_web ships no crypto). Not a hot path: a few small buffers per render, the
/// cost is the OS getrandom call, so Rust here is about correctness, not speed.
#[op2(fast)]
fn op_get_random_values(#[buffer] buf: &mut [u8]) {
    let _ = getrandom::fill(buf);
}

deno_core::extension!(
    june_ext,
    deps = [deno_webidl, deno_web, deno_fetch],
    ops = [op_set_html, op_set_flight, op_set_styles, op_get_random_values],
);

// Lean shim for the one deno_net script deno_fetch's JS imports at eval time
// (`ext:deno_net/02_tls.js`, for client-cert HTTP clients we don't use). Provides
// a no-op loadTlsKeyPair so real fetch works without the heavy deno_net crate.
// See src/netshim/02_tls.js.
deno_core::extension!(
    deno_net,
    lazy_loaded_js = [dir "src/netshim", "02_tls.js"],
);

// The Web-globals bootstrap. On deno_core 0.403 / deno_web 0.281 the Web-API
// modules are lazy_loaded_js (no longer statically importable as ext: ESM), so
// web_entry.js is a classic script that pulls them with Deno.core.loadExtScript
// and assigns the globals. Run once per isolate, before the app graph loads.
const WEB_ENTRY: &str = include_str!("../web_entry.js");

// V8 startup snapshot (build.rs): the Web globals pre-baked into the heap.
// JUNE_NO_SNAPSHOT=1 falls back to evaluating web_entry.js (for A/B timing).
static APPLOADER_SNAPSHOT: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/APPLOADER_SNAPSHOT.bin"));

fn use_snapshot() -> bool {
    std::env::var("JUNE_NO_SNAPSHOT").map(|v| v != "1").unwrap_or(true)
}

/// Escape a string as a JS string literal (safe to inline in <script>).
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"), // avoid closing the <script>
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Stable content id for a CSS file, so the SSR-injected and client-injected
/// `<style>` for the same CSS dedup to the same `data-june-css`.
fn css_id(css: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    css.hash(&mut h);
    format!("c{:x}", h.finish())
}

/// Turn a `.css` file into a JS module: during SSR it registers the CSS for head
/// injection (collected -> no FOUC); on the client it injects a deduped `<style>`.
/// For `.module.css`, class names are scoped (`.box` -> `.box_<id>`) and the
/// name->scoped map is the default export (CSS modules).
fn css_module_js(rel: &str, css: &str) -> String {
    let id = css_id(css);
    let (inject_css, default_export) = if rel.ends_with(".module.css") {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| Regex::new(r"\.(-?[A-Za-z_][A-Za-z0-9_-]*)").unwrap());
        let mut map: Vec<(String, String)> = Vec::new();
        let scoped = re
            .replace_all(css, |c: &regex::Captures| {
                let name = c[1].to_string();
                let scoped = format!("{name}_{id}");
                map.push((name, scoped.clone()));
                format!(".{scoped}")
            })
            .into_owned();
        let mut seen: HashMap<String, String> = HashMap::new();
        for (n, s) in map {
            seen.entry(n).or_insert(s);
        }
        let entries: Vec<String> = seen.iter().map(|(k, v)| format!("{k:?}:{v:?}")).collect();
        (scoped, format!("export default {{{}}};\n", entries.join(",")))
    } else {
        (css.to_string(), "export {};\n".to_string())
    };
    let css_lit = js_string(&inject_css);
    format!(
        "const __css={css_lit};const __id={id:?};\
         if(globalThis.__JUNE_ADD_CSS__){{globalThis.__JUNE_ADD_CSS__(__id,__css);}}\
         else if(typeof document!==\"undefined\"&&!document.querySelector('style[data-june-css=\"'+__id+'\"]')){{\
         const s=document.createElement('style');s.setAttribute('data-june-css',__id);s.textContent=__css;document.head.appendChild(s);}}\n\
         {default_export}"
    )
}

/// Wrap the SSR'd #root in a full document: inline the Flight for hydration and
/// load the browser bundle. In dev, also inline the Fast Refresh runtime setup +
/// the un-bundled webpack shim BEFORE the client bundle (so React wires into the
/// refresh hook and the Flight client sees `__webpack_require__`).
fn document(inner_html: &str, flight: &str, dev: bool, client_map: &str, import_map: &str, styles: &str) -> String {
    // An import map lets the browser resolve bare specifiers in the pre-bundled dep
    // files (e.g. zustand's `import "react"`) to the single shared /@june/deps copy.
    let importmap = if dev {
        format!("<script type=\"importmap\">{{\"imports\":{import_map}}}</script>")
    } else {
        String::new()
    };
    let (dev_flag, refresh_setup) = if dev {
        (
            "window.__JUNE_DEV__=true;window.process=window.process||{env:{NODE_ENV:\"development\"},platform:\"browser\",browser:true,version:\"\",versions:{},argv:[],nextTick:function(f){queueMicrotask(f)},cwd:function(){return\"/\"}};",
            format!(
                "<script type=\"module\">\
                 import * as RR from \"/@june/deps/react-refresh__runtime.js\";\
                 RR.injectIntoGlobalHook(window);\
                 window.$RefreshReg$=(t,id)=>RR.register(t,id);\
                 window.$RefreshSig$=RR.createSignatureFunctionForTransform;\
                 window.__JUNE_REFRESH__=RR;\
                 const MAP={client_map};\
                 const loaded=window.__JUNE_LOADED__={{}};\
                 const req=(id)=>loaded[id];req.u=(id)=>MAP[id]||id;\
                 window.__webpack_require__=req;\
                 window.__webpack_get_script_filename__=(id)=>MAP[id]||id;\
                 window.__webpack_chunk_load__=async(id)=>{{loaded[id]=await import(MAP[id]||id);}};\
                 </script>"
            ),
        )
    } else {
        ("", String::new())
    };
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>June</title>{importmap}{styles}</head>\
         <body>{inner_html}\
         <script>{dev_flag}window.__FLIGHT__={};</script>\
         {refresh_setup}\
         <script type=\"module\" src=\"/client.js\"></script></body></html>",
        js_string(flight)
    )
}

/// Build the dev import map (bare specifier -> /@june/deps URL) from the pre-bundle
/// manifest, so the browser resolves bare imports in the pre-bundled dep files.
fn build_import_map(deps: &HashMap<String, String>) -> String {
    let mut entries: Vec<String> = deps.iter().map(|(k, v)| format!("{k:?}:{v:?}")).collect();
    entries.sort();
    format!("{{{}}}", entries.join(","))
}

fn is_react_specifier(s: &str) -> bool {
    // react/compiler-runtime is NOT vendor-resolved: the vendors don't export
    // it. It ships as a regular pre-bundled dep (react stays external inside
    // it → still the single React instance), so SSR resolves it via the deps
    // map and the browser via the import map. Emitted by the React Compiler.
    if s == "react/compiler-runtime" {
        return false;
    }
    s == "react"
        || s.starts_with("react/")
        || s.starts_with("react-dom")
        || s.starts_with("react-server-dom-webpack")
}

/// True if a module's first real statement is a `"use client"` directive.
fn is_use_client(spec: &ModuleSpecifier) -> bool {
    let Ok(path) = spec.to_file_path() else {
        return false;
    };
    let Ok(source) = std::fs::read_to_string(&path) else {
        return false;
    };
    for line in source.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") {
            continue;
        }
        return t.starts_with("\"use client\"") || t.starts_with("'use client'");
    }
    false
}

/// True if a file on disk begins with a `"use client"` directive (for the HMR
/// watcher, which classifies a change as client-bundle vs server-only).
fn file_is_use_client(path: &Path) -> bool {
    let Ok(source) = std::fs::read_to_string(path) else {
        return false;
    };
    source_directive(&source) == Some("use client")
}

/// Export names of a module (good-enough scan for `export function/const/class`,
/// `export default`, and `export { ... }`).
fn extract_exports(source: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in source.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("export ") {
            if rest.starts_with("default") {
                names.push("default".to_string());
            } else if let Some(after) = rest
                .strip_prefix("function ")
                .or_else(|| rest.strip_prefix("async function "))
                .or_else(|| rest.strip_prefix("const "))
                .or_else(|| rest.strip_prefix("let "))
                .or_else(|| rest.strip_prefix("var "))
                .or_else(|| rest.strip_prefix("class "))
            {
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                    .collect();
                if !name.is_empty() {
                    names.push(name);
                }
            } else if let Some(inner) = rest.strip_prefix("{").and_then(|r| r.split('}').next()) {
                for part in inner.split(',') {
                    let exported = part.split(" as ").last().unwrap_or(part).trim();
                    if !exported.is_empty() {
                        names.push(exported.to_string());
                    }
                }
            }
        }
    }
    names
}

/// The directive of a module (first real statement), if any.
fn source_directive(source: &str) -> Option<&'static str> {
    for line in source.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") {
            continue;
        }
        if t.starts_with("\"use client\"") || t.starts_with("'use client'") {
            return Some("use client");
        }
        if t.starts_with("\"use server\"") || t.starts_with("'use server'") {
            return Some("use server");
        }
        return None;
    }
    None
}

/// Appended to a `"use server"` module: register each export as a server
/// reference (mutates the exported function in place) and add it to the dispatch
/// registry. id = export name.
fn server_action_appendix(exports: &[String]) -> String {
    let mut s = String::from(
        "\n;import { registerServerReference as __june_rsr } from \"react-server-dom-webpack/server.edge\";\nglobalThis.__ACTIONS__ = globalThis.__ACTIONS__ || {};\n",
    );
    for name in exports {
        if name == "default" {
            continue;
        }
        s.push_str(&format!(
            "__june_rsr({name}, {name:?}, null); globalThis.__ACTIONS__[{name:?}] = {name};\n"
        ));
    }
    s
}

/// The server-graph stub for a `"use client"` module: a client reference per
/// export (the bundler normally generates this). id = export name.
fn client_ref_stub(exports: &[String]) -> String {
    let mut s = String::from(
        "import { registerClientReference } from \"react-server-dom-webpack/server.edge\";\n",
    );
    for name in exports {
        let lhs = if name == "default" {
            "export default ".to_string()
        } else {
            format!("export const {name} = ")
        };
        s.push_str(&format!(
            "{lhs}registerClientReference(() => {{ throw new Error(\"client reference\"); }}, \"{name}\", \"{name}\");\n"
        ));
    }
    s
}

/// Resolves react-family imports to the react-server OR client vendor depending
/// on which graph the importing module is in; delegates other loads to the fs.
/// Graph membership propagates from a module to everything it imports, seeded
/// from the two entry points.
struct JuneLoader {
    fs: FsModuleLoader,
    vendor_server: ModuleSpecifier,
    vendor_client: ModuleSpecifier,
    // file fallbacks for the june://vendor/* virtual specifiers (used when the
    // module isn't already in the snapshot's module map)
    vendor_server_file: ModuleSpecifier,
    vendor_client_file: ModuleSpecifier,
    server_graph: RefCell<HashSet<String>>,
    client_graph: RefCell<HashSet<String>>,
    /// bare npm specifier -> pre-bundled dep file (so SSR of a "use client"
    /// component that imports npm resolves the same Bun pre-bundle the browser
    /// uses). react-family is excluded (it resolves to the vendors above).
    deps: HashMap<String, ModuleSpecifier>,
}

impl JuneLoader {
    fn new(
        vendor_server: ModuleSpecifier,
        vendor_client: ModuleSpecifier,
        vendor_server_file: ModuleSpecifier,
        vendor_client_file: ModuleSpecifier,
        deps: HashMap<String, ModuleSpecifier>,
    ) -> Self {
        Self {
            fs: FsModuleLoader,
            vendor_server,
            vendor_client,
            vendor_server_file,
            vendor_client_file,
            server_graph: RefCell::new(HashSet::new()),
            client_graph: RefCell::new(HashSet::new()),
            deps,
        }
    }
}

impl ModuleLoader for JuneLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        kind: ResolutionKind,
    ) -> Result<ModuleSpecifier, ModuleLoaderError> {
        let is_client = self.client_graph.borrow().contains(referrer);

        if is_react_specifier(specifier) {
            return Ok(if is_client {
                self.vendor_client.clone()
            } else {
                self.vendor_server.clone()
            });
        }

        // A bare npm specifier (not relative/absolute/scheme) resolves to its
        // pre-bundled dep file — server-side reuse of the Bun pre-bundle. Propagate
        // graph membership so a React-importing dep (e.g. zustand) resolves its own
        // `import "react"` to the right vendor (client graph -> vendor_client).
        if !specifier.starts_with('.') && !specifier.starts_with('/') && !specifier.contains(':') {
            if let Some(dep) = self.deps.get(specifier) {
                if is_client {
                    self.client_graph.borrow_mut().insert(dep.to_string());
                } else {
                    self.server_graph.borrow_mut().insert(dep.to_string());
                }
                return Ok(dep.clone());
            }
        }

        let mut resolved = self.fs.resolve(specifier, referrer, kind)?;

        // A server-graph import of a "use client" module becomes a client
        // REFERENCE, not the real module. Mark it with ?clientref so it gets a
        // distinct module-map entry from the real module (which the client graph
        // loads), and load() serves the generated reference stub.
        if !is_client && is_use_client(&resolved) {
            resolved.set_query(Some("clientref"));
            return Ok(resolved);
        }

        // The imported module inherits the referrer's graph.
        if is_client {
            self.client_graph.borrow_mut().insert(resolved.to_string());
        } else {
            self.server_graph.borrow_mut().insert(resolved.to_string());
        }
        Ok(resolved)
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        maybe_referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        // A ?clientref specifier: serve the generated client-reference stub.
        if module_specifier.query() == Some("clientref") {
            let mut real = module_specifier.clone();
            real.set_query(None);
            let response = (|| {
                let path = real
                    .to_file_path()
                    .map_err(|_| ModuleLoaderError::generic(format!("{real} is not a file URL")))?;
                let source = std::fs::read_to_string(&path)
                    .map_err(|e| ModuleLoaderError::generic(format!("read {real}: {e}")))?;
                let stub = client_ref_stub(&extract_exports(&source));
                Ok(ModuleSource::new(
                    ModuleType::JavaScript,
                    ModuleSourceCode::String(stub.into()),
                    module_specifier,
                    None,
                ))
            })();
            return ModuleLoadResponse::Sync(response);
        }

        let spec = module_specifier.clone();
        // Virtual vendor modules: normally pre-instantiated by the V8 snapshot's
        // module map (never loaded); this read is the no-snapshot fallback. The
        // module REGISTERS under the requested june:// specifier (`spec`) — only
        // the disk read uses the backing file path.
        let read_spec = if spec.scheme() == "june" {
            if spec == self.vendor_client {
                self.vendor_client_file.clone()
            } else {
                self.vendor_server_file.clone()
            }
        } else {
            spec.clone()
        };
        let response = (|| {
            let path = read_spec
                .to_file_path()
                .map_err(|_| ModuleLoaderError::generic(format!("{read_spec} is not a file URL")))?;
            let _ = &read_spec;
            let source = std::fs::read_to_string(&path)
                .map_err(|e| ModuleLoaderError::generic(format!("read {spec}: {e}")))?;

            // `.css` import -> a JS module that registers/injects the CSS.
            if spec.path().ends_with(".css") {
                return Ok(ModuleSource::new(
                    ModuleType::JavaScript,
                    ModuleSourceCode::String(css_module_js(spec.path(), &source).into()),
                    &spec,
                    None,
                ));
            }

            let media_type = MediaType::from_specifier(&spec);
            let needs_transpile = matches!(
                media_type,
                MediaType::TypeScript | MediaType::Tsx | MediaType::Jsx | MediaType::Mts
            );
            let mut code = if needs_transpile {
                transpile_source(&spec, source.clone())?
            } else {
                source.clone()
            };

            // "use server": auto-register exports as server references.
            if source_directive(&source) == Some("use server") {
                code.push_str(&server_action_appendix(&extract_exports(&source)));
            }

            Ok(ModuleSource::new(
                ModuleType::JavaScript,
                ModuleSourceCode::String(code.into()),
                &spec,
                None,
            ))
        })();
        ModuleLoadResponse::Sync(response)
    }
}

/// File-based router: pathname -> (page.tsx file, params). Exact dir match, else
/// a `[param]` dir captures the segment. `/` -> app/page.tsx.
fn match_route(app_dir: &Path, pathname: &str) -> Option<(PathBuf, HashMap<String, String>)> {
    let segments: Vec<&str> = pathname.split('/').filter(|s| !s.is_empty()).collect();
    let mut dir = app_dir.to_path_buf();
    let mut params = HashMap::new();
    for seg in segments {
        let exact = dir.join(seg);
        if exact.is_dir() {
            dir = exact;
            continue;
        }
        let dyn_entry = std::fs::read_dir(&dir).ok()?.filter_map(|e| e.ok()).find(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with('[') && name.ends_with(']') && e.path().is_dir()
        })?;
        let name = dyn_entry.file_name().to_string_lossy().to_string();
        let param = name.trim_start_matches('[').trim_end_matches(']').to_string();
        params.insert(param, seg.to_string());
        dir = dyn_entry.path();
    }
    let page = dir.join("page.tsx");
    page.is_file().then_some((page, params))
}

fn params_to_js(params: &HashMap<String, String>) -> String {
    let entries: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{k:?}:{v:?}"))
        .collect();
    format!("{{{}}}", entries.join(","))
}

/// Renders a route, returning (flight, inner_html). The Flight is captured for
/// inlining into the document so the browser can hydrate.
async fn render_route(
    runtime: &mut JsRuntime,
    route_url: &str,
    params_js: &str,
) -> anyhow::Result<(String, String, String)> {
    let op_state = runtime.op_state();
    let (html_sink, flight_sink, styles_sink) = {
        let state = op_state.borrow();
        (
            state.borrow::<RenderOutput>().clone(),
            state.borrow::<FlightOutput>().clone(),
            state.borrow::<StylesOutput>().clone(),
        )
    };
    *html_sink.0.borrow_mut() = None;
    *flight_sink.0.borrow_mut() = None;
    *styles_sink.0.borrow_mut() = None;

    // Reset the CSS-in-JS style collector before render, capture it after — so
    // emotion/styled-components styles inserted during SSR end up in the document.
    let src = format!(
        "globalThis.__JUNE_RESET_STYLES__ && globalThis.__JUNE_RESET_STYLES__(); \
         globalThis.__renderFlight({route_url:?}, {params_js}).then((f) => {{ Deno.core.ops.op_set_flight(f); return globalThis.__renderHtml(f); }}).then((h) => {{ Deno.core.ops.op_set_html(h); if (globalThis.__JUNE_COLLECT_STYLES__) Deno.core.ops.op_set_styles(globalThis.__JUNE_COLLECT_STYLES__()); }})"
    );
    let promise = runtime
        .execute_script("render.js", src)
        .map_err(|e| anyhow!("execute render: {e}"))?;
    #[allow(deprecated)]
    runtime
        .resolve_value(promise)
        .await
        .map_err(|e| anyhow!("resolve render: {e}"))?;

    let html = html_sink.0.borrow_mut().take().ok_or_else(|| anyhow!("no HTML"))?;
    let flight = flight_sink.0.borrow_mut().take().ok_or_else(|| anyhow!("no Flight"))?;
    let styles = styles_sink.0.borrow_mut().take().unwrap_or_default();
    Ok((flight, html, styles))
}

fn build_runtime(loader: Rc<JuneLoader>) -> JsRuntime {
    let extensions = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false, // enable_css_parser_features (new in deno_web 0.281)
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        // Real WHATWG fetch. op_fetch reads a PermissionsContainer from OpState
        // (installed below); Options::default() is a plain rustls HTTPS client.
        deno_fetch::deno_fetch::init(deno_fetch::Options::default()),
        deno_net::init(), // registers the ext:deno_net/02_tls.js stub fetch needs
        june_ext::init(),
    ];
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(loader),
        extensions,
        startup_snapshot: use_snapshot().then_some(APPLOADER_SNAPSHOT),
        ..Default::default()
    });
    {
        let op_state = runtime.op_state();
        let mut state = op_state.borrow_mut();
        state.put(RenderOutput::default());
        state.put(FlightOutput::default());
        state.put(StylesOutput::default());
        // SSRF posture (PoC/dev): allow-all net for the SSR isolate -- the
        // framework, not arbitrary user input, decides what server components
        // fetch. allow_all short-circuits check_net_url before the parser runs;
        // the parser is only here to satisfy the constructor. Production hardening
        // (internal-IP denylist / configurable allowlist) swaps this one line.
        let parser = Arc::new(RuntimePermissionDescriptorParser::new(
            sys_traits::impls::RealSys,
        ));
        state.put(PermissionsContainer::allow_all(parser));
    }
    runtime
}

async fn load_and_evaluate(
    runtime: &mut JsRuntime,
    specifier: &ModuleSpecifier,
) -> anyhow::Result<()> {
    let id = runtime
        .load_side_es_module(specifier)
        .await
        .map_err(|e| anyhow!("load {specifier}: {e}"))?;
    let eval = runtime.mod_evaluate(id);
    runtime
        .run_event_loop(deno_core::PollEventLoopOptions::default())
        .await
        .map_err(|e| anyhow!("event loop {specifier}: {e}"))?;
    eval.await.map_err(|e| anyhow!("evaluate {specifier}: {e}"))?;
    Ok(())
}

/// Build a loader-backed runtime and install the render functions. Each worker
/// thread owns one (V8 isolates are !Send).
async fn setup_runtime(cwd: &Path) -> anyhow::Result<JsRuntime> {
    let vendor_server_file = deno_core::resolve_path("runtime/dist/vendor-server.mjs", cwd)?;
    let vendor_client_file = deno_core::resolve_path("runtime/dist/vendor-client.mjs", cwd)?;
    // Virtual specifiers — MUST match build.rs so the snapshot module map hits.
    let vendor_server = ModuleSpecifier::parse("june://vendor/server.mjs").unwrap();
    let vendor_client = ModuleSpecifier::parse("june://vendor/client.mjs").unwrap();
    let entry_server = deno_core::resolve_path("runtime/app/entry-server.mjs", cwd)?;
    let entry_ssr = deno_core::resolve_path("runtime/app/entry-ssr.mjs", cwd)?;

    // Map each pre-bundled npm specifier to its dist/deps file (skip react-family
    // — that resolves to the vendors). manifest URL /@june/deps/<f> -> the file.
    let mut deps = HashMap::new();
    for (spec, url) in load_deps_manifest(cwd) {
        if is_react_specifier(&spec) {
            continue;
        }
        if let Some(file) = url.strip_prefix("/@june/deps/") {
            if let Ok(dep) = deno_core::resolve_path(&format!("runtime/dist/deps/{file}"), cwd) {
                deps.insert(spec, dep);
            }
        }
    }

    let loader = Rc::new(JuneLoader::new(vendor_server, vendor_client, vendor_server_file, vendor_client_file, deps));
    loader.server_graph.borrow_mut().insert(entry_server.to_string());
    loader.client_graph.borrow_mut().insert(entry_ssr.to_string());

    let t0 = std::time::Instant::now();
    let mut runtime = build_runtime(loader);
    let t_rt = t0.elapsed();
    // Web globals: pre-baked by the snapshot; the eval below is the
    // no-snapshot fallback only.
    if !use_snapshot() {
        runtime
            .execute_script("web_entry.js", WEB_ENTRY)
            .map_err(|e| anyhow!("bootstrap web globals: {e}"))?;
    }
    let t_globals = t0.elapsed();
    load_and_evaluate(&mut runtime, &entry_server).await?;
    let t_server = t0.elapsed();
    load_and_evaluate(&mut runtime, &entry_ssr).await?;
    eprintln!(
        "[boot] isolate {:?} | globals +{:?} | server graph +{:?} | ssr graph +{:?} | total {:?}",
        t_rt, t_globals - t_rt, t_server - t_globals, t0.elapsed() - t_server, t0.elapsed()
    );
    Ok(runtime)
}

struct RenderResult {
    flight: String,
    html: String,
    styles: String,
}

enum Job {
    Render {
        route_url: String,
        params_js: String,
        respond: oneshot::Sender<Result<RenderResult, String>>,
    },
    Dispatch {
        action_id: String,
        body: String,
        respond: oneshot::Sender<Result<String, String>>,
    },
}

/// Runs a server action by id (with the encoded reply body) and returns the
/// result encoded as Flight.
async fn dispatch_action(
    runtime: &mut JsRuntime,
    action_id: &str,
    body: &str,
) -> anyhow::Result<String> {
    let op_state = runtime.op_state();
    let flight_sink = op_state.borrow().borrow::<FlightOutput>().clone();
    *flight_sink.0.borrow_mut() = None;
    let src = format!(
        "globalThis.__dispatchAction({action_id:?}, {body:?}).then((f) => Deno.core.ops.op_set_flight(f))"
    );
    let promise = runtime
        .execute_script("dispatch.js", src)
        .map_err(|e| anyhow!("execute dispatch: {e}"))?;
    #[allow(deprecated)]
    runtime
        .resolve_value(promise)
        .await
        .map_err(|e| anyhow!("resolve dispatch: {e}"))?;
    let result = flight_sink.0.borrow_mut().take();
    result.ok_or_else(|| anyhow!("action produced no result"))
}

#[derive(Clone)]
struct AppState {
    jobs: Sender<Job>,
    app_dir: PathBuf,
    client_js: Arc<String>,
    /// Recently rendered routes (path, route_url, params_js), most-recent first,
    /// capped — the watcher re-renders these on a server edit and PUSHES the
    /// fresh Flight over /__june/hmr (no notify-then-refetch round trip).
    active: Arc<std::sync::Mutex<Vec<(String, String, String)>>>,
    dev: bool,
    /// Bumped by the file watcher; the document inlines `__JUNE_DEV__` and the
    /// browser subscribes to `/__june/hmr`. Carries `rsc-update`, `full-reload`,
    /// or `module-update:<rel>` (Fast Refresh a single client module).
    hmr_tx: broadcast::Sender<String>,
    /// npm specifier -> /@june/deps URL (from the Bun pre-bundle manifest).
    deps_manifest: Arc<HashMap<String, String>>,
    /// runtime/dist/deps, served at /@june/deps/*.
    deps_dir: PathBuf,
    /// JS object literal: client component export name -> /@june/client URL, for
    /// the dev webpack shim to import un-bundled modules during hydration. Rebuilt
    /// by the watcher when a client module is added/removed.
    client_map: Arc<RwLock<String>>,
    /// Import map imports object (bare specifier -> /@june/deps URL) for the browser.
    import_map: Arc<String>,
    /// (丙) PoC: the live driver broadcasts re-rendered Flight for the /live route
    /// here; the browser's /__june/live WebSocket forwards it to clients.
    live_tx: broadcast::Sender<String>,
}

/// Serve a pre-bundled npm dep (or its sourcemap) from runtime/dist/deps.
async fn deps_handler(State(state): State<AppState>, UrlPath(path): UrlPath<String>) -> Response {
    if path.contains("..") {
        return (StatusCode::FORBIDDEN, "no").into_response();
    }
    match std::fs::read(state.deps_dir.join(&path)) {
        Ok(bytes) => {
            let ct = if path.ends_with(".map") {
                "application/json"
            } else {
                "text/javascript; charset=utf-8"
            };
            ([("content-type", ct)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "dep not found").into_response(),
    }
}

/// Serve an app client module UN-BUNDLED: transpile TSX, rewrite imports to
/// /@june/deps + /@june/client URLs, and (for "use client" modules) append the
/// Fast Refresh registration footer.
async fn client_module_handler(
    State(state): State<AppState>,
    UrlPath(path): UrlPath<String>,
) -> Response {
    if path.contains("..") {
        return (StatusCode::FORBIDDEN, "no").into_response();
    }
    let file = state.app_dir.join(&path);
    let Ok(source) = std::fs::read_to_string(&file) else {
        return (StatusCode::NOT_FOUND, "module not found").into_response();
    };
    // `.css` import -> a JS module that injects a deduped <style> on the client.
    if path.ends_with(".css") {
        return ([("content-type", "text/javascript; charset=utf-8")], css_module_js(&path, &source)).into_response();
    }
    let Ok(spec) = ModuleSpecifier::from_file_path(&file) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "bad path").into_response();
    };
    let media = MediaType::from_specifier(&spec);
    let needs_transpile = matches!(
        media,
        MediaType::TypeScript | MediaType::Tsx | MediaType::Jsx | MediaType::Mts
    );
    let mut code = if needs_transpile {
        match transpile_source(&spec, source.clone()) {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("transpile: {e}")).into_response(),
        }
    } else {
        source.clone()
    };
    code = rewrite_client_imports(&code, &path, &state.deps_manifest);
    if source_directive(&source) == Some("use client") {
        code.push_str(&refresh_footer(&path, &extract_exports(&source)));
    }
    ([("content-type", "text/javascript; charset=utf-8")], code).into_response()
}

fn spawn_worker(jobs: Receiver<Job>, cwd: PathBuf, epoch: Arc<AtomicU64>) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("worker tokio runtime");
        // Held in an Option so a dev rebuild can DROP the old isolate before
        // building the new one — two live V8 isolates on one thread panics.
        let mut runtime = Some(rt.block_on(setup_runtime(&cwd)).expect("setup runtime"));
        let mut local_epoch = epoch.load(Ordering::Relaxed);
        for job in jobs.iter() {
            // Dev HMR: if a file changed since this isolate was built, rebuild it
            // from a fresh module map so the new code (server components, actions)
            // is picked up. A fresh isolate sidesteps deno_core's module cache.
            let current = epoch.load(Ordering::Relaxed);
            if current != local_epoch {
                runtime = None; // drop the old isolate first
                match rt.block_on(setup_runtime(&cwd)) {
                    Ok(fresh) => {
                        runtime = Some(fresh);
                        local_epoch = current;
                    }
                    Err(e) => {
                        eprintln!("[hmr] isolate rebuild failed: {e}");
                        runtime = Some(rt.block_on(setup_runtime(&cwd)).expect("rebuild fallback"));
                    }
                }
            }
            let rt_ref = runtime.as_mut().expect("worker runtime present");
            match job {
                Job::Render { route_url, params_js, respond } => {
                    let reply = rt
                        .block_on(render_route(rt_ref, &route_url, &params_js))
                        .map(|(flight, html, styles)| RenderResult { flight, html, styles })
                        .map_err(|e| e.to_string());
                    let _ = respond.send(reply);
                }
                Job::Dispatch { action_id, body, respond } => {
                    let reply = rt
                        .block_on(dispatch_action(rt_ref, &action_id, &body))
                        .map_err(|e| e.to_string());
                    let _ = respond.send(reply);
                }
            }
        }
    });
}

async fn client_js_handler(State(state): State<AppState>) -> impl IntoResponse {
    // Dev serves the un-bundled-capable dev client (React external -> /@june/deps,
    // Fast Refresh); prod serves the bundled client cached at startup.
    let body = if state.dev {
        std::fs::read_to_string("runtime/dist/dev-client.js")
            .unwrap_or_else(|_| (*state.client_js).clone())
    } else {
        (*state.client_js).clone()
    };
    ([("content-type", "text/javascript; charset=utf-8")], body)
}

/// Scan the app for "use client" modules and build a JS object literal mapping
/// each component export -> its /@june/client URL, for the dev webpack shim.
fn build_client_map(app_dir: &Path) -> String {
    fn collect(dir: &Path, app_dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_dir() {
                collect(&p, app_dir, out);
                continue;
            }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if !matches!(ext, "tsx" | "ts" | "jsx" | "mjs" | "mts") {
                continue;
            }
            let Ok(src) = std::fs::read_to_string(&p) else {
                continue;
            };
            if source_directive(&src) != Some("use client") {
                continue;
            }
            let Ok(rel) = p.strip_prefix(app_dir) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let url = format!("/@june/client/{rel}");
            for name in extract_exports(&src) {
                if name != "default" && name.chars().next().is_some_and(|c| c.is_uppercase()) {
                    out.push(format!("{name:?}:{url:?}"));
                }
            }
        }
    }
    let mut out = Vec::new();
    collect(app_dir, app_dir, &mut out);
    format!("{{{}}}", out.join(","))
}

/// HMR channel: the browser opens an EventSource here; the watcher broadcasts
/// `rsc-update` (refetch Flight, partial update) or `full-reload`. This endpoint
/// + those two message kinds are the stable HMR contract a future
/// `@june/vite-plugin` drives instead of the built-in watcher.
async fn hmr_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.hmr_tx.subscribe()).filter_map(|msg| match msg {
        Ok(kind) => Some(Ok(Event::default().event("change").data::<String>(kind))),
        Err(_) => None, // a lagged receiver just misses a tick
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// (丙) server-reactive live RSC: the browser opens this WebSocket; we forward
// every re-rendered Flight the live driver broadcasts. The dev client calls
// navigate(<that Flight>) so React reconciles in place (sibling state preserved).
async fn live_ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| live_ws_client(socket, state.live_tx.subscribe()))
        .into_response()
}

async fn live_ws_client(mut socket: WebSocket, mut rx: broadcast::Receiver<String>) {
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(flight) => {
                    if socket.send(Message::Text(flight)).await.is_err() { break; }
                }
                Err(_) => break,
            },
            client = socket.recv() => {
                if client.is_none() { break; } // client closed; ignore inbound
            }
        }
    }
}

// (丙) SSE transport: the SAME re-rendered Flight, pushed one-directionally over
// Server-Sent Events. Lighter than WebSocket for pure server->client live display
// (plain HTTP, auto-reconnect, no upgrade) -- reserve WS for when the client also
// needs to talk back (agent control-planes). Mirrors the HMR SSE handler.
async fn live_sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.live_tx.subscribe()).filter_map(|msg| match msg {
        Ok(flight) => Some(Ok(Event::default().event("flight").data::<String>(flight))),
        Err(_) => None, // a lagged receiver just misses a frame
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// (丙) live driver: every interval, bump a server tick, render the /live route's
/// Flight WITH that tick (passed as a route param), and broadcast it. Stands in
/// for "server data changed" (a real system fires this on a DATA MUTATION).
fn spawn_live_driver(
    jobs: Sender<Job>,
    route_url: String,
    live_tx: broadcast::Sender<String>,
    interval_ms: u64,
) {
    tokio::spawn(async move {
        let mut tick: u64 = 1;
        loop {
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            if live_tx.receiver_count() == 0 {
                continue; // nobody watching; don't burn renders
            }
            let (tx, rx) = oneshot::channel();
            let job = Job::Render {
                route_url: route_url.clone(),
                params_js: format!("{{\"tick\":{tick}}}"),
                respond: tx,
            };
            if jobs.send(job).is_err() {
                break;
            }
            if let Ok(Ok(result)) = rx.await {
                let _ = live_tx.send(result.flight);
            }
            tick += 1;
        }
    });
}

async fn action_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let action_id = headers
        .get("x-june-action")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if action_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing x-june-action").into_response();
    }
    let (tx, rx) = oneshot::channel();
    let job = Job::Dispatch {
        action_id,
        body,
        respond: tx,
    };
    if state.jobs.send(job).is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE, "worker pool gone").into_response();
    }
    match rx.await {
        Ok(Ok(flight)) => (
            [("content-type", "text/x-component; charset=utf-8")],
            flight,
        )
            .into_response(),
        Ok(Err(e)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("action error: {e}")).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "no response").into_response(),
    }
}

async fn handle(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Response {
    let Some((file, params)) = match_route(&state.app_dir, uri.path()) else {
        return (StatusCode::NOT_FOUND, Html("<h1>404 - no route</h1>".to_string())).into_response();
    };
    let Ok(route_url) = ModuleSpecifier::from_file_path(&file) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "bad route path").into_response();
    };
    let (tx, rx) = oneshot::channel();
    let job = Job::Render {
        route_url: route_url.to_string(),
        params_js: params_to_js(&params),
        respond: tx,
    };
    if state.jobs.send(job).is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE, "worker pool gone").into_response();
    }
    match rx.await {
        Ok(Ok(result)) => {
            {
                let mut active = state.active.lock().unwrap();
                let path = uri.path().to_string();
                active.retain(|(p, _, _)| p != &path);
                active.insert(0, (path, route_url.to_string(), params_to_js(&params)));
                active.truncate(3);
            }
            // Client navigation asks for the Flight payload; first load wants the
            // full document.
            let wants_rsc = headers
                .get(axum::http::header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|a| a.contains("text/x-component"));
            if wants_rsc {
                (
                    [("content-type", "text/x-component; charset=utf-8")],
                    result.flight,
                )
                    .into_response()
            } else {
                let cm = state.client_map.read().unwrap();
                Html(document(
                    &result.html,
                    &result.flight,
                    state.dev,
                    cm.as_str(),
                    &state.import_map,
                    &result.styles,
                ))
                .into_response()
            }
        }
        Ok(Err(e)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("render error: {e}")).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "no response").into_response(),
    }
}

/// True if a path is an app source file the watcher should react to. The
/// generated `_client-manifest.ts` is excluded — build.ts rewrites it, which
/// would otherwise loop the watcher.
fn is_watched_source(path: &Path) -> bool {
    if path
        .file_name()
        .is_some_and(|n| n == "_client-manifest.ts" || n == "_client-manifest-ssr.ts")
    {
        return false;
    }
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("tsx" | "ts" | "jsx" | "mjs" | "mts")
    )
}

/// Dev file watcher: on a change under `app_dir`, bump the epoch (so worker
/// isolates rebuild) and broadcast to browsers. A `"use client"` edit also
/// re-runs build.ts (rebuilds client.js + the manifest) and asks for a full
/// reload; a server-only edit asks for a Flight refetch (partial update).
fn run_watcher(
    app_dir: PathBuf,
    cwd: PathBuf,
    epoch: Arc<AtomicU64>,
    hmr_tx: broadcast::Sender<String>,
    client_map: Arc<RwLock<String>>,
    jobs: Sender<Job>,
    active: Arc<std::sync::Mutex<Vec<(String, String, String)>>>,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    // PollWatcher (mtime polling) rather than the OS backend: on macOS FSEvents
    // delivers editor saves unreliably; a 300ms poll is deterministic and plenty
    // fast for dev HMR.
    // compare_contents: hash-based change detection — mtime comparison misses
    // same-second consecutive saves. The app dir is small; hashing every 15ms
    // is negligible and makes detection deterministic.
    let config = Config::default()
        .with_poll_interval(Duration::from_millis(15))
        .with_compare_contents(true);
    let mut watcher = match PollWatcher::new(
        move |res| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
        config,
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[hmr] watcher init failed, HMR disabled: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&app_dir, RecursiveMode::Recursive) {
        eprintln!("[hmr] watch {} failed, HMR disabled: {e}", app_dir.display());
        return;
    }
    eprintln!("[hmr] watching {} for changes", app_dir.display());

    while let Ok(first) = rx.recv() {
        // Coalesce the burst of events an editor save produces.
        let mut events = vec![first];
        while let Ok(ev) = rx.recv_timeout(Duration::from_millis(10)) {
            events.push(ev);
        }
        let changed: Vec<PathBuf> = events
            .into_iter()
            .flat_map(|e| e.paths)
            .filter(|p| is_watched_source(p))
            .collect();
        if changed.is_empty() {
            continue;
        }
        epoch.fetch_add(1, Ordering::Relaxed);

        // Client modules are served un-bundled from /@june/client, so an edit
        // needs no rebuild — Fast Refresh re-imports just that module. Compute the
        // app-relative path for each changed "use client" file.
        let client_changes: Vec<String> = changed
            .iter()
            .filter(|p| file_is_use_client(p))
            .filter_map(|p| p.strip_prefix(&app_dir).ok())
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .collect();

        if !client_changes.is_empty() {
            // An edit may introduce a new npm import; refresh the dep pre-bundle
            // (cached, so a no-op when the dep set is unchanged).
            let _ = std::process::Command::new("bun")
                .arg("runtime/dev/prebundle-deps.ts")
                .current_dir(&cwd)
                .status();

            // If the SET of client components changed (added/removed/renamed),
            // regenerate _client-manifest.ts (so SSR resolves the new reference)
            // and full-reload so the new document carries the updated client map.
            // A plain edit (same set) Fast Refreshes in place.
            let new_map = build_client_map(&app_dir);
            let set_changed = *client_map.read().unwrap() != new_map;
            if set_changed {
                eprintln!("[hmr] client module set changed -> regen manifest + reload");
                let _ = std::process::Command::new("bun")
                    .arg("runtime/dev/gen-client-manifest.ts")
                    .current_dir(&cwd)
                    .status();
                *client_map.write().unwrap() = new_map;
                let _ = hmr_tx.send("full-reload".to_string());
            } else {
                for rel in &client_changes {
                    eprintln!("[hmr] client module changed -> Fast Refresh {rel}");
                    let _ = hmr_tx.send(format!("module-update:{rel}"));
                }
            }
        } else {
            // HMR = live-RSC: re-render the active route(s) on the (already
            // epoch-bumped) fresh isolate and PUSH the Flight — the browser
            // applies it directly; no refetch round trip. The trailing
            // rsc-update covers routes we did not push.
            let t0 = std::time::Instant::now();
            let routes = active.lock().unwrap().clone();
            for (path, route_url, params_js) in routes {
                let (rtx, rrx) = oneshot::channel();
                let job = Job::Render {
                    route_url: route_url.clone(),
                    params_js: params_js.clone(),
                    respond: rtx,
                };
                if jobs.send(job).is_err() {
                    break;
                }
                if let Ok(Ok(res)) = rrx.blocking_recv() {
                    let msg = deno_core::serde_json::json!({ "path": path, "flight": res.flight });
                    let _ = hmr_tx.send(format!("rsc-flight:{msg}"));
                    let wall = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis();
                    eprintln!(
                        "[hmr] pushed flight for {path} {:?} after detection (wall {wall})",
                        t0.elapsed()
                    );
                }
            }
            let _ = hmr_tx.send("rsc-update".to_string());
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let t_main = std::time::Instant::now();
    let cwd = std::env::current_dir()?;
    let app_dir = cwd.join("runtime/app");
    let pool: usize = std::env::var("POOL").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3200);
    // apploader is the dev runtime, so HMR is on by default; JUNE_DEV=0 disables.
    let dev = std::env::var("JUNE_DEV").map(|v| v != "0").unwrap_or(true);

    let client_js = Arc::new(
        std::fs::read_to_string("runtime/dist/client.js")
            .map_err(|e| anyhow!("read client.js (run: bun runtime/build.ts): {e}"))?,
    );

    // Dev: regenerate _client-manifest (picks up modules added while stopped) and
    // pre-bundle npm deps (dev React for Fast Refresh) before serving. Both are
    // single Bun calls; the pre-bundle is cached on input hash.
    if dev {
        // LISTEN-EARLY: these two refresh dev artifacts that already exist from
        // the previous run; they must not block the first request. They run in
        // the background; the watcher picks up any changes they produce.
        let cwd2 = cwd.clone();
        std::thread::spawn(move || {
            for script in ["runtime/dev/gen-client-manifest.ts", "runtime/dev/prebundle-deps.ts"] {
                match std::process::Command::new("bun").arg(script).current_dir(&cwd2).status() {
                    Ok(s) if s.success() => {}
                    Ok(s) => eprintln!("[dev] {script} exited with {s}"),
                    Err(e) => eprintln!("[dev] could not run {script} (need bun): {e}"),
                }
            }
        });
    }
    let deps_manifest = Arc::new(load_deps_manifest(&cwd));
    let deps_dir = cwd.join("runtime/dist/deps");
    let import_map = Arc::new(build_import_map(&deps_manifest));

    let (tx, rx) = bounded::<Job>(1024);
    let epoch = Arc::new(AtomicU64::new(0));
    for _ in 0..pool {
        spawn_worker(rx.clone(), cwd.clone(), epoch.clone());
    }

    let client_map = Arc::new(RwLock::new(build_client_map(&app_dir)));
    let active: Arc<std::sync::Mutex<Vec<(String, String, String)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));

    let (hmr_tx, _) = broadcast::channel::<String>(16);
    if dev {
        let (app_dir, cwd, epoch, hmr_tx, client_map, jobs, active) = (
            app_dir.clone(),
            cwd.clone(),
            epoch.clone(),
            hmr_tx.clone(),
            client_map.clone(),
            tx.clone(),
            active.clone(),
        );
        std::thread::spawn(move || run_watcher(app_dir, cwd, epoch, hmr_tx, client_map, jobs, active));
    }

    // (丙) live-RSC driver: re-render the configured route's Flight on a timer and
    // broadcast it to /__june/live (WS) + /__june/live-sse clients. LIVE_ROUTE
    // (default "live") + LIVE_MS (default 2000) select the demo route + cadence;
    // the agent control-plane demo uses LIVE_ROUTE=agent LIVE_MS=400.
    let (live_tx, _) = broadcast::channel::<String>(16);
    let live_route_rel = std::env::var("LIVE_ROUTE").unwrap_or_else(|_| "live".to_string());
    let live_ms: u64 = std::env::var("LIVE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(2000);
    if let Ok(live_route) =
        ModuleSpecifier::from_file_path(app_dir.join(format!("{live_route_rel}/page.tsx")))
    {
        spawn_live_driver(tx.clone(), live_route.to_string(), live_tx.clone(), live_ms);
    }

    let app = Router::new()
        .route("/client.js", axum::routing::get(client_js_handler))
        .route("/__june/action", axum::routing::post(action_handler))
        .route("/__june/hmr", axum::routing::get(hmr_handler))
        .route("/__june/live", axum::routing::get(live_ws_handler))
        .route("/__june/live-sse", axum::routing::get(live_sse_handler))
        .route("/@june/deps/*path", axum::routing::get(deps_handler))
        .route("/@june/client/*path", axum::routing::get(client_module_handler))
        .fallback(handle)
        .with_state(AppState {
            jobs: tx,
            app_dir,
            client_js,
            dev,
            hmr_tx,
            deps_manifest,
            deps_dir,
            client_map,
            import_map,
            live_tx,
            active,
        });
    eprintln!("[boot] main -> pre-bind {:?}", t_main.elapsed());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("[boot] main -> listening {:?}", t_main.elapsed());
    let hmr = if dev { " + HMR" } else { "" };
    println!("[apploader] file-routed RSC server (pool={pool}{hmr}) on http://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
