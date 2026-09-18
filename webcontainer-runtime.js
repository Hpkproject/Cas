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

/** Lazily boots (or reuses) the single shared WebContainer instance. */
async function getContainer() {
  if (containerInstance) return containerInstance;
  if (containerBootPromise) return containerBootPromise;

  containerBootPromise = (async () => {
    const text = await fs.readText(["CAS", "sys", "api", "3rd-party", "webcontainer.js"]);
    if (!text) {
      throw new Error("webcontainer.js is missing from 3rd-party/ — run FsManager.ensureDependencies() first.");
    }
    // Vendored as an ES module bundle; import it via a Blob URL so it
    // executes with real `import`/`export` semantics instead of eval.
    const blob = new Blob([text], { type: "text/javascript" });
    const moduleUrl = URL.createObjectURL(blob);
    const { WebContainer } = await import(/* webpackIgnore: true */ moduleUrl);
    URL.revokeObjectURL(moduleUrl);

    containerInstance = await WebContainer.boot({ workdirName: "cas-app" });
    return containerInstance;
  })();

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
  attachBridge(appWindow, { appId: app.appId, appName: app.name, kind: "window" });
  return appWindow;
}

/**
 * Reads assets.zip for this app, and writes every entry into the
 * container's public/assets/ directory, preserving nested paths (e.g.
 * `random/appcode/scripts/mystuff/randomexample/usercode.js`).
 */
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
  for (const entry of entries) {
    const contents = new Uint8Array(await entry.async("uint8array"));
    const targetPath = `public/assets/${entry.name}`;
    await container.fs.mkdir(dirname(targetPath), { recursive: true });
    await container.fs.writeFile(targetPath, contents);
  }
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
