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

/** Replaces `root`'s content with the Settings screen. `onClose` re-renders whatever was there before. */
export async function openSettingsApp(root, onClose) {
  root.innerHTML = `
    <div class="cas-launcher cas-settings">
      <div class="cas-launcher__bar">
        <button class="cas-btn cas-btn--text cas-settings__back" type="button">← Back</button>
        <h1 class="cas-settings__title">Settings</h1>
      </div>

      <section class="cas-settings__section">
        <h2>Permissions</h2>
        <p class="cas-gate__note">What each installed app or plugin is allowed to do.</p>
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
        <div class="cas-settings__app">
          <h3>${escapeHtml(subject.name)} <small class="cas-gate__note">${subject.kind}</small></h3>
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
