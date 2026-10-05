/**
 * webcontainer-runtime.js
 * -----------------------------------------------------------------------
 * Runs one "offline" app: boots a WebContainer, hydrates it with the
 * app's index.html/icon.png plus its packaged assets.zip, serves it via
 * a small Express server inside the container, and wires localStorage
 * persistence around the launch.
 *
 * WebContainer.boot() requires window.crossOriginIsolated === true —
 * coi-serviceworker.js (loaded first, in index.html's <head>) takes care
 * of that before this module ever runs. The one constraint that stays a
 * property of the platform itself: only one WebContainer instance may be
 * booted per browser tab at a time, so this module keeps a single shared
 * instance and reuses it across app launches rather than one per app.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import {
  loadPersistedStorage,
  savePersistedStorage,
  buildStorageSyncScript,
} from "./storage-sync.js";
import { CAS_PERMS_CLIENT_SRC } from "./cas-perms-client.js";
import { attachBridge } from "./cas-perms-bridge.js";

let containerInstance = null;
let containerBootPromise = null;

// @webcontainer/api's published build is NOT a single self-contained file —
// it has its own internal relative imports between sibling files (e.g.
// "./internal/auth-state.js"). Those only resolve against a real,
// hierarchical module URL. A blob: URL has no path structure for a
// relative import to resolve against at all, which is exactly the
// "Invalid relative url or base scheme isn't hierarchical" error:
// fetching the text and dynamic-importing it from a Blob URL (what this
// used to do) breaks the moment the bundle tries to pull in one of its
// own internal files. Importing directly from a CDN that mirrors the
// package's real file layout (jsdelivr does) sidesteps the problem
// entirely — the browser resolves "./internal/auth-state.js" against
// jsdelivr's own URL for this file, which is a normal, real request.
//
// This does mean booting a WebContainer needs network access to this
// CDN, not just to StackBlitz's own servers — but WebContainer.boot()
// already needs network access regardless (it downloads its Node.js/WASM
// runtime from StackBlitz at boot time), so this isn't giving up offline
// capability WebContainer-backed apps actually had.
const WEBCONTAINER_CDN_URL = "https://cdn.jsdelivr.net/npm/@webcontainer/api@1.5.1/dist/index.js";

// WebContainer.boot() talks to a headless helper iframe StackBlitz serves
// from w-corp-staticblitz.com, and that handshake depends on third-party
// storage/cookies not being blocked for that origin — see
// https://webcontainers.io/guides/troubleshooting ("WebContainers won't
// run properly... if cookie blockers... are enabled"). When that's
// blocked, boot() doesn't throw — it just never resolves, which looks
// like "nothing happens" with no error at all. This timeout turns that
// silent hang into an actual, actionable error instead.
const BOOT_TIMEOUT_MS = 20000;

/** Lazily boots (or reuses) the single shared WebContainer instance. */
async function getContainer() {
  if (containerInstance) return containerInstance;
  if (containerBootPromise) return containerBootPromise;

  containerBootPromise = (async () => {
    if (!window.crossOriginIsolated) {
      throw new Error(
        "window.crossOriginIsolated is false — WebContainer can't boot. " +
          "coi-serviceworker.js should have reloaded the page once to fix this; " +
          "try a hard reload (clearing the service worker if it still isn't true)."
      );
    }

    const { WebContainer } = await import(/* webpackIgnore: true */ WEBCONTAINER_CDN_URL);

    const bootResult = await Promise.race([
      WebContainer.boot({ workdirName: "cas-app" }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "WebContainer didn't boot within 20s. This almost always means " +
                  "third-party cookies/storage are blocked for w-corp-staticblitz.com " +
                  "(StackBlitz's own helper iframe) — check your browser's third-party " +
                  "cookie setting or any content/cookie-blocking extension for this site."
              )
            ),
          BOOT_TIMEOUT_MS
        )
      ),
    ]);

    containerInstance = bootResult;
    containerInstance.on("error", (err) => {
      console.error("[CAS] WebContainer runtime error:", err);
    });
    return containerInstance;
  })().catch((err) => {
    // A failed boot shouldn't be cached as "boot in progress" forever —
    // clear the promise so the next launch attempt gets a fresh try.
    containerBootPromise = null;
    throw err;
  });

  return containerBootPromise;
}

/** Minimal Express static server, written into the container's own filesystem. */
const SERVER_SCRIPT = `
const express = require("express");
const path = require("path");
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.listen(3000, () => console.log("cas-app-server-ready"));
`;

const PACKAGE_JSON = JSON.stringify(
  {
    name: "cas-app-runtime",
    type: "commonjs",
    dependencies: { express: "^4.19.2" },
    scripts: { start: "node server.js" },
  },
  null,
  2
);

/**
 * Full launch flow for one offline app registry entry:
 * boot -> hydrate files -> extract assets -> inject favicon ->
 * npm install -> start server -> open window -> wire storage sync.
 */
