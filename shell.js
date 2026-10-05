/**
 * shell.js
 * -----------------------------------------------------------------------
 * Renders the persistent chrome once casf is ready: the starfield
 * backdrop and a left sidebar (brand, Home, Install, Settings), with a
 * `<main>` content slot that launcher.js / settings-app.js render into
 * instead of owning the whole page. Switching between Home and Settings
 * is then just "render different content into the same slot" — the
 * sidebar itself never unmounts.
 * -----------------------------------------------------------------------
 */

/**
 * @param {HTMLElement} root
 * @param {{ onHome: () => void, onInstall?: () => void, onSettings?: () => void, brandIconSrc?: string }} opts
 * @returns {{ main: HTMLElement, setActive: (name: "home"|"settings") => void }}
 */
export function mountShell(root, { onHome, onInstall, onSettings, brandIconSrc = "./icons/CAS-96.png" } = {}) {
  root.innerHTML = `
    <div class="cas-space-bg" aria-hidden="true"></div>
    <div class="cas-shell">
      <nav class="cas-sidebar">
        <div class="cas-sidebar__brand"><img src="${brandIconSrc}" alt="" /></div>
        <button class="cas-sidebar__btn" data-nav="home" title="Home" aria-current="true">⌂</button>
        ${onInstall ? `<button class="cas-sidebar__btn" data-nav="install" title="Install package">﹢</button>` : ""}
        <div class="cas-sidebar__spacer"></div>
        ${onSettings ? `<button class="cas-sidebar__btn" data-nav="settings" title="Settings">⚙</button>` : ""}
      </nav>
      <main class="cas-main" id="cas-main"></main>
    </div>
  `;

  const handlers = { home: onHome, install: onInstall, settings: onSettings };
  const buttons = [...root.querySelectorAll("[data-nav]")];

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const name = btn.dataset.nav;
      if (name === "home" || name === "settings") setActive(name);
      handlers[name]?.();
    });
  }

  function setActive(name) {
    for (const btn of buttons) {
      if (btn.dataset.nav === "home" || btn.dataset.nav === "settings") {
        btn.setAttribute("aria-current", String(btn.dataset.nav === name));
      }
    }
  }

  return { main: root.querySelector("#cas-main"), setActive };
}
