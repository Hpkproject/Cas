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

const APP_CACHE_PREFIX = "cas-app-";
const APP_CACHE_VERSION = "v1";
const APP_URL_PREFIX = "/apps";
const APP_INDEX_PATH = "index.html";

export function appCacheName(appId) {
  return `${APP_CACHE_PREFIX}${appId}-${APP_CACHE_VERSION}`;
}

/**
 * Launches one installed offline app by ensuring its cache namespace is
 * hydrated, then opening a same-origin popup shell that mounts the app in
 * an iframe.
 */
export async function launchOfflineApp(app) {
  const appWindow = window.open("", `cas-app-${app.appId}`, "popup,width=1024,height=768");
  if (!appWindow) {
    throw new Error("The browser blocked the app window. Allow pop-ups for this site and try again.");
  }

  appWindow.document.open();
  appWindow.document.write(buildShellDocument(app.name));
  appWindow.document.close();
  appWindow.document.title = app.name;

  try {
    await ensureOfflineAppCache(app);
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
  const storageSnapshot = await loadPersistedStorage(app.appId);
  await stageOfflineAppCache({
    appId: app.appId,
    indexHtml,
    iconBlob,
    assetEntries,
    storageSnapshot,
  });
}

/**
 * Writes an app archive's files directly into Cache Storage during
 * installation, before the launcher ever tries to open the app.
 */
export async function stageOfflineAppFromArchive(app, zip, iconBlob) {
  const manifestIndex = zip.file(APP_INDEX_PATH);
  if (!manifestIndex) {
    throw new Error(`Invalid .hpk: offline app "${app.appId}" is missing index.html.`);
  }

  const indexHtml = await manifestIndex.async("string");
  const assetEntries = await collectAssetEntriesFromZip(zip, app.appId);
  const storageSnapshot = await loadPersistedStorage(app.appId);
  await stageOfflineAppCache({
    appId: app.appId,
    indexHtml,
    iconBlob,
    assetEntries,
    storageSnapshot,
  });
}

async function stageOfflineAppCache({ appId, indexHtml, iconBlob, assetEntries, storageSnapshot }) {
  await caches.delete(appCacheName(appId));
  const cache = await caches.open(appCacheName(appId));

  const stampedIndex = injectAppShell(indexHtml, storageSnapshot ?? {});
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

  for (const entry of assetEntries) {
    const urlPath = `${APP_URL_PREFIX}/${appId}/${entry.path}`;
    await cache.put(
      new Request(urlPath, { method: "GET" }),
      responseFromBytes(entry.bytes, guessMimeType(entry.path))
    );
  }
}

function injectAppShell(indexHtml, storageSnapshot) {
  const faviconTag = `<link rel="icon" type="image/png" href="/icon.png">`;
  const storageScript = buildStorageSyncScript(storageSnapshot);
  const casScript = `<script>${CAS_PERMS_CLIENT_SRC}</script>`;

  const headSnippets = `${faviconTag}\n${storageScript}\n${casScript}`;
  let html = indexHtml.includes("</head>")
    ? indexHtml.replace("</head>", `  ${headSnippets}\n</head>`)
    : `${headSnippets}\n${indexHtml}`;

  return html;
}

function mountPreview(appWindow, app) {
  const frame = appWindow.document.getElementById("cas-offline-frame");
  const status = appWindow.document.getElementById("cas-offline-status");
  const appUrl = `${APP_URL_PREFIX}/${app.appId}/${APP_INDEX_PATH}`;

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
  try {
    const assetsDir = await fs.getDir(["CAS", "apps", "assets", appId]);
    const zipHandle = await assetsDir.getFileHandle("assets.zip");
    const zipFile = await zipHandle.getFile();
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(zipFile);
    return collectAssetEntriesFromZip(zip, appId);
  } catch {
    return [];
  }
}

async function collectAssetEntriesFromZip(zip, appId) {
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
        rawPath = entry.name.slice("assets/".length);
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
    const bytes = new Uint8Array(await entry.async("uint8array"));
    entries.push({ path: relativePath, bytes });
  }
  return entries;
}

let cachedJSZip = null;
async function loadJSZip() {
  if (cachedJSZip) return cachedJSZip;
  const text = await fs.readText(["CAS", "sys", "api", "3rd-party", "jszip.js"]);
  if (!text) {
    throw new Error("jszip.js is missing from 3rd-party/ — run FsManager.ensureDependencies() first.");
  }
  const factory = new Function(`${text}\nreturn JSZip;`);
  cachedJSZip = factory();
  return cachedJSZip;
}

function appRequest(appId, relativePath) {
  return new Request(`${APP_URL_PREFIX}/${appId}/${relativePath}`, { method: "GET" });
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
