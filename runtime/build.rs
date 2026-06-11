// Builds a V8 startup snapshot at compile time that bakes into the heap:
//   1. the evaluated Web globals (deno_web + deno_fetch), and
//   2. the two React bundles (server + ssr), already parsed and with
//      __renderFlight / __renderHtml installed on globalThis.
//
// On deno_core 0.403 the Web-API modules are lazy_loaded_js (sync IIFEs), so the
// globals are installed by EXECUTING web_entry.js (a classic loadExtScript
// bootstrap) into the snapshot runtime -- NOT via an esm_entry_point. Because
// loadExtScript is synchronous (no top-level await), snapshot creation accepts
// it: this is exactly what unblocks the bundled snapshot on 0.403.
//
// The extension set (names, ops, order) MUST match src/main.rs's so op indices
// line up against the snapshot. Op bodies are irrelevant here (never called
// during snapshot creation) -- only their declarations matter.

use std::path::PathBuf;
use std::sync::Arc;

use deno_core::{op2, JsRuntimeForSnapshot, OpState, RuntimeOptions};

#[op2(fast)]
fn op_set_html(_state: &mut OpState, #[string] _html: String) {}

#[op2(fast)]
fn op_push_chunk(_state: &mut OpState, #[string] _chunk: String) {}

#[op2(fast)]
fn op_get_random_values(#[buffer] _buf: &mut [u8]) {}

deno_core::extension!(
    june_ext,
    deps = [deno_webidl, deno_web, deno_fetch],
    ops = [op_set_html, op_push_chunk, op_get_random_values],
);

// --- apploader snapshot: SAME extension names but the APPLOADER's op set -----
#[op2(fast)]
fn ap_op_set_html(_state: &mut OpState, #[string] _html: String) {}
#[op2(fast)]
fn ap_op_set_flight(_state: &mut OpState, #[string] _flight: String) {}
#[op2(fast)]
fn ap_op_set_styles(_state: &mut OpState, #[string] _styles: String) {}
#[op2(fast)]
fn ap_op_get_random_values(#[buffer] _buf: &mut [u8]) {}

mod apploader_ext {
    use super::*;
    deno_core::extension!(
        june_ext,
        deps = [deno_webidl, deno_web, deno_fetch],
        ops = [
            super::ap_op_set_html,
            super::ap_op_set_flight,
            super::ap_op_set_styles,
            super::ap_op_get_random_values
        ],
    );
    deno_core::extension!(
        deno_net,
        lazy_loaded_js = [dir "src/netshim", "02_tls.js"],
    );
}

deno_core::extension!(
    deno_net,
    lazy_loaded_js = [dir "src/netshim", "02_tls.js"],
);

fn main() {
    println!("cargo:rerun-if-changed=src/web_entry.js");
    println!("cargo:rerun-if-changed=src/netshim/02_tls.js");
    println!("cargo:rerun-if-changed=dist/server.js");
    println!("cargo:rerun-if-changed=dist/ssr.js");

    let web_entry = std::fs::read_to_string("src/web_entry.js").expect("src/web_entry.js missing");
    let server = std::fs::read_to_string("dist/server.js")
        .expect("dist/server.js missing (run: bun runtime/build.ts)");
    let ssr = std::fs::read_to_string("dist/ssr.js")
        .expect("dist/ssr.js missing (run: bun runtime/build.ts)");

    let extensions = vec![
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
    ];

    let mut runtime = JsRuntimeForSnapshot::new(RuntimeOptions {
        extensions,
        ..Default::default()
    });

    // Install the Web globals (sync loadExtScript bootstrap), then bake the React
    // bundles -- all into the snapshot heap.
    runtime
        .execute_script("web_entry.js", web_entry)
        .expect("evaluate web_entry bootstrap for snapshot");
    runtime
        .execute_script("server.js", server)
        .expect("evaluate server bundle for snapshot");
    runtime
        .execute_script("ssr.js", ssr)
        .expect("evaluate ssr bundle for snapshot");

    let snapshot = runtime.snapshot();

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("RUNTIME_SNAPSHOT.bin");
    std::fs::write(&out, &snapshot).expect("write snapshot");
    println!("cargo:warning=june snapshot: {} KB", snapshot.len() / 1024);

    // --- apploader snapshot: Web globals ONLY (the ES-module app graph loads on
    // top at runtime; React vendors move in here once the module map is
    // snapshotted too). Extension names/order match the apploader's runtime set.
    let web_entry2 =
        std::fs::read_to_string("src/web_entry.js").expect("src/web_entry.js missing");
    let extensions2 = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            deno_web::InMemoryBroadcastChannel::default(),
        ),
        deno_fetch::deno_fetch::init(deno_fetch::Options::default()),
        apploader_ext::deno_net::init(),
        apploader_ext::june_ext::init(),
    ];
    // React vendor bundles (self-contained ESM) load under VIRTUAL specifiers so
    // the snapshot's module map matches what the apploader's loader resolves at
    // runtime — machine-independent, no baked absolute paths.
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // Self-contained in the monorepo: vendors read from THIS crate's dist/ (the
    // PoC reference read a sibling ../runtime/dist of the old 0.380 track).
    let vendor_server_src = std::fs::read_to_string(manifest.join("dist/vendor-server.mjs"))
        .expect("dist/vendor-server.mjs missing (run: bun runtime/build.ts)");
    let vendor_client_src = std::fs::read_to_string(manifest.join("dist/vendor-client.mjs"))
        .expect("dist/vendor-client.mjs missing (run: bun runtime/build.ts)");
    println!("cargo:rerun-if-changed=dist/vendor-server.mjs");
    println!("cargo:rerun-if-changed=dist/vendor-client.mjs");
    let server_url = deno_core::ModuleSpecifier::parse("june://vendor/server.mjs").unwrap();
    let client_url = deno_core::ModuleSpecifier::parse("june://vendor/client.mjs").unwrap();
    let loader = std::rc::Rc::new(deno_core::StaticModuleLoader::new([
        (server_url.clone(), vendor_server_src),
        (client_url.clone(), vendor_client_src),
    ]));

    let mut runtime2 = JsRuntimeForSnapshot::new(RuntimeOptions {
        extensions: extensions2,
        module_loader: Some(loader),
        ..Default::default()
    });
    runtime2
        .execute_script("web_entry.js", web_entry2)
        .expect("evaluate web_entry bootstrap for apploader snapshot");
    deno_core::futures::executor::block_on(async {
        for url in [&server_url, &client_url] {
            let id = runtime2.load_side_es_module(url).await.expect("load vendor for snapshot");
            let eval = runtime2.mod_evaluate(id);
            runtime2
                .run_event_loop(deno_core::PollEventLoopOptions::default())
                .await
                .expect("event loop for vendor snapshot");
            eval.await.expect("evaluate vendor for snapshot");
        }
    });
    let snapshot2 = runtime2.snapshot();
    let out2 = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("APPLOADER_SNAPSHOT.bin");
    std::fs::write(&out2, &snapshot2).expect("write apploader snapshot");
    println!("cargo:warning=apploader snapshot: {} KB", snapshot2.len() / 1024);
}
