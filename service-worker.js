/**
 * service-worker.js
 * -----------------------------------------------------------------------
 * One worker for the whole shell scope:
 *   1. cache the CAS shell so the launcher can cold-start offline,
 *   2. serve browser-native app routes from per-app Cache Storage buckets,
 *   3. stamp COOP/COEP headers onto same-origin responses.
 * -----------------------------------------------------------------------
 */

const SHELL_CACHE_NAME = "cas-shell-v2";
const APP_CACHE_PREFIX = "cas-app-";
const APP_CACHE_VERSION = "v2";
const BASE_PATH = new URL("./", self.location.href).pathname.replace(/\/$/, "");
const SHELL_URL = `${BASE_PATH}/index.html`;
const APP_URL_PREFIX = `${BASE_PATH}/apps`;
const SHELL_ASSETS = [
  "index.html",
  "app.js",
  "launcher.js",
  "shell.js",
  "fs-manager.js",
  "hpk-installer.js",
  "plugin-installer.js",
  "permissions.js",
  "bw-manager.js",
  "run-on-login.js",
  "settings-app.js",
  "pending-launch.js",
  "offline-runtime.js",
  "cas-perms-client.js",
  "cas-perms-bridge.js",
  "storage-sync.js",
  "update-checker.js",
  "uninstall.js",
  "coi-serviceworker.js",
  "theme.css",
  "m3-theme.css",
  "icons/CAS-96.png",
  "icons/CAS-192.png",
  "icons/CAS-512.png",
  "icons/Hpk-96.png",
].map((path) => `${BASE_PATH}/${path}`);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
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

  return shellAssetResponse(request);
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
  const escapedPrefix = APP_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^${escapedPrefix}/([^/]+)(/.*)?$`));
  if (!match) return null;
  const appId = match[1];
  const relativePath = normalizeAppRelativePath(match[2] || "/index.html");
  return { appId, relativePath };
}

function shouldTreatAsAppRequest(pathname) {
  const relativePath = pathname.startsWith(BASE_PATH)
    ? pathname.slice(BASE_PATH.length) || "/"
    : pathname;
  return relativePath === "/" ||
    relativePath === "/icon.png" ||
    relativePath.startsWith("/assets/") ||
    /\.(html?|js|css|json|png|jpe?g|gif|svg|webp|ico|txt|xml|woff2?|mp3|mp4|webm|pdf|wasm)$/.test(relativePath);
}

function normalizeAppRelativePath(pathname) {
  if (!pathname || pathname === "/") return "index.html";
  return pathname.replace(/^\/+/, "");
}

function appRequestUrl(appId, relativePath) {
  const cleaned = String(relativePath).replace(/^\/+/, "");
  return `${self.location.origin}${APP_URL_PREFIX}/${appId}/${cleaned}`;
}

function appCacheName(appId) {
  return `${APP_CACHE_PREFIX}${appId}-${APP_CACHE_VERSION}`;
}

function shouldKeepCache(name) {
  return name === SHELL_CACHE_NAME || new RegExp(`^cas-app-.+-${APP_CACHE_VERSION}$`).test(name);
}

async function shellResponse(request) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    refreshShellCache(request, cache);
    return stampCoiHeaders(cached);
  }

  try {
    const network = await fetch(request);
    if (network.ok) {
      await cache.put(SHELL_URL, network.clone());
    }
    return stampCoiHeaders(network);
  } catch (err) {
    const cached = await cache.match(SHELL_URL);
    if (cached) return stampCoiHeaders(cached);
    throw err;
  }
}

async function shellAssetResponse(request) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return stampCoiHeaders(cached);

  try {
    const network = await fetch(request);
    if (network.ok) await cache.put(request, network.clone());
    return stampCoiHeaders(network);
  } catch (err) {
    throw err;
  }
}

function refreshShellCache(request, cache) {
  fetch(request)
    .then((response) => {
      if (response.ok) return cache.put(request, response);
      return undefined;
    })
    .catch(() => undefined);
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
