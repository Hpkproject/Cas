/**
 * service-worker.js
 * -----------------------------------------------------------------------
 * One worker for the whole shell scope:
 *   1. cache the CAS shell so the launcher can cold-start offline,
 *   2. serve browser-native app routes from per-app Cache Storage buckets,
 *   3. stamp COOP/COEP headers onto same-origin responses.
 * -----------------------------------------------------------------------
 */

const SHELL_CACHE_NAME = "cas-shell-v1";
const SHELL_URL = "./index.html";
const APP_CACHE_PREFIX = "cas-app-";
const APP_CACHE_VERSION = "v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then((cache) => cache.add(SHELL_URL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((name) => !shouldKeepCache(name))
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === "GET") {
    event.respondWith(routeRequest(event.request, event.clientId));
    return;
  }

  event.respondWith(withCoiHeaders(event.request));
});

async function routeRequest(request, clientId) {
  const appResponse = await maybeAppResponse(request, clientId);
  if (appResponse) return appResponse;

  const url = new URL(request.url);
  const isShellRequest = request.mode === "navigate" || url.pathname.endsWith("/index.html");
  if (isShellRequest) return shellResponse(request);

  return withCoiHeaders(request);
}

async function maybeAppResponse(request, clientId) {
  const resolved = await resolveAppRequest(request, clientId);
  if (!resolved) return null;

  const cache = await caches.open(appCacheName(resolved.appId));
  const cached = await cache.match(resolved.canonicalRequest, { ignoreSearch: true });
  const response = cached || (await cache.match(appRequestUrl(resolved.appId, "index.html"), { ignoreSearch: true }));
  if (!response) {
    return new Response("App asset not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return stampCoiHeaders(response);
}

async function resolveAppRequest(request, clientId) {
  const url = new URL(request.url);
  const direct = parseAppPath(url.pathname);
  if (direct) {
    return {
      appId: direct.appId,
      canonicalRequest: new Request(appRequestUrl(direct.appId, direct.relativePath + url.search), { method: "GET" }),
    };
  }

  if (!clientId) return null;
  const client = await self.clients.get(clientId);
  if (!client) return null;

  const clientApp = parseAppPath(new URL(client.url).pathname);
  if (!clientApp) return null;

  if (!shouldTreatAsAppRequest(url.pathname)) return null;

  return {
    appId: clientApp.appId,
    canonicalRequest: new Request(appRequestUrl(clientApp.appId, normalizeAppRelativePath(url.pathname) + url.search), {
      method: "GET",
    }),
  };
}

function parseAppPath(pathname) {
  const match = pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const appId = match[1];
  const relativePath = normalizeAppRelativePath(match[2] || "/index.html");
  return { appId, relativePath };
}

function shouldTreatAsAppRequest(pathname) {
  return pathname.startsWith("/") && pathname !== "/index.html" ? true : pathname === "/" || pathname.startsWith("/assets/") || pathname === "/icon.png" || pathname.endsWith(".html") || pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".json") || pathname.endsWith(".png") || pathname.endsWith(".jpg") || pathname.endsWith(".jpeg") || pathname.endsWith(".gif") || pathname.endsWith(".svg") || pathname.endsWith(".webp") || pathname.endsWith(".ico") || pathname.endsWith(".txt") || pathname.endsWith(".xml") || pathname.endsWith(".woff") || pathname.endsWith(".woff2") || pathname.endsWith(".mp3") || pathname.endsWith(".mp4") || pathname.endsWith(".webm") || pathname.endsWith(".pdf") || pathname.endsWith(".wasm");
}

function normalizeAppRelativePath(pathname) {
  if (!pathname || pathname === "/") return "index.html";
  return pathname.replace(/^\/+/, "");
}

function appRequestUrl(appId, relativePath) {
  const cleaned = String(relativePath).replace(/^\/+/, "");
  return `${self.location.origin}/apps/${appId}/${cleaned}`;
}

function appCacheName(appId) {
  return `${APP_CACHE_PREFIX}${appId}-${APP_CACHE_VERSION}`;
}

function shouldKeepCache(name) {
  return name === SHELL_CACHE_NAME || /^cas-app-.+-v1$/.test(name);
}

async function shellResponse(request) {
  try {
    const network = await fetch(request);
    if (network.ok) {
      const cache = await caches.open(SHELL_CACHE_NAME);
      await cache.put(SHELL_URL, network.clone());
    }
    return stampCoiHeaders(network);
  } catch (err) {
    const cached = await caches.match(SHELL_URL);
    if (cached) return stampCoiHeaders(cached);
    throw err;
  }
}

async function withCoiHeaders(request) {
  return stampCoiHeaders(await fetch(request));
}

function stampCoiHeaders(response) {
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