export async function launchOfflineApp(app) {
  const container = await getContainer();
  const appDir = await fs.getDir(["CAS", "apps", app.appId]);

  const indexHtmlFile = await (await appDir.getFileHandle("index.html")).getFile();
  let indexHtml = await indexHtmlFile.text();

  // Inject the app's own favicon before serving.
  const faviconTag = `<link rel="icon" type="image/png" href="/icon.png">`;
  indexHtml = indexHtml.includes("</head>")
    ? indexHtml.replace("</head>", `  ${faviconTag}\n</head>`)
    : `${faviconTag}\n${indexHtml}`;

  // Hydrate persisted localStorage into the served page.
  const persisted = await loadPersistedStorage(app.appId);
  const syncScript = buildStorageSyncScript(persisted);
  indexHtml = indexHtml.includes("</body>")
    ? indexHtml.replace("</body>", `${syncScript}\n</body>`)
    : `${indexHtml}\n${syncScript}`;

  // Give the app a window.CAS if it declared any CAS permissions at
  // install time — undeclared calls still work, they just trigger a
  // one-off runtime consent prompt (see permissions.js).
  const casScript = `<script>${CAS_PERMS_CLIENT_SRC}</script>`;
  indexHtml = indexHtml.includes("</body>")
    ? indexHtml.replace("</body>", `${casScript}\n</body>`)
    : `${indexHtml}\n${casScript}`;

  const fileTree = {
    "package.json": { file: { contents: PACKAGE_JSON } },
    "server.js": { file: { contents: SERVER_SCRIPT } },
    public: {
      directory: {
        "index.html": { file: { contents: indexHtml } },
      },
    },
  };

  // Mount icon.png into the served public/ directory, if present.
  try {
    const iconFile = await (await appDir.getFileHandle("icon.png")).getFile();
    fileTree.public.directory["icon.png"] = {
      file: { contents: new Uint8Array(await iconFile.arrayBuffer()) },
    };
  } catch {
    // No icon shipped — favicon tag will 404 silently, which is fine.
  }

  await container.mount(fileTree);
  await extractAssetsIntoContainer(container, app.appId);

  const installProcess = await container.spawn("npm", ["install"]);
  const installExit = await installProcess.exit;
  if (installExit !== 0) {
    throw new Error(`npm install failed for app "${app.appId}" (exit ${installExit}).`);
  }

  const serverUrl = await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not become ready in time.")), 15000);
    container.on("server-ready", (port, url) => {
      clearTimeout(timeout);
      resolve(url);
    });
    const serverProcess = await container.spawn("node", ["server.js"]);
    serverProcess.exit.then((code) => {
      if (code !== 0) reject(new Error(`Server process exited early (code ${code}).`));
    });
  });

  const appWindow = window.open(serverUrl, `cas-app-${app.appId}`, "popup,width=1024,height=768");
  wireStorageSync(appWindow, app.appId);
  attachBridge(appWindow, {
    appId: app.appId,
    appName: app.name,
    kind: "window",
    origin: new URL(serverUrl).origin,
  });
  return appWindow;
}

/**
 * Reads assets.zip for this app, and writes every entry into the
 * container's public/assets/ directory, preserving nested paths (e.g.
 * `random/appcode/scripts/mystuff/randomexample/usercode.js`) — but never
 * outside it: entries are re-validated here even though they were
 * already re-zipped by packageAssets (hpk-installer.js) with the same
 * check, since assets.zip is a plain file on disk that anything with
 * filesystem access could have swapped out after install.
 */
const MAX_ASSET_ENTRIES = 20000;
const MAX_ASSET_ENTRY_BYTES = 50 * 1024 * 1024;

async function extractAssetsIntoContainer(container, appId) {
  let zipHandle;
  try {
    const assetsDir = await fs.getDir(["CAS", "apps", "assets", appId]);
    zipHandle = await assetsDir.getFileHandle("assets.zip");
  } catch {
    return; // App has no packaged assets.
  }

  const zipFile = await zipHandle.getFile();
  const JSZip = await loadJSZipForExtraction();
  const zip = await JSZip.loadAsync(zipFile);

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length > MAX_ASSET_ENTRIES) {
    throw new Error(`assets.zip for "${appId}" has too many entries (${entries.length}).`);
  }

  for (const entry of entries) {
    const safeRelative = sanitizeZipEntryName(entry.name);
    if (safeRelative === null) {
      console.warn(`[CAS] skipped unsafe asset path in "${appId}": ${entry.name}`);
      continue;
    }
    const contents = new Uint8Array(await entry.async("uint8array"));
    if (contents.byteLength > MAX_ASSET_ENTRY_BYTES) {
      throw new Error(`Asset "${entry.name}" in "${appId}" exceeds the per-file size limit.`);
    }
    const targetPath = `public/assets/${safeRelative}`;
    await container.fs.mkdir(dirname(targetPath), { recursive: true });
    await container.fs.writeFile(targetPath, contents);
  }
}

/**
 * Collapses a zip entry's path and rejects it outright if it tries to
 * climb above the extraction root (the classic "zip slip" attack: an
 * entry named e.g. "../../../etc/passwd" or "..\\..\\evil.js"). Returns
 * null for anything unsafe rather than silently clamping it, since a
 * clamped path could still land somewhere the packager didn't intend.
 */
function sanitizeZipEntryName(name) {
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

let cachedJSZip = null;
async function loadJSZipForExtraction() {
  if (cachedJSZip) return cachedJSZip;
  const text = await fs.readText(["CAS", "sys", "api", "3rd-party", "jszip.js"]);
  const factory = new Function(`${text}\nreturn JSZip;`);
  cachedJSZip = factory();
  return cachedJSZip;
}

function dirname(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

/**
 * Listens for the sync-script's postMessage on unload and writes the
 * final localStorage snapshot back to key-values.json.
 */
function wireStorageSync(appWindow, appId) {
  function onMessage(event) {
    if (event.source !== appWindow) return;
    if (event.data?.type !== "cas:localstorage-sync") return;
    savePersistedStorage(appId, event.data.snapshot).catch((err) =>
      console.error(`[CAS] failed to persist localStorage for "${appId}":`, err)
    );
  }
  window.addEventListener("message", onMessage);

  const pollClosed = setInterval(() => {
    if (appWindow.closed) {
      clearInterval(pollClosed);
      window.removeEventListener("message", onMessage);
    }
  }, 1000);
}
