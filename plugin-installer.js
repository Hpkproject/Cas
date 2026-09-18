/**
 * plugin-installer.js
 * -----------------------------------------------------------------------
 * Parses .casplugin packages (same ZIP-with-extension idea as .hpk) with
 * a manifest.json + main.js + api.js at the root, shows the same M3
 * install dialog used for apps, and installs the plugin:
 *   - api.js  -> casf/CAS/apis/plugins/[name]/api.js   (public surface)
 *   - main.js + api.js -> casf/CAS/bws/plugins/[name]/  (background worker)
 *
 * Plugins have no permission prompt: installing one *is* the consent —
 * the spec calls for them to always run in the background, with no
 * separate opt-in the way an app's Background_Worker permission works.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { showInstallDialog } from "./hpk-installer.js";
import { installPluginWorkerFiles } from "./bw-manager.js";

let JSZipCtor = null;
async function loadJSZip() {
  if (JSZipCtor) return JSZipCtor;
  const text = await fs.readText(["CAS", "sys", "api", "3rd-party", "jszip.js"]);
  if (!text) {
    throw new Error("jszip.js is missing from 3rd-party/ — run FsManager.ensureDependencies() first.");
  }
  const factory = new Function(`${text}\nreturn JSZip;`);
  JSZipCtor = factory();
  return JSZipCtor;
}

/** Parses a .casplugin File into its manifest + live JSZip instance. */
export async function parseCasPlugin(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);

  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("Invalid .casplugin: manifest.json not found at archive root.");
  }
  const manifest = JSON.parse(await manifestEntry.async("string"));
  for (const field of ["name", "icon", "desc"]) {
    if (!(field in manifest)) {
      throw new Error(`Invalid .casplugin: manifest.json missing required field "${field}".`);
    }
  }
  if (!zip.file("main.js")) throw new Error("Invalid .casplugin: main.js not found at archive root.");
  if (!zip.file("api.js")) throw new Error("Invalid .casplugin: api.js not found at archive root.");

  return { manifest, zip };
}

/** Full install flow for one .casplugin File. Returns the plugin's registry entry, or null if cancelled. */
export async function installCasPlugin(file) {
  const { manifest, zip } = await parseCasPlugin(file);

  const iconEntry = zip.file(manifest.icon);
  const iconBlob = iconEntry ? await iconEntry.async("blob") : null;
  const iconObjectUrl = iconBlob ? URL.createObjectURL(iconBlob) : "";

  const confirmed = await showInstallDialog({
    name: manifest.name,
    desc: manifest.desc,
    icon: iconObjectUrl,
  });
  if (iconObjectUrl) URL.revokeObjectURL(iconObjectUrl);
  if (!confirmed) return null;

  const pluginId = sanitizePluginName(manifest.name);
  const mainJsBlob = await zip.file("main.js").async("blob");
  const apiJsBlob = await zip.file("api.js").async("blob");

  // Public surface apps read via CAS.import("pluginId") talks to.
  await fs.writeFile(["CAS", "apis", "plugins", pluginId, "api.js"], apiJsBlob);
  if (iconBlob) {
    await fs.writeFile(["CAS", "apis", "plugins", pluginId, "icon.png"], iconBlob);
  }

  // Working copy the always-on background worker actually runs.
  await installPluginWorkerFiles(pluginId, mainJsBlob, apiJsBlob);

  return appendPluginRegistryEntry({
    name: manifest.name,
    desc: manifest.desc,
    pluginId,
    iconPath: `CAS/apis/plugins/${pluginId}/icon.png`,
  });
}

async function appendPluginRegistryEntry(entry) {
  const raw = await fs.readText(["CAS", "apis", "plugins", "index.json"]);
  const registry = raw ? JSON.parse(raw) : [];
  const filtered = registry.filter((e) => e.pluginId !== entry.pluginId);
  filtered.push(entry);
  await fs.writeFile(["CAS", "apis", "plugins", "index.json"], JSON.stringify(filtered, null, 2));
  return entry;
}

function sanitizePluginName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}
