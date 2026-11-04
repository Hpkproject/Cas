/**
 * offline-runtime.js
 * -----------------------------------------------------------------------
 * Browser-native offline app runtime. Takes an installed app's files,
 * stages them into a per-app Cache Storage bucket, and opens a preview
 * shell that hosts the app in an iframe at /apps/[appId]/index.html.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { loadPersistedStorage, buildStorageSyncScript } from "./storage-sync.js";
import { CAS_PERMS_CLIENT_SRC } from "./cas-perms-client.js";
import { attachBridge } from "./cas-perms-bridge.js";
import { openZip } from "./zip-reader.js";

const APP_CACHE_PREFIX = "cas-app-";
const APP_CACHE_VERSION = "v4";
const APP_INDEX_PATH = "index.html";
const CACHE_WRITE_CONCURRENCY = 6;

function appUrlPrefix() {
  const base = new URL("./", import.meta.url).pathname.replace(/\/$/, "");
  return `${base}/apps`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}

export function appCacheName(appId) {
  return `${APP_CACHE_PREFIX}${appId}-${APP_CACHE_VERSION}`;
}

async function clearAppCaches(appId) {
  const prefix = `${APP_CACHE_PREFIX}${appId}-`;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map((name) => caches.delete(name))
  );
}

/**
 * Launches one installed offline app by ensuring its cache namespace is
 * hydrated, then opening a same-origin popup shell that mounts the app in
 * an iframe.
 */
export async function launchOfflineApp(app) {
  const started = performance.now();
  console.info(`[CAS] launching "${app.name}": opening app window`);
  const appWindow = window.open("", `cas-app-${app.appId}`, "popup,width=1024,height=768");
  if (!appWindow) {
    throw new Error("The browser blocked the app window. Allow pop-ups for this site and try again.");
  }

  appWindow.document.open();
  appWindow.document.write(buildShellDocument(app.name));
  appWindow.document.close();
  appWindow.document.title = app.name;

  try {
    console.info(`[CAS] launching "${app.name}": preparing app files`);
    await ensureOfflineAppCache(app);
    console.info(`[CAS] launching "${app.name}": ready after ${formatDuration((performance.now() - started) / 1000)}`);
    mountPreview(appWindow, app);
    return appWindow;
  } catch (err) {
    appWindow.document.body.textContent = `Could not launch ${app.name}: ${err.message}`;
    throw err;
  }
}

/**
 * Rebuilds an app's cache namespace from the files currently on disk.
 * Used both at install time and when launching, so evicted caches can be
 * restored without any network dependency.
 */
export async function ensureOfflineAppCache(app) {
  const started = performance.now();
  const existingCache = await caches.open(appCacheName(app.appId));
  if (await existingCache.match(appRequest(app.appId, APP_INDEX_PATH))) {
    console.info(`[CAS] launch load "${app.name}": reusing existing app cache`);
    return;
  }
  console.info(`[CAS] launch load "${app.name}": reading shell`);
  const appDir = await fs.getDir(["CAS", "apps", app.appId]);
  const indexHtmlFile = await (await appDir.getFileHandle(APP_INDEX_PATH)).getFile();
  const indexHtml = await indexHtmlFile.text();

  let iconBlob = null;
  try {
    const iconFile = await (await appDir.getFileHandle("icon.png")).getFile();
    iconBlob = iconFile;
  } catch {
    iconBlob = null;
  }

  const assetEntries = await readAssetEntriesFromDisk(app.appId);
  console.info(`[CAS] launch load "${app.name}": found ${assetEntries.length} files`);
  const storageSnapshot = await loadPersistedStorage(app.appId);
  await stageOfflineAppCache({
    appId: app.appId,
    indexHtml,
    iconBlob,
    assetEntries,
    storageSnapshot,
    logLabel: app.name,
  });
  console.info(`[CAS] launch load "${app.name}": finished in ${formatDuration((performance.now() - started) / 1000)}`);
}

/**
 * Writes an app archive's files directly into the selected CAS folder.
 * Cache API staging is deferred until the app is launched.
 */
export async function stageOfflineAppFromArchive(app, zip, iconBlob, onProgress = () => {}) {
  const manifestIndex = zip.file(APP_INDEX_PATH);
  if (!manifestIndex) {
    throw new Error(`Invalid .hpk: offline app "${app.appId}" is missing index.html.`);
  }

  const indexHtml = await manifestIndex.async("string");
  const assetEntries = collectAssetEntriesFromZip(zip, app.appId);
  onProgress(0, assetEntries.length || 1);
  await persistAppFilesToDisk({
    appId: app.appId,
    indexHtml,
    iconBlob,
    assetEntries,
    onProgress,
  });
  console.info(`[CAS] installed "${app.appId}" directly into the CAS storage folder; Cache API staging deferred until launch.`);
}

