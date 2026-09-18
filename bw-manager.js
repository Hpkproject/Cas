/**
 * bw-manager.js
 * -----------------------------------------------------------------------
 * Owns every long-running background worker: one per installed app that
 * declared a Background_Worker + was granted the "background_workers"
 * permission, plus one per installed .casplugin (plugins always run).
 * Booted once when CAS itself starts (including CAS's own OS-boot
 * autostart, via manifest.json's run_on_os_login) — see app.js.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { PERMISSIONS, getGrantedPermissions } from "./permissions.js";
import { attachBridge } from "./cas-perms-bridge.js";
import { CAS_PERMS_CLIENT_SRC } from "./cas-perms-client.js";

/** pluginName -> { worker, pending: Map<callId, {resolve,reject}> } */
const pluginWorkers = new Map();
let nextInvokeId = 1;

/**
 * Copies an app's declared background-worker script into
 * casf/CAS/bws/[appId]/sw.js at install time. `scriptBlob` is the file
 * read out of the .hpk under the name given by the manifest's
 * Background_Worker field.
 */
export async function installAppBackgroundWorker(appId, scriptBlob) {
  await fs.writeFile(["CAS", "bws", appId, "sw.js"], scriptBlob);
}

/** Copies a plugin's main.js + api.js into casf/CAS/bws/plugins/[name]/. */
export async function installPluginWorkerFiles(pluginName, mainJsBlob, apiJsBlob) {
  await fs.writeFile(["CAS", "bws", "plugins", pluginName, "main.js"], mainJsBlob);
  await fs.writeFile(["CAS", "bws", "plugins", pluginName, "api.js"], apiJsBlob);
}

/** Boots every registered app + plugin background worker. Safe to call repeatedly (skips already-running ones). */
export async function bootAll() {
  const apps = await loadAppRegistry();
  for (const app of apps) {
    if (!app.backgroundWorker) continue;
    const granted = await getGrantedPermissions(app.appId ?? app.name);
    if (!granted.has(PERMISSIONS.BACKGROUND_WORKERS)) continue;
    await bootAppWorker(app).catch((err) =>
      console.error(`[CAS] failed to start background worker for "${app.name}":`, err)
    );
  }

  const plugins = await loadPluginRegistry();
  for (const plugin of plugins) {
    await bootPluginWorker(plugin).catch((err) =>
      console.error(`[CAS] failed to start plugin "${plugin.pluginId}":`, err)
    );
  }
}

async function bootAppWorker(app) {
  const appId = app.appId ?? app.name;
  const text = await fs.readText(["CAS", "bws", appId, "sw.js"]);
  if (!text) return;

  const worker = new Worker(sourceToBlobUrl(CAS_PERMS_CLIENT_SRC + "\n" + text), { type: "module" });
  attachBridge(worker, { appId, appName: app.name, kind: "worker" });
}

async function bootPluginWorker(plugin) {
  const pluginId = plugin.pluginId;
  if (pluginWorkers.has(pluginId)) return; // already running

  const [apiJs, mainJs] = await Promise.all([
    fs.readText(["CAS", "bws", "plugins", pluginId, "api.js"]),
    fs.readText(["CAS", "bws", "plugins", pluginId, "main.js"]),
  ]);
  if (!apiJs || !mainJs) return;

  const source = [
    CAS_PERMS_CLIENT_SRC,
    apiJs, // convention: assigns self.PLUGIN_API = { methodName(...) {...}, ... }
    mainJs,
    PLUGIN_INVOKE_SHIM,
  ].join("\n");

  const worker = new Worker(sourceToBlobUrl(source), { type: "module" });
  attachBridge(worker, { appId: `plugin:${pluginId}`, appName: plugin.name, kind: "worker" });

  const pending = new Map();
  worker.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type !== "cas:plugin-invoke-result") return;
    const entry = pending.get(msg.callId);
    if (!entry) return;
    pending.delete(msg.callId);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  });

  pluginWorkers.set(pluginId, { worker, pending });
}

/** Invoked by cas-perms-bridge.js when an app calls CAS.import("x").someMethod(...). */
export function callPlugin(pluginName, methodName, args) {
  const entry = pluginWorkers.get(pluginName);
  if (!entry) {
    return Promise.reject(new Error(`Plugin "${pluginName}" is not installed or not running.`));
  }
  const callId = nextInvokeId++;
  return new Promise((resolve, reject) => {
    entry.pending.set(callId, { resolve, reject });
    entry.worker.postMessage({ type: "cas:plugin-invoke", callId, method: methodName, args });
  });
}

/** Appended to every plugin worker's source; bridges incoming invoke requests to self.PLUGIN_API. */
const PLUGIN_INVOKE_SHIM = `
self.addEventListener("message", function (event) {
  var msg = event.data;
  if (!msg || msg.type !== "cas:plugin-invoke") return;
  Promise.resolve()
    .then(function () {
      if (!self.PLUGIN_API || typeof self.PLUGIN_API[msg.method] !== "function") {
        throw new Error('Plugin has no method "' + msg.method + '".');
      }
      return self.PLUGIN_API[msg.method].apply(null, msg.args || []);
    })
    .then(function (result) {
      self.postMessage({ type: "cas:plugin-invoke-result", callId: msg.callId, ok: true, result: result });
    })
    .catch(function (err) {
      self.postMessage({ type: "cas:plugin-invoke-result", callId: msg.callId, ok: false, error: String(err && err.message || err) });
    });
});
`;

function sourceToBlobUrl(source) {
  const blob = new Blob([source], { type: "text/javascript" });
  return URL.createObjectURL(blob);
}

async function loadAppRegistry() {
  const raw = await fs.readText(["CAS", "apps", "index.json"]);
  return raw ? JSON.parse(raw) : [];
}

async function loadPluginRegistry() {
  const raw = await fs.readText(["CAS", "apis", "plugins", "index.json"]);
  return raw ? JSON.parse(raw) : [];
}
