/**
 * Standalone CAS Settings window.
 */

import {
  PERMISSIONS,
  PERMISSION_COPY,
  listPermissionSubjects,
  grantPermission,
  revokePermission,
  escapeHtml,
} from "./permissions.js";
import { checkAllForUpdates, applyUpdate } from "./update-checker.js";
import { syncAppWorkerState } from "./bw-manager.js";
import { uninstallApp, uninstallPlugin } from "./uninstall.js";

export async function openSettingsApp() {
  const popup = window.open("", "cas-settings-app", "popup,width=980,height=720,resizable=yes");
  if (!popup) {
    alert("The browser blocked Settings. Allow pop-ups for this site and try again.");
    return;
  }

  const themeUrl = new URL("./theme.css", import.meta.url);
  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CAS Settings</title>
  <link rel="stylesheet" href="${themeUrl.href}" />
</head><body>
  <div class="cas-settings-window">
    <aside class="cas-settings-window__sidebar">
      <div class="cas-settings-window__brand">CAS</div>
      <button class="cas-settings-nav is-active" data-section="permissions">Permissions</button>
      <button class="cas-settings-nav" data-section="updates">Updates</button>
      <button class="cas-settings-nav" data-section="about">About</button>
      <button class="cas-settings-window__close" type="button">Close</button>
    </aside>
    <main class="cas-settings-window__main" id="cas-settings-root"></main>
  </div>
</body></html>`);
  popup.document.close();
  popup.focus();

  const root = popup.document.getElementById("cas-settings-root");
  const navButtons = [...popup.document.querySelectorAll(".cas-settings-nav")];
  const renderSection = async (section) => {
    navButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.section === section));
    if (section === "permissions") {
      renderPermissionsSection(root);
      await renderPermissionTable(root);
    } else if (section === "updates") {
      renderUpdatesSection(root);
    } else {
      renderAboutSection(root);
    }
  };

  navButtons.forEach((button) => button.addEventListener("click", () => renderSection(button.dataset.section)));
  popup.document.querySelector(".cas-settings-window__close").addEventListener("click", () => popup.close());
  await renderSection("permissions");
}

function renderPermissionsSection(root) {
  root.innerHTML = `
    <div class="cas-settings">
      <section class="cas-settings__section">
        <h1 class="cas-settings__title">Permissions</h1>
        <p class="cas-gate__note">Manage access and uninstall installed apps and plugins.</p>
        <div class="cas-perm-table" id="cas-perm-table"></div>
      </section>
    </div>`;
}

function renderUpdatesSection(root) {
  root.innerHTML = `
    <div class="cas-settings">
      <section class="cas-settings__section">
        <h1 class="cas-settings__title">Updates</h1>
        <p class="cas-gate__note">Verify and install signed updates for your apps.</p>
        <button class="cas-btn cas-btn--filled" id="cas-check-updates" type="button">Check for updates</button>
        <div id="cas-update-results"></div>
      </section>
    </div>`;
  root.querySelector("#cas-check-updates").addEventListener("click", () => runUpdateCheck(root));
}

function renderAboutSection(root) {
  root.innerHTML = `
    <div class="cas-settings">
      <section class="cas-settings__section">
        <h1 class="cas-settings__title">About CAS</h1>
        <p class="cas-gate__note">Cora App Services</p>
        <p>Offline-first app hosting powered by the browser Cache API and Service Worker.</p>
        <p class="cas-gate__note">Version 1.0 · Hpkproject</p>
      </section>
    </div>`;
}

async function renderPermissionTable(root) {
  const table = root.querySelector("#cas-perm-table");
  if (!table) return;
  const subjects = await listPermissionSubjects();
  if (subjects.length === 0) {
    table.innerHTML = `<p class="cas-gate__note">Nothing installed yet.</p>`;
    return;
  }

  table.innerHTML = subjects.map((subject) => {
    const rows = Object.values(PERMISSIONS).map((perm) => `
      <label class="cas-perm-row">
        <input type="checkbox" ${subject.permissions.has(perm) ? "checked" : ""}
          data-subject="${escapeHtml(subject.appId)}" data-perm="${perm}" />
        <span><strong>${escapeHtml(PERMISSION_COPY[perm].label)}</strong>
          <small>${escapeHtml(PERMISSION_COPY[perm].desc)}</small></span>
      </label>`).join("");
    return `
      <div class="cas-settings__app" data-subject-card="${escapeHtml(subject.appId)}">
        <div class="cas-settings__app-head">
          <h3>${escapeHtml(subject.name)} <small class="cas-gate__note">${subject.kind}</small></h3>
          <button class="cas-btn cas-btn--danger cas-uninstall-btn" type="button"
            data-subject="${escapeHtml(subject.appId)}" data-kind="${subject.kind}">Uninstall</button>
        </div>${rows}
      </div>`;
  }).join("");

  table.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", async () => {
      const { subject, perm } = input.dataset;
      input.disabled = true;
      try {
        if (input.checked) await grantPermission(subject, perm);
        else await revokePermission(subject, perm);
        if (perm === PERMISSIONS.BACKGROUND_WORKERS && !subject.startsWith("plugin:")) {
          await syncAppWorkerState(subject);
        }
      } catch (err) {
        alert(`Couldn't update permission: ${err.message}`);
        input.checked = !input.checked;
      } finally {
        input.disabled = false;
      }
    });
  });

  table.querySelectorAll(".cas-uninstall-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const { subject, kind } = button.dataset;
      const card = table.querySelector(`[data-subject-card="${CSS.escape(subject)}"]`);
      const name = card?.querySelector("h3")?.textContent ?? subject;
      if (!confirm(`Uninstall ${name}? This deletes its files and can't be undone.`)) return;
      button.disabled = true;
      button.textContent = "Uninstalling…";
      try {
        if (kind === "plugin") await uninstallPlugin(subject.replace(/^plugin:/, ""));
        else await uninstallApp(subject);
        await renderPermissionTable(root);
      } catch (err) {
        alert(`Couldn't uninstall "${name}": ${err.message}`);
        button.disabled = false;
        button.textContent = "Uninstall";
      }
    });
  });
}

async function runUpdateCheck(root) {
  const button = root.querySelector("#cas-check-updates");
  const results = root.querySelector("#cas-update-results");
  if (!button || !results) return;
  button.disabled = true;
  results.innerHTML = `<p class="cas-gate__note">Checking…</p>`;
  try {
    const updates = await checkAllForUpdates();
    if (!updates.length) {
      results.innerHTML = `<p class="cas-gate__note">Everything is up to date.</p>`;
      return;
    }
    results.innerHTML = "";
    updates.forEach((update) => results.appendChild(renderUpdateRow(update, root.ownerDocument)));
  } catch (err) {
    results.innerHTML = `<p class="cas-gate__note">Update check failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

function renderUpdateRow(update, ownerDocument) {
  const row = ownerDocument.createElement("div");
  row.className = "cas-settings__app";
  row.innerHTML = `
    <h3>${escapeHtml(update.app.name)} <small class="cas-gate__note">v${escapeHtml(update.version)} available</small></h3>
    ${update.notes ? `<p class="cas-gate__note">${escapeHtml(update.notes)}</p>` : ""}
    <button class="cas-btn cas-btn--filled" type="button">Update</button>`;
  row.querySelector("button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Verifying & installing…";
    try {
      await applyUpdate(update);
      button.textContent = "Updated";
    } catch (err) {
      alert(`Update failed: ${err.message}`);
      button.disabled = false;
      button.textContent = "Update";
    }
  });
  return row;
}
