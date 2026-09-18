/**
 * permissions.js
 * -----------------------------------------------------------------------
 * Apps (and plugins) declare the CAS-level permissions they need in their
 * manifest: "notif" (send notifications via CAS.notify), "filesystem"
 * (read/write via CAS.fs.modify), and "background_workers" (run a
 * persistent worker started at CAS boot). Declared permissions are shown
 * as a consent list at install time; anything an app calls at runtime
 * without having declared it triggers a one-off runtime prompt instead,
 * mirroring how browsers handle undeclared permission requests.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";

export const PERMISSIONS = {
  NOTIF: "notif",
  FILESYSTEM: "filesystem",
  BACKGROUND_WORKERS: "background_workers",
};

const PERMISSION_COPY = {
  [PERMISSIONS.NOTIF]: {
    label: "Send notifications",
    desc: "Show notifications on your behalf via CAS.",
  },
  [PERMISSIONS.FILESYSTEM]: {
    label: "Modify files",
    desc: "Read and write files inside your CAS storage folder.",
  },
  [PERMISSIONS.BACKGROUND_WORKERS]: {
    label: "Run in the background",
    desc: "Start a background worker automatically when CAS starts.",
  },
};

/** Pulls the (possibly empty) list of valid permission ids off a manifest. */
export function declaredPermissions(manifest) {
  const raw = manifest.permissions ?? [];
  return raw.filter((p) => Object.values(PERMISSIONS).includes(p));
}

/**
 * Renders the M3 permission-consent list shown during install, one row
 * per declared permission with its own toggle. Resolves to the set of
 * permission ids the user actually granted (a subset of `requested`).
 */
export function showPermissionDialog({ name, icon, requested }) {
  if (requested.length === 0) return Promise.resolve(new Set());

  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "cas-dialog";
    const rows = requested
      .map(
        (perm) => `
        <label class="cas-perm-row">
          <input type="checkbox" checked data-perm="${perm}" />
          <span>
            <strong>${PERMISSION_COPY[perm].label}</strong>
            <small>${PERMISSION_COPY[perm].desc}</small>
          </span>
        </label>`
      )
      .join("");

    dialog.innerHTML = `
      <div class="cas-dialog__body">
        <img class="cas-dialog__icon" src="${icon}" alt="" />
        <h2 class="cas-dialog__title">${name} wants permission to:</h2>
        <div class="cas-perm-list">${rows}</div>
      </div>
      <div class="cas-dialog__actions">
        <button class="cas-btn cas-btn--text" data-action="deny-all">Deny all</button>
        <button class="cas-btn cas-btn--filled" data-action="continue">Continue</button>
      </div>
    `;

    dialog.addEventListener("click", (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      let granted = new Set();
      if (action === "continue") {
        granted = new Set(
          [...dialog.querySelectorAll("input[data-perm]")]
            .filter((el) => el.checked)
            .map((el) => el.dataset.perm)
        );
      }
      dialog.close();
      dialog.remove();
      resolve(granted);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/**
 * One-off runtime prompt for a permission the app never declared in its
 * manifest. Used as the fallback path when a call to CAS.notify /
 * CAS.fs.modify arrives from an app that didn't ask up front.
 */
export function showRuntimePermissionPrompt(appName, permission) {
  return new Promise((resolve) => {
    const copy = PERMISSION_COPY[permission];
    const dialog = document.createElement("dialog");
    dialog.className = "cas-dialog";
    dialog.innerHTML = `
      <div class="cas-dialog__body">
        <h2 class="cas-dialog__title">${appName}</h2>
        <p class="cas-dialog__desc">wants to: <strong>${copy.label}</strong><br/>${copy.desc}</p>
      </div>
      <div class="cas-dialog__actions">
        <button class="cas-btn cas-btn--text" data-action="deny">Deny</button>
        <button class="cas-btn cas-btn--filled" data-action="allow">Allow</button>
      </div>
    `;
    dialog.addEventListener("click", (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      dialog.close();
      dialog.remove();
      resolve(action === "allow");
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/** Requests CAS's own OS-level Notification permission (asked once, at first-run setup). */
export async function requestCasNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

/* ---------------------------------------------------------------------
 * Per-app permission grants are stored as `permissions: [...]` directly
 * on each app's entry in casf/CAS/apps/index.json (see hpk-installer.js).
 * These helpers read/update that list for a given app id.
 * ------------------------------------------------------------------- */

/**
 * Both apps and plugins can call CAS.fs.modify / CAS.notify, but they're
 * tracked in two different registry files (casf/CAS/apps/index.json vs
 * casf/CAS/apis/plugins/index.json). callPlugin/bw-manager.js identify a
 * plugin caller with the "plugin:" prefix, which is what routes these
 * two functions to the right file.
 */
function registryPathFor(appId) {
  return appId.startsWith("plugin:")
    ? ["CAS", "apis", "plugins", "index.json"]
    : ["CAS", "apps", "index.json"];
}
function matchesId(entry, appId) {
  const bareId = appId.startsWith("plugin:") ? appId.slice("plugin:".length) : appId;
  return (entry.appId ?? entry.pluginId ?? entry.name) === bareId;
}

export async function getGrantedPermissions(appId) {
  const raw = await fs.readText(registryPathFor(appId));
  const registry = raw ? JSON.parse(raw) : [];
  const entry = registry.find((e) => matchesId(e, appId));
  return new Set(entry?.permissions ?? []);
}

export async function grantPermission(appId, permission) {
  const path = registryPathFor(appId);
  const raw = await fs.readText(path);
  const registry = raw ? JSON.parse(raw) : [];
  const entry = registry.find((e) => matchesId(e, appId));
  if (!entry) return;
  entry.permissions = [...new Set([...(entry.permissions ?? []), permission])];
  await fs.writeFile(path, JSON.stringify(registry, null, 2));
}
