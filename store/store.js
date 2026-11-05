const catalogUrl = new URL("./apps.json", import.meta.url);
const container = document.querySelector("#apps");

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
      <img src="${safe(app.icon)}" alt="">
      <h2>${safe(app.name)}</h2>
      <p>${safe(app.description ?? "")}</p>
      <small>Version ${safe(app.version ?? "latest")}</small><br>
      <a href="${safe(app.hpk)}" download>Download HPK</a>
      ${app.updateUrl ? `<button data-update="${safe(app.updateUrl)}">Check update</button>` : ""}
    </article>
  `).join("");
  container.querySelectorAll("[data-update]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(button.dataset.update, { cache: "no-store" });
        const update = await response.json();
        button.textContent = update.version && update.hpk ? `Download ${update.version}` : "No update";
        if (update.hpk) {
          button.disabled = false;
          button.onclick = () => { window.location.href = update.hpk; };
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