async function stageOfflineAppCache({ appId, indexHtml, iconBlob, assetEntries, storageSnapshot, onProgress = () => {}, logLabel = appId }) {
  await clearAppCaches(appId);
  if (navigator.storage?.persist) {
    try {
      const persistent = await navigator.storage.persist();
      console.info(`[CAS] persistent browser storage for "${appId}": ${persistent ? "enabled" : "not granted"}`);
    } catch (err) {
      console.warn(`[CAS] could not request persistent storage for "${appId}":`, err);
    }
  }
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const used = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    console.info(
      `[CAS] storage before caching "${appId}": ${formatBytes(used)} used of ${formatBytes(quota)} quota`
    );
  }
  const cache = await caches.open(appCacheName(appId));

  try {
    const stampedIndex = injectAppShell(indexHtml, appId, storageSnapshot ?? {});
    await cache.put(
      appRequest(appId, APP_INDEX_PATH),
      responseFromText(stampedIndex, "text/html; charset=utf-8")
    );

    if (iconBlob) {
      await cache.put(
        appRequest(appId, "icon.png"),
        responseFromBlob(iconBlob, "image/png")
      );
    }

    let cursor = 0;
    let completed = 0;
    const writeWorker = async () => {
      while (cursor < assetEntries.length) {
        const index = cursor++;
        const entry = assetEntries[index];
        const urlPath = `${appUrlPrefix()}/${appId}/${entry.path}`;
        try {
          const bytes = await readAssetBytes(entry);
          await cache.put(
            new Request(urlPath, { method: "GET" }),
            responseFromBytes(bytes, guessMimeType(entry.path))
          );
        } catch (err) {
          if (err?.name === "QuotaExceededError" || /quota exceeded/i.test(String(err?.message))) throw err;
          console.error(`[CAS] skipped unreadable asset "${entry.path}"; continuing launch:`, err);
        }
        completed += 1;
        onProgress(completed, assetEntries.length || 1);
        if (completed === 1 || completed % 25 === 0 || completed === assetEntries.length) {
          console.info(`[CAS] launch load "${logLabel}": cached ${completed}/${assetEntries.length} files`);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(CACHE_WRITE_CONCURRENCY, assetEntries.length) },
        () => writeWorker()
      )
    );
  } catch (err) {
    await caches.delete(appCacheName(appId));
    if (err?.name === "QuotaExceededError" || /quota exceeded/i.test(String(err?.message))) {
      const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
      const used = estimate?.usage ?? 0;
      const quota = estimate?.quota ?? 0;
      console.error(
        `[CAS] browser storage quota reached while caching "${appId}" ` +
        `(${formatBytes(used)} used of ${formatBytes(quota)} quota). ` +
        "Free disk space does not increase this per-site browser quota.",
        err
      );
      await persistAppFilesToDisk({
        appId,
        indexHtml,
        iconBlob,
        assetEntries,
        onProgress,
      });
      console.warn(
        `[CAS] Cache API quota reached for "${appId}"; app files were written directly to the CAS storage folder.`
      );
      return;
    }
    throw err;
  }
}

async function persistAppFilesToDisk({ appId, indexHtml, iconBlob, assetEntries, onProgress }) {
  await fs.writeFile(["CAS", "apps", appId, "index.html"], injectAppShell(indexHtml, appId, {}));
  if (iconBlob) {
    await fs.writeFile(["CAS", "apps", appId, "icon.png"], iconBlob);
  }
  console.info(`[CAS] writing ${assetEntries.length} app files directly to CAS storage for "${appId}"`);
  for (const [index, entry] of assetEntries.entries()) {
    if (shouldSkipDirectAsset(entry.path)) {
      console.info(`[CAS] skipping metadata asset "${entry.path}" in direct-storage mode`);
      onProgress(index + 1, assetEntries.length || 1);
      continue;
    }
    const pathSegments = safeStorageSegments(entry.path);
    if (!pathSegments) {
      console.warn(`[CAS] skipped asset that cannot be represented in CAS storage: ${entry.path}`);
      onProgress(index + 1, assetEntries.length || 1);
      continue;
    }
    try {
      const bytes = await readAssetBytes(entry);
      await fs.writeFile(
        ["CAS", "apps", appId, ...pathSegments],
        new Blob([bytes], { type: guessMimeType(entry.path) })
      );
    } catch (err) {
      console.error(`[CAS] could not write asset "${entry.path}" directly to CAS storage; continuing:`, err);
    }
    onProgress(index + 1, assetEntries.length || 1);
  }
}

