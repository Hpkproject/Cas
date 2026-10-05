/**
 * settings-app.js
 * -----------------------------------------------------------------------
 * A built-in view (not something installed via .hpk) that lets the user:
 *   - see and toggle each installed app/plugin's granted permissions
 *   - manually check for and apply signed updates (see update-checker.js)
 * -----------------------------------------------------------------------
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

/** Replaces `root`'s content with the Settings screen. `onClose` re-renders whatever was there before (the sidebar's Home button also gets you back). */
export async function openSettingsApp(root, onClose) {
  root.innerHTML = `
    <div class="cas-settings">
      <h1 class="cas-settings__title">
        <button class="cas-btn cas-btn--text cas-settings__back" type="button">←</button>
        Settings
      </h1>

      <section class="cas-settings__section">
        <h2>Apps & Plugins</h2>
        <p class="cas-gate__note">What each one is allowed to do, and uninstalling.</p>
        <div class="cas-perm-table" id="cas-perm-table"></div>
      </section>

      <section class="cas-settings__section">
        <h2>Updates</h2>
        <button class="cas-btn cas-btn--filled" id="cas-check-updates" type="button">Check for updates</button>
        <div id="cas-update-results"></div>
      </section>
    </div>
  `;

  root.querySelector(".cas-settings__back").addEventListener("click", () => onClose());
  root.querySelector("#cas-check-updates").addEventListener("click", runUpdateCheck);

  await renderPermissionTable();
}

async function renderPermissionTable() {
  const table = document.getElementById("cas-perm-table");
  if (!table) return;
  const subjects = await listPermissionSubjects();

  if (subjects.length === 0) {
    table.innerHTML = `<p class="cas-gate__note">Nothing installed yet.</p>`;
    return;
  }

  table.innerHTML = subjects
    .map((subject) => {
      const rows = Object.values(PERMISSIONS)
        .map((perm) => {
          const checked = subject.permissions.has(perm) ? "checked" : "";
          return `
            <label class="cas-perm-row">
              <input type="checkbox" ${checked} data-subject="${escapeHtml(subject.appId)}" data-perm="${perm}" />
              <span>
                <strong>${escapeHtml(PERMISSION_COPY[perm].label)}</strong>
                <small>${escapeHtml(PERMISSION_COPY[perm].desc)}</small>
              </span>
            </label>`;
        })
        .join("");
      return `
        <div class="cas-settings__app" data-subject-card="${escapeHtml(subject.appId)}">
          <div class="cas-settings__app-head">
            <h3>${escapeHtml(subject.name)} <small class="cas-gate__note">${subject.kind}</small></h3>
            <button class="cas-btn cas-btn--danger cas-uninstall-btn" type="button"
                    data-subject="${escapeHtml(subject.appId)}" data-kind="${subject.kind}">
              Uninstall
            </button>
          </div>
          ${rows}
        </div>`;
    })
    .join("");

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
        input.checked = !input.checked; // revert the UI on failure
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
        if (kind === "plugin") {
          await uninstallPlugin(subject.replace(/^plugin:/, ""));
        } else {
          await uninstallApp(subject);
        }
        await renderPermissionTable(); // the subject just disappears from the list
      } catch (err) {
        alert(`Couldn't uninstall "${name}": ${err.message}`);
        button.disabled = false;
        button.textContent = "Uninstall";
      }
    });
  });
}

async function runUpdateCheck() {
  const button = document.getElementById("cas-check-updates");
  const results = document.getElementById("cas-update-results");
  if (!button || !results) return;

  button.disabled = true;
  results.innerHTML = `<p class="cas-gate__note">Checking…</p>`;
  try {
    const updates = await checkAllForUpdates();
    if (updates.length === 0) {
      results.innerHTML = `<p class="cas-gate__note">Everything is up to date.</p>`;
      return;
    }
    results.innerHTML = "";
    for (const update of updates) {
      results.appendChild(renderUpdateRow(update));
    }
  } catch (err) {
    results.innerHTML = `<p class="cas-gate__note">Update check failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

function renderUpdateRow(update) {
  const row = document.createElement("div");
  row.className = "cas-settings__app";
  row.innerHTML = `
    <h3>${escapeHtml(update.app.name)} <small class="cas-gate__note">v${escapeHtml(update.version)} available</small></h3>
    ${update.notes ? `<p class="cas-gate__note">${escapeHtml(update.notes)}</p>` : ""}
    <button class="cas-btn cas-btn--filled" type="button">Update</button>
  `;
  row.querySelector("button").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Verifying & installing…";
    try {
      await applyUpdate(update);
      btn.textContent = "Updated";
    } catch (err) {
      alert(`Update failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = "Update";
    }
  });
  return row;
}
