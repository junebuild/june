// June runtime PoC — single-process RSC SSR on V8 embedded in Rust (deno_core),
// fronted by an HTTP server with a pool of isolate-owning worker threads.
//
// One JsRuntime hosts BOTH React module graphs in ONE process:
//   - server bundle (react-server condition) -> Flight        : __renderFlight()
//   - ssr bundle    (no condition)           -> HTML from Flight: __renderHtml(f)
//
// V8 isolates are single-threaded and !Send, so each worker thread owns its own
// JsRuntime. axum spreads requests across the pool via an MPMC channel. This
// gives parallel render (POOL > 1) which Bun's single JS thread can't do, while
// POOL=1 is the apples-to-apples single-thread comparison.

use std::cell::RefCell;
use std::convert::Infallible;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll};

use anyhow::anyhow;
use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use crossbeam_channel::{bounded, Receiver, Sender};
use deno_core::{op2, JsRuntime, OpState, RuntimeOptions};
use deno_permissions::{PermissionsContainer, RuntimePermissionDescriptorParser};
use futures_core::Stream;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Default)]
struct RenderOutput(Rc<RefCell<Option<String>>>);

type Chunk = Result<Vec<u8>, Infallible>;
type ChunkSender = mpsc::UnboundedSender<Chunk>;

#[derive(Clone, Default)]
struct StreamOutput(Rc<RefCell<Option<ChunkSender>>>);

struct ChunkStream {
    rx: mpsc::UnboundedReceiver<Chunk>,
}

impl Stream for ChunkStream {
    type Item = Chunk;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

#[op2(fast)]
fn op_set_html(state: &mut OpState, #[string] html: String) {
    let out = state.borrow::<RenderOutput>().clone();
    *out.0.borrow_mut() = Some(html);
}

#[op2(fast)]
fn op_push_chunk(state: &mut OpState, #[string] chunk: String) {
    let out = state.borrow::<StreamOutput>().clone();
    let tx = out.0.borrow().clone();
    if let Some(tx) = tx {
        let _ = tx.send(Ok(chunk.into_bytes()));
    }
}

/// Fill a byte buffer from the OS CSPRNG (crypto.getRandomValues backbone).
/// Referenced by web_entry.js; the bundled demo never calls it, but keep it so
/// the op set matches build.rs and crypto works if used.
#[op2(fast)]
fn op_get_random_values(#[buffer] buf: &mut [u8]) {
    let _ = getrandom::fill(buf);
}

// Must match build.rs's extension EXACTLY (name, ops, order) so op indices align
// against the snapshot. On 0.403 the Web globals come from running web_entry.js
// (a sync loadExtScript bootstrap) -- baked into the snapshot by build.rs, or run
// via execute_script in the no-snapshot/modules paths. No esm_entry_point.
deno_core::extension!(
    june_ext,
    deps = [deno_webidl, deno_web, deno_fetch],
    ops = [op_set_html, op_push_chunk, op_get_random_values],
);

// Lean shim for the one deno_net script deno_fetch's JS imports at eval time
// (ext:deno_net/02_tls.js). See src/netshim/02_tls.js.
deno_core::extension!(
    deno_net,
    lazy_loaded_js = [dir "src/netshim", "02_tls.js"],
);

// web_entry.js: the loadExtScript bootstrap that installs the Web globals
// (deno_web + deno_fetch). Run via execute_script when NOT starting from a
// snapshot (the snapshot already has these globals baked in).
const WEB_ENTRY: &str = include_str!("web_entry.js");

// V8 startup snapshot produced by build.rs: Web globals + React bundles baked
// into the heap.
static SNAPSHOT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/RUNTIME_SNAPSHOT.bin"));

/// Extensions shared by every build_runtime variant. Must match build.rs.
fn june_extensions() -> Vec<deno_core::Extension> {
    vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false, // enable_css_parser_features (new in deno_web 0.281)
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        deno_fetch::deno_fetch::init(deno_fetch::Options::default()),
        deno_net::init(),
        june_ext::init(),
    ]
}

fn install_runtime_state(runtime: &mut JsRuntime) {
    let op_state = runtime.op_state();
    let mut state = op_state.borrow_mut();
    state.put(RenderOutput::default());
    state.put(StreamOutput::default());
    // SSRF posture (PoC): allow-all net for the SSR isolate -- see apploader. The
    // bundled demo doesn't fetch, but install it so fetch works if used.
    let parser = Arc::new(RuntimePermissionDescriptorParser::new(
        sys_traits::impls::RealSys,
    ));
    state.put(PermissionsContainer::allow_all(parser));
}

