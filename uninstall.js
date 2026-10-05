/**
 * uninstall.js
 * -----------------------------------------------------------------------
 * Reverses what hpk-installer.js / plugin-installer.js wrote. Order
 * matters: the worker is stopped before files are deleted (so it can't
 * still be mid-write to something about to disappear), and the registry
 * entry is removed last (so a failure partway through still leaves an
 * app visible rather than silently "forgotten" while still on disk).
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { stopAppWorker, stopPluginWorker } from "./bw-manager.js";

/** Removes everything an offline/online app's install wrote, and its registry entry. */
export async function uninstallApp(appId) {
  stopAppWorker(appId);

  await fs.removeEntry(["CAS", "apps", appId], { recursive: true });
  await fs.removeEntry(["CAS", "apps", "assets", appId], { recursive: true });
  await fs.removeEntry(["CAS", "apps", "localstorage", appId], { recursive: true });
  await fs.removeEntry(["CAS", "bws", appId], { recursive: true });

  await removeRegistryEntry(["CAS", "apps", "index.json"], (e) => (e.appId ?? e.name) === appId);
}

/** Removes everything a .casplugin's install wrote, and its registry entry. */
export async function uninstallPlugin(pluginId) {
  stopPluginWorker(pluginId);

  await fs.removeEntry(["CAS", "apis", "plugins", pluginId], { recursive: true });
  await fs.removeEntry(["CAS", "bws", "plugins", pluginId], { recursive: true });

  await removeRegistryEntry(["CAS", "apis", "plugins", "index.json"], (e) => e.pluginId === pluginId);
}

async function removeRegistryEntry(path, matches) {
  const raw = await fs.readText(path);
  if (!raw) return;
  const registry = JSON.parse(raw);
  const filtered = registry.filter((e) => !matches(e));
  await fs.writeFile(path, JSON.stringify(filtered, null, 2));
}