async function readAssetBytes(entry) {
  if (entry.zipEntry) return new Uint8Array(await entry.zipEntry.async("uint8array"));
  if (entry.fileHandle) return new Uint8Array(await (await entry.fileHandle.getFile()).arrayBuffer());
  return entry.bytes;
}

function shouldSkipDirectAsset(path) {
  const segments = String(path).split("/");
  return segments.some((segment) =>
    segment === ".git" ||
    segment === ".svn" ||
    segment === ".hg" ||
    segment.toLowerCase() === "thumbs.db" ||
    segment.toLowerCase() === ".ds_store"
  );
}

function safeStorageSegments(path) {
  const segments = String(path).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.map((segment) => {
    let safe = segment.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
    if (!safe || safe === "." || safe === "..") safe = "_";
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
    return safe.replace(/[. ]+$/, "_");
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0];
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function injectAppShell(indexHtml, appId, storageSnapshot) {
  const baseTag = `<base href="${appUrlPrefix()}/${appId}/">`;
  const faviconTag = `<link rel="icon" type="image/png" href="${appUrlPrefix()}/${appId}/icon.png">`;
  const storageScript = buildStorageSyncScript(storageSnapshot);
  const casScript = `<script>${CAS_PERMS_CLIENT_SRC}</script>`;
  const appNavigationScript = buildAppNavigationScript(appId);

  const headSnippets = `${baseTag}\n${faviconTag}\n${storageScript}\n${casScript}\n${appNavigationScript}`;
  let html = rewriteAssetUrls(indexHtml, appId);
  html = html.includes("</head>")
    ? html.replace("</head>", `  ${headSnippets}\n</head>`)
    : `${headSnippets}\n${html}`;

  return html;
}

function buildAppNavigationScript(appId) {
  const appBase = `${appUrlPrefix()}/${appId}/`;
  const baseJson = JSON.stringify(appBase);
  return `<script>
(function () {
  var appBase = ${baseJson};
  function bootstrapUrl(url) {
    var destination = new URL(url, appBase);
    var routePath = destination.pathname.indexOf(appBase) === 0
      ? destination.pathname.slice(appBase.length) + destination.search + destination.hash
      : destination.href;
    return destination.origin + appBase + "index.html?cas-route=" + encodeURIComponent(routePath);
  }
  var route = new URLSearchParams(location.search).get("cas-route");
  if (route) {
    (async function () {
      try {
        var target = new URL(route, appBase);
        var response = await fetch(target.href);
        if (!response.ok) throw new Error("HTTP " + response.status);
        var markup = await response.text();
        history.replaceState(null, "", target.href);
        document.open();
        document.write(markup);
        document.close();
      } catch (error) {
        console.error("[CAS] could not open app route", route, error);
      }
    }());
    return;
  }
  var originalOpen = window.open;
  window.open = function (url, target, features) {
    if (typeof url === "string" && !/^(?:[a-z][a-z0-9+.-]*:|\\/\\/|#|javascript:)/i.test(url)) {
      try { url = bootstrapUrl(url); } catch (_) {}
    }
    return originalOpen.call(window, url, target, features);
  };
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    var href = link.getAttribute("href");
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\\/\\/|#|javascript:)/i.test(href)) return;
    if (link.target === "_blank" || link.target === "_new") {
      event.preventDefault();
      var bootstrap = bootstrapUrl(href);
      originalOpen.call(window, bootstrap, link.target, "noopener,noreferrer");
    } else if (href.charAt(0) === "/" && href.indexOf(appBase) !== 0 &&
               href.indexOf("${appUrlPrefix()}/") !== 0) {
      link.setAttribute("href", appBase + href.slice(1));
    }
  }, true);
}());
</script>`;
}

function rewriteAssetUrls(html, appId) {
  const appBase = `${appUrlPrefix()}/${appId}/`;
  const rootPrefix = appBase.slice(0, appBase.indexOf("/apps/"));
  return String(html)
    .replace(/(["'(])\/(?!\/)/g, (match, prefix, offset, source) => {
      const rest = source.slice(offset + match.length);
      if (rest.startsWith(appBase.slice(1)) || rest.startsWith(rootPrefix.slice(1))) return match;
      return `${prefix}${appBase}`;
    })
    .replace(/url\(\s*\/(?!\/)/g, (match, offset, source) => {
      const rest = source.slice(offset + match.length);
      if (rest.startsWith(appBase.slice(1)) || rest.startsWith(rootPrefix.slice(1))) return match;
      return `url(${appBase}`;
    });
}

function mountPreview(appWindow, app) {
  const frame = appWindow.document.getElementById("cas-offline-frame");
  const status = appWindow.document.getElementById("cas-offline-status");
  const appUrl = `${appUrlPrefix()}/${app.appId}/${APP_INDEX_PATH}`;

  frame.addEventListener(
    "load",
    () => {
      if (status) status.textContent = "";
      if (frame.contentWindow) {
        attachBridge(frame.contentWindow, {
          appId: app.appId,
          appName: app.name,
          kind: "window",
          origin: window.location.origin,
        });
      }
    },
    { once: true }
  );

  appWindow.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.data?.type !== "cas:localstorage-sync") return;
    if (!appWindow.opener || appWindow.opener.closed) return;
    appWindow.opener.postMessage(event.data, window.location.origin);
  });

  frame.src = appUrl;
}

async function readAssetEntriesFromDisk(appId) {
  const appDir = await fs.getDir(["CAS", "apps", appId]);
  const directEntries = await collectAssetFilesFromDirectory(
    appDir,
    "",
    new Set(["index.html", "icon.png"])
  );
  if (directEntries.length > 0) return directEntries;

  const assetsDir = await fs.getDir(["CAS", "apps", "assets", appId]);
  try {
    const zipHandle = await assetsDir.getFileHandle("assets.zip");
    const zipFile = await zipHandle.getFile();
    const zip = await openZip(zipFile);
    return collectAssetEntriesFromZip(zip, appId);
  } catch {
    return [];
  }
}

async function collectAssetFilesFromDirectory(directory, prefix, excluded = new Set()) {
  const entries = [];
  for await (const handle of directory.values()) {
    const path = prefix ? `${prefix}/${handle.name}` : handle.name;
    if (excluded.has(path)) continue;
    if (shouldSkipDirectAsset(path)) continue;
    if (handle.kind === "directory") {
      entries.push(...await collectAssetFilesFromDirectory(handle, path, excluded));
      continue;
    }
    entries.push({
      path,
      fileHandle: handle,
    });
  }
  return entries;
}

function collectAssetEntriesFromZip(zip, appId) {
  const entries = [];
  const looksLikeHpk = Object.values(zip.files).some(
    (entry) => !entry.dir && (entry.name === "manifest.json" || entry.name === "index.html" || entry.name === "icon.png")
  );
  const hasAssetsPrefix = Object.values(zip.files).some((entry) => !entry.dir && entry.name.startsWith("assets/"));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    let rawPath = null;
    if (hasAssetsPrefix) {
      if (entry.name.startsWith("assets/")) {
        rawPath = entry.name;
      } else if (!looksLikeHpk) {
        rawPath = entry.name;
      }
    } else if (!looksLikeHpk) {
      rawPath = entry.name;
    }
    if (!rawPath) continue;
    const relativePath = sanitizeRelativePath(rawPath);
    if (!relativePath) {
      console.warn(`[CAS] skipped unsafe asset path in "${appId}": ${entry.name}`);
      continue;
    }
    if (shouldSkipDirectAsset(relativePath)) {
      console.info(`[CAS] skipped archive metadata asset "${relativePath}"`);
      continue;
    }
    entries.push({ path: relativePath, zipEntry: entry });
  }
  return entries;
}