fn build_runtime() -> JsRuntime {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: june_extensions(),
        startup_snapshot: Some(SNAPSHOT),
        ..Default::default()
    });
    install_runtime_state(&mut runtime);
    runtime
}

const SERVER_JS: &str = include_str!("../dist/server.js");
const SSR_JS: &str = include_str!("../dist/ssr.js");

// Cold-start comparison path: no snapshot, so the Web globals are installed by
// running web_entry.js and the React bundles are parsed at boot.
fn build_runtime_no_snapshot() -> JsRuntime {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: june_extensions(),
        ..Default::default()
    });
    install_runtime_state(&mut runtime);
    runtime
        .execute_script("web_entry.js", WEB_ENTRY)
        .expect("bootstrap web globals");
    runtime
        .execute_script("server.js", SERVER_JS)
        .expect("load server bundle");
    runtime
        .execute_script("ssr.js", SSR_JS)
        .expect("load ssr bundle");
    runtime
}

// MODULES=1 path: load the React bundles as real ES modules through deno_core's
// ModuleLoader instead of iife execute_script. This is the foundation for a real
// runtime (per-route module loading, resolution, transpile) — here it proves the
// loader integration end to end. No snapshot in this mode.
fn build_runtime_modules() -> JsRuntime {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(deno_core::FsModuleLoader)),
        extensions: june_extensions(),
        ..Default::default()
    });
    install_runtime_state(&mut runtime);
    runtime
        .execute_script("web_entry.js", WEB_ENTRY)
        .expect("bootstrap web globals");
    runtime
}

async fn load_module_bundles(runtime: &mut JsRuntime) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    for rel in ["runtime/dist/server.mjs", "runtime/dist/ssr.mjs"] {
        let specifier =
            deno_core::resolve_path(rel, &cwd).map_err(|e| anyhow!("resolve {rel}: {e}"))?;
        let id = runtime
            .load_side_es_module(&specifier)
            .await
            .map_err(|e| anyhow!("load {rel}: {e}"))?;
        let eval = runtime.mod_evaluate(id);
        runtime
            .run_event_loop(deno_core::PollEventLoopOptions::default())
            .await
            .map_err(|e| anyhow!("event loop {rel}: {e}"))?;
        eval.await.map_err(|e| anyhow!("evaluate {rel}: {e}"))?;
    }
    Ok(())
}

fn clear_render_output(runtime: &mut JsRuntime) {
    let out = runtime.op_state().borrow().borrow::<RenderOutput>().clone();
    *out.0.borrow_mut() = None;
}

fn take_render_output(runtime: &mut JsRuntime) -> Option<String> {
    let out = runtime.op_state().borrow().borrow::<RenderOutput>().clone();
    let value = out.0.borrow_mut().take();
    value
}

fn set_stream_output(runtime: &mut JsRuntime, tx: Option<ChunkSender>) {
    let out = runtime.op_state().borrow().borrow::<StreamOutput>().clone();
    *out.0.borrow_mut() = tx;
}

async fn render(runtime: &mut JsRuntime) -> anyhow::Result<String> {
    // Pipe the Flight ReadableStream straight from the server graph into the ssr
    // graph — no Flight string round-trip.
    clear_render_output(runtime);
    let src = "globalThis.__renderHtml(globalThis.__renderFlightStream())\
        .then((html) => Deno.core.ops.op_set_html(html))";
    let promise = runtime
        .execute_script("render.js", src)
        .map_err(|e| anyhow!("execute render: {e}"))?;
    #[allow(deprecated)]
    runtime
        .resolve_value(promise)
        .await
        .map_err(|e| anyhow!("resolve render: {e}"))?;
    take_render_output(runtime).ok_or_else(|| anyhow!("render produced no HTML"))
}

async fn render_flight(runtime: &mut JsRuntime) -> anyhow::Result<String> {
    clear_render_output(runtime);
    let src = r#"(async () => {
        const reader = globalThis.__renderFlightStream().getReader();
        const decoder = new TextDecoder();
        let out = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
        Deno.core.ops.op_set_html(out);
    })()"#;
    let promise = runtime
        .execute_script("flight.js", src)
        .map_err(|e| anyhow!("execute flight render: {e}"))?;
    #[allow(deprecated)]
    runtime
        .resolve_value(promise)
        .await
        .map_err(|e| anyhow!("resolve flight render: {e}"))?;
    take_render_output(runtime).ok_or_else(|| anyhow!("render produced no Flight payload"))
}

