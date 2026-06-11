// Lean stub for `ext:deno_net/02_tls.js`.
//
// deno_fetch's 22_http_client.js imports `loadTlsKeyPair` from here at module
// eval time, and 23_request.js (which fetch needs) pulls 22_http_client in turn.
// But `loadTlsKeyPair` is ONLY invoked inside `Deno.createHttpClient()` for
// client-certificate auth -- which June does not use. Plain `fetch()` runs
// through op_fetch (hyper + rustls, in Rust) and never calls it.
//
// So this no-op stub satisfies the eval-time import and keeps real WHATWG fetch
// working WITHOUT pulling the heavy deno_net crate (TCP/UDP/QUIC/unix/TLS, +many
// crates). If client-cert HTTP clients are ever needed, swap this for the real
// deno_net extension. ASCII only.
(function () {
  function loadTlsKeyPair() {
    throw new TypeError(
      "client TLS key pairs (Deno.createHttpClient cert/key) are not supported in this runtime"
    );
  }
  return { loadTlsKeyPair };
})();
