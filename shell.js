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
  const icons = {
    home: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/><path d="M9 20h6"/></svg>`,
    install: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M5 20h14"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>`,
  };
  root.innerHTML = `
    <div class="cas-space-bg" aria-hidden="true"></div>
    <div class="cas-shell">
      <nav class="cas-sidebar">
        <div class="cas-sidebar__brand"><img src="${brandIconSrc}" alt="" /></div>
        <button class="cas-sidebar__btn" data-nav="home" title="Home" aria-current="true">${icons.home}</button>
        ${onInstall ? `<button class="cas-sidebar__btn" data-nav="install" title="Install package">${icons.install}</button>` : ""}
        <div class="cas-sidebar__spacer"></div>
        ${onSettings ? `<button class="cas-sidebar__btn" data-nav="settings" title="Settings">${icons.settings}</button>` : ""}
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
