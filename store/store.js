const catalogUrl = new URL("./apps.json", import.meta.url);
const container = document.querySelector("#apps");
const manager = document.createElement("iframe");
manager.hidden = true;
manager.src = new URL("../?mode=appmgr", import.meta.url);
document.body.append(manager);
let managerReady = false;
let managerQueue = [];

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== manager.contentWindow) return;
  if (event.data?.type === "cas:appmgr-ready") {
    managerReady = true;
    managerQueue.splice(0).forEach((message) => manager.contentWindow.postMessage(message, location.origin));
  }
  if (event.data?.type === "cas:appmgr-result") {
    const button = document.querySelector(`[data-request-id="${CSS.escape(event.data.requestId || "")}"]`);
    if (button) {
      button.disabled = false;
      button.textContent = event.data.ok ? "Installed" : "Install failed";
      if (!event.data.ok) console.error("[CAS Store] CAS installation failed:", event.data.error);
    }
  }
});

function installFromCas(app) {
  if (!app?.hpk) return;
  const requestId = `${app.id || "app"}-${Date.now()}`;
  const button = document.querySelector(`[data-app="${CSS.escape(app.id || "")}"]`);
  button?.setAttribute("data-request-id", requestId);
  const message = { type: "cas:appmgr-install", requestId, url: app.hpk, filename: `${app.id || "app"}.hpk` };
  if (managerReady) manager.contentWindow.postMessage(message, location.origin);
  else managerQueue.push(message);
}

async function loadCatalog() {
  const response = await fetch(catalogUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Catalog unavailable (${response.status})`);
  const data = await response.json();
  const apps = Array.isArray(data) ? data : data.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    container.textContent = "No apps are published yet.";
    return;
  }
  container.innerHTML = apps.map((app) => `
    <article class="store-card">
      <img src="${safe(app.icon)}" alt="" onerror="this.src='./store-icon.svg'">
      <h2>${safe(app.name)}</h2>
      <p>${safe(app.description ?? "")}</p>
      <small>Version ${safe(app.version ?? "latest")}</small><br>
      <button class="store-install" data-app="${safe(app.id)}">Install</button>
      ${app.updateUrl ? `<button data-update="${safe(app.updateUrl)}">Check for updates</button>` : ""}
    </article>
  `).join("");
  const byId = new Map(apps.map((app) => [app.id, app]));
  container.querySelectorAll(".store-install").forEach((button) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Opening CAS…";
      installFromCas(byId.get(button.dataset.app));
    });
  });
  container.querySelectorAll("[data-update]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(button.dataset.update, { cache: "no-store" });
        const update = await response.json();
        button.textContent = update.version && update.hpk ? `Download ${update.version}` : "No update";
        if (update.hpk) {
          button.disabled = false;
          button.onclick = () => installFromCas({ id: "update", hpk: update.hpk });
        } else {
          button.disabled = true;
        }
      } catch (error) {
        console.error("[CAS Store] update check failed:", error);
        button.textContent = "Update check failed";
      }
    });
  });
}

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

loadCatalog().catch((error) => {
  console.error("[CAS Store] catalog load failed:", error);
  container.textContent = error.message;
});
