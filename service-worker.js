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
 *
 * The headers must be stamped on the *cached* shell too, not just on
 * network responses. A cache hit that answers the navigation without
 * COOP/COEP leaves the document non-isolated, which makes the bootstrap
 * reload on every single load — an endless reload loop that also
 * discards any pending File Handling API launch (double-clicked .hpk).
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
    event.respondWith(shellResponse(event.request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(withCoiHeaders(event.request));
  }
  // Cross-origin requests (WebContainer's own preview origin, etc.) pass through untouched.
});

/**
 * Network-first for the shell so the cached copy can be refreshed, with
 * the cache as the offline fallback. Either way the response handed to
 * the page carries the isolation headers.
 */
async function shellResponse(request) {
  try {
    const network = await fetch(request);
    if (network.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(SHELL_URL, network.clone());
    }
    return stampCoiHeaders(network);
  } catch (err) {
    const cached = await caches.match(SHELL_URL);
    if (cached) return stampCoiHeaders(cached);
    throw err;
  }
}

/** Fetches a same-origin request and re-issues it with COOP/COEP stamped on. */
async function withCoiHeaders(request) {
  return stampCoiHeaders(await fetch(request));
}

/** Re-issues an existing response with COOP/COEP stamped on. */
function stampCoiHeaders(response) {
  // Opaque responses have no readable headers or body to copy.
  if (response.type === "opaque" || response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