async fn render_html_stream(runtime: &mut JsRuntime, chunks: ChunkSender) -> anyhow::Result<()> {
    set_stream_output(runtime, Some(chunks));
    let src = r#"(async () => {
        const stream = await globalThis.__renderHtmlStream(globalThis.__renderFlightStream());
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) Deno.core.ops.op_push_chunk(chunk);
        }
        const tail = decoder.decode();
        if (tail) Deno.core.ops.op_push_chunk(tail);
    })()"#;
    let result = runtime
        .execute_script("html-stream.js", src)
        .map_err(|e| anyhow!("execute html stream render: {e}"));
    let result = match result {
        Ok(promise) =>
        {
            #[allow(deprecated)]
            runtime
                .resolve_value(promise)
                .await
                .map(|_| ())
                .map_err(|e| anyhow!("resolve html stream render: {e}"))
        }
        Err(e) => Err(e),
    };
    set_stream_output(runtime, None);
    result
}

enum Job {
    Html { respond: oneshot::Sender<String> },
    Flight { respond: oneshot::Sender<String> },
    HtmlStream { chunks: ChunkSender },
}

#[derive(Clone)]
struct AppState {
    jobs: Sender<Job>,
    cached_html: Arc<String>,
}

fn spawn_worker(jobs: Receiver<Job>) {
    let use_modules = std::env::var("MODULES").is_ok();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("worker tokio runtime");

        // Default: bundles + Web globals come from the startup snapshot (no
        // per-isolate re-parse). MODULES=1: load the bundles as real ES modules.
        let mut runtime = if use_modules {
            let mut r = build_runtime_modules();
            rt.block_on(load_module_bundles(&mut r))
                .expect("load module bundles");
            r
        } else {
            build_runtime()
        };

        for job in jobs.iter() {
            match job {
                Job::Html { respond } => {
                    let html = rt
                        .block_on(render(&mut runtime))
                        .unwrap_or_else(|e| format!("<!-- render error: {e} -->"));
                    let _ = respond.send(html);
                }
                Job::Flight { respond } => {
                    let flight = rt
                        .block_on(render_flight(&mut runtime))
                        .unwrap_or_else(|e| format!("<!-- flight render error: {e} -->"));
                    let _ = respond.send(flight);
                }
                Job::HtmlStream { chunks } => {
                    if let Err(e) = rt.block_on(render_html_stream(&mut runtime, chunks.clone())) {
                        let _ = chunks
                            .send(Ok(format!("<!-- stream render error: {e} -->").into_bytes()));
                    }
                }
            }
        }
    });
}

fn render_cached_html(use_modules: bool) -> String {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("cache tokio runtime");

        let mut runtime = if use_modules {
            let mut r = build_runtime_modules();
            rt.block_on(load_module_bundles(&mut r))
                .expect("load module bundles for cache");
            r
        } else {
            build_runtime()
        };

        rt.block_on(render(&mut runtime))
            .unwrap_or_else(|e| format!("<!-- cache render error: {e} -->"))
    })
    .join()
    .expect("cache render thread")
}

async fn handle(State(state): State<AppState>) -> Html<String> {
    let (tx, rx) = oneshot::channel();
    if state.jobs.send(Job::Html { respond: tx }).is_err() {
        return Html("<!-- worker pool gone -->".to_string());
    }
    Html(
        rx.await
            .unwrap_or_else(|_| "<!-- no response -->".to_string()),
    )
}

async fn flight_handle(State(state): State<AppState>) -> impl IntoResponse {
    let (tx, rx) = oneshot::channel();
    if state.jobs.send(Job::Flight { respond: tx }).is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "text/plain; charset=utf-8")],
            "worker pool gone".to_string(),
        );
    }
    (
        StatusCode::OK,
        [("content-type", "text/x-component; charset=utf-8")],
        rx.await
            .unwrap_or_else(|_| "<!-- no Flight response -->".to_string()),
    )
}

async fn html_stream_handle(State(state): State<AppState>) -> Response {
    let (tx, rx) = mpsc::unbounded_channel();
    if state.jobs.send(Job::HtmlStream { chunks: tx }).is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "text/plain; charset=utf-8")],
            "worker pool gone",
        )
            .into_response();
    }

    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from_stream(ChunkStream { rx }))
        .expect("valid streaming response")
}