function appRequest(appId, relativePath) {
  return new Request(`${appUrlPrefix()}/${appId}/${relativePath}`, { method: "GET" });
}

function responseFromText(text, contentType) {
  return responseFromBody(text, contentType);
}

function responseFromBlob(blob, contentType) {
  return responseFromBody(blob, contentType);
}

function responseFromBytes(bytes, contentType) {
  return responseFromBody(bytes, contentType);
}

function responseFromBody(body, contentType) {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
    },
  });
}

function guessMimeType(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "txt":
      return "text/plain; charset=utf-8";
    case "xml":
      return "application/xml; charset=utf-8";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "pdf":
      return "application/pdf";
    case "wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function sanitizeRelativePath(name) {
  const out = [];
  for (const raw of String(name).replace(/\\/g, "/").split("/")) {
    const segment = raw.trim();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length ? out.join("/") : null;
}

function buildShellDocument(appName) {
  const safeName = escapeHtml(appName);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeName}</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #141218; color: #e9e1ff; }
    body { display: grid; grid-template-rows: auto 1fr; font: 14px/1.4 system-ui, sans-serif; }
    #cas-offline-status { padding: 12px 16px; color: #cbb7ff; }
    #cas-offline-frame { border: 0; width: 100%; height: 100%; background: #fff; }
  </style>
</head>
<body>
  <div id="cas-offline-status">Loading ${safeName}…</div>
  <iframe id="cas-offline-frame" title="${safeName}"></iframe>
  <script>
    (function () {
      var frame = document.getElementById("cas-offline-frame");
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.type !== "cas:localstorage-sync") return;
        if (event.source !== frame.contentWindow) return;
        if (!window.opener || window.opener.closed) return;
        window.opener.postMessage(event.data, window.location.origin);
      });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
