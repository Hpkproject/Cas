/**
 * service-worker.js
 * -----------------------------------------------------------------------
 * Two jobs, kept in one worker deliberately (a scope can only be
 * controlled by one active service worker at a time, so the
 * header-injection logic coi-serviceworker.js needs can't live in a
 * second, separately-registered file at the same scope):
 *
 *   1. Shell caching: caches ONLY the CAS shell's index.html so the
 *      launcher can cold-start offline. Guest apps run inside their own
 *      WebContainer-served origin and are never touched by this worker.
 *   2. Cross-Origin-Isolation: stamps COOP/COEP response headers onto
 *      every same-origin response, which is what makes
 *      window.crossOriginIsolated true — required for WebContainer.boot().
 *      coi-serviceworker.js (loaded first, in index.html's <head>) is
 *      just the bootstrap that registers this worker and reloads once.
 * -----------------------------------------------------------------------
 */

const CACHE_NAME = "cas-shell-v1";
const SHELL_URL = "./index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellRequest =
    event.request.mode === "navigate" || url.pathname.endsWith("/index.html");

  if (isShellRequest) {
    event.respondWith(
      caches.match(SHELL_URL).then((cached) => cached || withCoiHeaders(event.request))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(withCoiHeaders(event.request));
  }
  // Cross-origin requests (WebContainer's own preview origin, etc.) pass through untouched.
});

/** Re-issues a same-origin response with COOP/COEP headers stamped on. */
async function withCoiHeaders(request) {
  const response = await fetch(request);
  if (response.status === 0) return response; // opaque response — nothing we can add headers to
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