async fn cached_handle(State(state): State<AppState>) -> Html<String> {
    Html((*state.cached_html).clone())
}

async fn text_handle() -> &'static str {
    "ok\n"
}

async fn json_handle() -> impl IntoResponse {
    (
        [("content-type", "application/json; charset=utf-8")],
        r#"{"ok":true,"framework":"june"}"#,
    )
}

async fn static_html_handle() -> Html<&'static str> {
    Html("<!doctype html><html><body><h1>June</h1></body></html>")
}

// Edge / scale-to-zero model: build a FRESH isolate per request (on its own
// thread, since JsRuntime is !Send), render once, drop it. The request pays the
// full cold start — which is exactly what the snapshot targets.
async fn cold_handle(State(no_snapshot): State<bool>) -> Html<String> {
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut runtime = if no_snapshot {
            build_runtime_no_snapshot()
        } else {
            build_runtime()
        };
        let html = rt.block_on(render(&mut runtime)).unwrap_or_default();
        let _ = tx.send(html);
    });
    Html(rx.await.unwrap_or_default())
}

// LIMITS=1: demonstrate V8-isolate resource limits — the isolation tier June
// uses for JS (RSC) tenant code, the counterpart to the WASM PoC in
// examples/sandbox. V8 has no deterministic "fuel" like WASM; the equivalents
// are wall-clock interruption (terminate_execution) and a heap-limit callback.
fn limits_probe() {
    use std::ffi::c_void;
    println!("V8 isolate resource limits (the JS default tier)\n");

    // CPU / wall-clock: a watchdog thread terminates a runaway loop.
    {
        let mut runtime = JsRuntime::new(RuntimeOptions::default());
        let handle = runtime.v8_isolate().thread_safe_handle();
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            handle.terminate_execution();
        });
        let t = std::time::Instant::now();
        let res = runtime.execute_script("cpu-bomb.js", "while (true) {}");
        let dt = t.elapsed();
        let _ = watchdog.join();
        match res {
            Err(_) => println!("  [PASS] CPU · wall-clock  — runaway loop terminated after {dt:?}"),
            Ok(_) => println!("  [FAIL] CPU · wall-clock  — loop returned without termination"),
        }
    }

    // Memory: cap the heap; a near-limit callback terminates the allocator
    // before it can exhaust host RAM.
    {
        extern "C" fn near_limit(data: *mut c_void, current: usize, _initial: usize) -> usize {
            // SAFETY: `data` points to a Box<IsolateHandle> leaked below, valid
            // until we reclaim it after the script returns.
            unsafe {
                (*(data as *const deno_core::v8::IsolateHandle)).terminate_execution();
            }
            // Grant slack so V8 unwinds and honors termination instead of
            // hard-aborting on OOM.
            current + 8 * 1024 * 1024
        }

        let max_heap = 24 * 1024 * 1024; // 24 MB cap
        let mut runtime = JsRuntime::new(RuntimeOptions {
            create_params: Some(deno_core::v8::CreateParams::default().heap_limits(0, max_heap)),
            ..Default::default()
        });
        let handle = Box::into_raw(Box::new(runtime.v8_isolate().thread_safe_handle()));
        runtime
            .v8_isolate()
            .add_near_heap_limit_callback(near_limit, handle as *mut c_void);

        let res = runtime.execute_script(
            "mem-bomb.js",
            "const a = []; for (;;) { a.push(new Array(200000).fill(7)); }",
        );
        match res {
            Err(_) => println!(
                "  [PASS] Memory · heap cap — allocator terminated at the {} MB limit",
                max_heap / 1024 / 1024
            ),
            Ok(_) => println!("  [FAIL] Memory · heap cap — allocation loop returned"),
        }
        // SAFETY: reclaim the leaked handle; runtime drops next.
        unsafe { drop(Box::from_raw(handle)) };
    }

    println!("\n✓ V8 isolate limits enforced (terminate_execution + heap-limit callback)");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Micro-bench: BENCH=1 isolates the per-request execute_script+event-loop
    // machinery cost from the actual React render work, to decide whether caching
    // a compiled function handle is worth it.
    if std::env::var("BENCH").is_ok() {
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let mut runtime = build_runtime();
            rt.block_on(async {
                const N: u32 = 2000;
                // warmup
                for _ in 0..100 {
                    let _ = render(&mut runtime).await;
                }
                // full render
                let t = std::time::Instant::now();
                for _ in 0..N {
                    render(&mut runtime).await.unwrap();
                }
                let per_render = t.elapsed().as_secs_f64() * 1e6 / N as f64;
                // Flight render only (render the server graph + drain the stream,
                // no react-dom SSR) — isolates the Flight half from the HTML half.
                let flight_src = "(async () => { const r = globalThis.__renderFlightStream().getReader(); for (;;) { const { done } = await r.read(); if (done) break; } })()";
                let t = std::time::Instant::now();
                for _ in 0..N {
                    let v = runtime.execute_script("flight.js", flight_src).unwrap();
                    #[allow(deprecated)]
                    runtime.resolve_value(v).await.unwrap();
                }
                let per_flight = t.elapsed().as_secs_f64() * 1e6 / N as f64;
                println!(
                    "per_flight_only={per_flight:.1}us  per_html_approx={:.1}us",
                    per_render - per_flight
                );
                // bare execute_script + event-loop drive (no React)
                let t = std::time::Instant::now();
                for _ in 0..N {
                    let v = runtime.execute_script("noop.js", "1").unwrap();
                    #[allow(deprecated)]
                    runtime.resolve_value(v).await.unwrap();
                }
                let per_noop = t.elapsed().as_secs_f64() * 1e6 / N as f64;
                println!(
                    "per_render={per_render:.1}us  per_noop_script={per_noop:.1}us  \
                     machinery_share={:.1}%",
                    per_noop / per_render * 100.0
                );
            });
        })
        .join()
        .unwrap();
        return Ok(());
    }

    // Resource-limit probe: LIMITS=1 shows V8-isolate CPU/memory limits, the JS
    // counterpart to the WASM sandbox PoC. Own thread (JsRuntime is !Send).
    if std::env::var("LIMITS").is_ok() {
        std::thread::spawn(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let _guard = rt.enter();
            limits_probe();
        })
        .join()
        .unwrap();
        return Ok(());
    }

    // Cold-start probe: PROBE=1 [NO_SNAPSHOT=1] times one isolate boot + first
    // render, then exits. Runs on its own thread (JsRuntime is !Send).
    if std::env::var("PROBE").is_ok() {
        let no_snapshot = std::env::var("NO_SNAPSHOT").is_ok();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let t0 = std::time::Instant::now();
            let mut runtime = if no_snapshot {
                build_runtime_no_snapshot()
            } else {
                build_runtime()
            };
            let boot = t0.elapsed();
            let t1 = std::time::Instant::now();
            let html = rt.block_on(render(&mut runtime)).unwrap();
            let first = t1.elapsed();
            println!(
                "snapshot={} isolate_boot={boot:?} first_render={first:?} html_len={}",
                !no_snapshot,
                html.len()
            );
        })
        .join()
        .unwrap();
        return Ok(());
    }

    let pool: usize = std::env::var("POOL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        });
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3080);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;

    // COLD=1 [NO_SNAPSHOT=1]: edge model — fresh isolate per request.
    if std::env::var("COLD").is_ok() {
        let no_snapshot = std::env::var("NO_SNAPSHOT").is_ok();
        let app = Router::new()
            .route("/", get(cold_handle))
            .route("/text", get(text_handle))
            .route("/json", get(json_handle))
            .route("/html", get(static_html_handle))
            .with_state(no_snapshot);
        println!(
            "[june-runtime] COLD mode (fresh isolate/request, snapshot={}) on http://127.0.0.1:{port}",
            !no_snapshot
        );
        axum::serve(listener, app).await?;
        return Ok(());
    }

    let (tx, rx) = bounded::<Job>(2048);
    for _ in 0..pool {
        spawn_worker(rx.clone());
    }
    let use_modules = std::env::var("MODULES").is_ok();
    let state = AppState {
        jobs: tx,
        cached_html: Arc::new(render_cached_html(use_modules)),
    };

    let app = Router::new()
        .route("/", get(handle))
        .route("/flight", get(flight_handle))
        .route("/html-stream", get(html_stream_handle))
        .route("/cached", get(cached_handle))
        .route("/text", get(text_handle))
        .route("/json", get(json_handle))
        .route("/html", get(static_html_handle))
        .with_state(state);
    println!("[june-runtime] pool={pool} listening on http://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
