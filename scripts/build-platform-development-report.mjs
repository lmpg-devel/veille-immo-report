import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    baseCsv: "reports-experimental/veille-immo-2026-06-19.csv",
    agencyCsv: "reports-experimental/agency-platform-listings.csv",
    browserDiagnosticsCsv: "reports-experimental/browser-source-diagnostics.csv",
    agencyDiagnosticsCsv: "reports-experimental/agency-platform-extract-diagnostics.csv",
    auditCsv: "reports-experimental/agency-platform-audit.csv",
    outHtml: "reports-experimental/platform-development.html",
    outCsv: "reports-experimental/multi-source-development.csv",
    outJson: "reports-experimental/multi-source-development.json"
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    i += 1;
    args[key.slice(2)] = value;
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows
    .filter((item) => item.length && item.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asNumber(value) {
  const number = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function formatPrice(value) {
  const number = asNumber(value);
  return number ? `${number.toLocaleString("fr-BE")} EUR` : "Prix non lu";
}

function splitPhotos(value) {
  return String(value || "")
    .split(/\s+\|\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeListing(row, origin) {
  return {
    ...row,
    Origin: origin,
    PriceNumber: asNumber(row.Price),
    SortLocality: String(row.Locality || row.RequestedLocation || "").toLowerCase()
  };
}

function dedupeListings(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.Url || `${row.Source}|${row.Id}`).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function card(row) {
  const photos = splitPhotos(row.PhotoUrls);
  const media = photos.length
    ? photos.map((url) => `<button class="photoButton" type="button" data-full="${htmlEscape(url)}"><img src="${htmlEscape(url)}" alt=""></button>`).join("")
    : `<div class="noPhoto">Photo non lue</div>`;
  const contactParts = [row.AgentPhone, row.AgentMobile, row.AgentEmail].filter(Boolean);
  const contact = contactParts.length ? contactParts.map(htmlEscape).join(" · ") : "Contact non lu";
  const sourceClass = String(row.Source || "").includes("Agence locale") ? "agency" : "portal";
  return `
    <article class="listing ${sourceClass}">
      <div class="photos">${media}</div>
      <div class="body">
        <div class="topline">
          <span class="pill">${htmlEscape(row.Source || "Source")}</span>
          <strong>${formatPrice(row.Price)}</strong>
        </div>
        <h2>${htmlEscape(row.Title || "Annonce")}</h2>
        <p class="meta">${htmlEscape(row.Locality || row.RequestedLocation || "Commune à vérifier")} · ${htmlEscape(row.Bedrooms || "?")} ch. · ${htmlEscape(row.SurfaceM2 || "?")} m2</p>
        <p class="address">${htmlEscape(row.Address || row.GeoPrecision || "Adresse non publiée")}</p>
        <div class="contact">
          <strong>${htmlEscape(row.AgentName || "Agent non lu")}</strong><br>
          ${contact}
        </div>
        <div class="actions">
          <a href="${htmlEscape(row.Url)}" target="_blank" rel="noopener noreferrer">Ouvrir l'annonce</a>
          ${row.AgentWebsite ? `<a href="${htmlEscape(row.AgentWebsite)}" target="_blank" rel="noopener noreferrer">Site agence</a>` : ""}
        </div>
      </div>
    </article>`;
}

function diagnosticsTable(rows, columns) {
  if (!rows.length) return "<p>Aucun diagnostic.</p>";
  return `<div class="tableWrap"><table><thead><tr>${columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((row) => `<tr>${columns.map((column) => `<td>${htmlEscape(row[column])}</td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}

function platformSummary(auditRows) {
  const counts = new Map();
  let candidates = 0;
  for (const row of auditRows) {
    const platform = row.Platform || "Unknown";
    counts.set(platform, (counts.get(platform) || 0) + 1);
    candidates += asNumber(row.CandidateCount);
  }
  const items = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => `<span>${htmlEscape(platform)} <strong>${count}</strong></span>`)
    .join("");
  return { candidates, html: items || "<span>Aucune agence auditee</span>" };
}

function render(args, data) {
  const generatedAt = new Date().toLocaleString("fr-BE", { timeZone: "Europe/Brussels" });
  const browserBlocked = data.browserDiagnostics.filter((row) => /blocage/i.test(row.status || row.Status || "")).length;
  const agencyKept = data.agencyListings.length;
  const summary = platformSummary(data.auditRows);
  const cards = data.combined
    .sort((a, b) => a.PriceNumber - b.PriceNumber || a.SortLocality.localeCompare(b.SortLocality))
    .map(card)
    .join("");

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Développement sources multi-sites</title>
  <style>
    :root { color-scheme: light; --ink:#172026; --muted:#62707a; --line:#d9e0e6; --bg:#f4f6f8; --panel:#fff; --accent:#0b6f8f; --agency:#8b4a12; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial, Helvetica, sans-serif; background:var(--bg); color:var(--ink); line-height:1.35; }
    main { width:min(1120px, 100%); margin:0 auto; padding:22px; }
    h1 { margin:0 0 6px; font-size:clamp(26px, 5vw, 42px); letter-spacing:0; }
    h2 { margin:10px 0 7px; font-size:18px; letter-spacing:0; }
    h3 { margin:26px 0 12px; font-size:21px; letter-spacing:0; }
    p { margin:0 0 10px; }
    a { color:#075a78; text-decoration:none; font-weight:700; }
    a:hover { text-decoration:underline; }
    .note { background:#fff7db; border:1px solid #e6d284; padding:12px; margin:18px 0; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; margin:18px 0; }
    .metric { background:var(--panel); border:1px solid var(--line); padding:14px; border-radius:8px; }
    .metric span { display:block; color:var(--muted); font-size:13px; }
    .metric strong { display:block; font-size:28px; margin-top:4px; }
    .platforms { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .platforms span, .pill { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line); background:#eef5f8; color:#17485a; border-radius:999px; padding:5px 8px; font-size:12px; }
    .listings { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
    .listing { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .listing.agency { border-color:#d8b98e; }
    .photos { display:flex; gap:4px; overflow-x:auto; background:#172026; min-height:176px; }
    .photoButton { border:0; padding:0; background:transparent; flex:0 0 72%; cursor:pointer; }
    .photoButton img { width:100%; height:176px; display:block; object-fit:cover; }
    .noPhoto { min-height:176px; width:100%; display:grid; place-items:center; color:#c8d2d9; font-weight:700; }
    .body { padding:12px; }
    .topline { display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .topline strong { white-space:nowrap; }
    .meta, .address { color:var(--muted); font-size:14px; }
    .contact { background:#eef2f4; padding:10px; border-radius:6px; margin-top:10px; overflow-wrap:anywhere; }
    .actions { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; }
    details { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin-top:12px; padding:12px; }
    summary { cursor:pointer; font-weight:700; }
    .tableWrap { overflow-x:auto; margin-top:10px; }
    table { border-collapse:collapse; width:100%; min-width:760px; font-size:13px; }
    th, td { border-bottom:1px solid var(--line); text-align:left; padding:8px; vertical-align:top; }
    th { background:#eef2f4; }
    .modal { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.86); padding:18px; z-index:10; }
    .modal.open { display:flex; }
    .modal img { max-width:100%; max-height:82vh; object-fit:contain; }
    .modal button { position:fixed; top:14px; left:14px; border:0; border-radius:999px; padding:10px 14px; font-weight:700; background:#fff; color:#172026; }
    @media (max-width: 760px) {
      main { padding:16px; }
      .grid, .listings { grid-template-columns:1fr; }
      .photoButton { flex-basis:82%; }
      .topline { align-items:flex-start; flex-direction:column; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Développement sources multi-sites</h1>
    <p>Shot expérimental généré le ${htmlEscape(generatedAt)}. Le rapport stable n'est pas modifié.</p>
    <div class="note">
      Zimmo et Immovlan sont testés en mode navigateur Chrome headless. Les agences locales sont auditées par plateforme, puis filtrées en maisons à vendre sous le plafond configuré.
    </div>

    <section class="grid" aria-label="Résumé">
      <div class="metric"><span>Annonces Immoweb conservées</span><strong>${data.baseListings.length}</strong></div>
      <div class="metric"><span>Annonces agences ajoutables</span><strong>${agencyKept}</strong></div>
      <div class="metric"><span>Agences auditées</span><strong>${data.auditRows.length}</strong></div>
      <div class="metric"><span>Blocages navigateur</span><strong>${browserBlocked}/${data.browserDiagnostics.length}</strong></div>
    </section>

    <section>
      <h3>Plateformes agences détectées</h3>
      <p>${summary.candidates} lien(s) candidat(s) repérés avant filtrage détail.</p>
      <div class="platforms">${summary.html}</div>
    </section>

    <section>
      <h3>Annonces homogènes</h3>
      <div class="listings">${cards || "<p>Aucune annonce à afficher.</p>"}</div>
    </section>

    <section>
      <h3>Diagnostics</h3>
      <details open>
        <summary>Zimmo / Immovlan</summary>
        ${diagnosticsTable(data.browserDiagnostics, ["source", "location", "status", "HttpStatus", "Title", "message"])}
      </details>
      <details>
        <summary>Extraction agences</summary>
        ${diagnosticsTable(data.agencyDiagnostics, ["Agency", "Platform", "Status", "Message", "Url"])}
      </details>
    </section>
  </main>

  <div class="modal" id="imageModal" role="dialog" aria-modal="true" aria-label="Photo">
    <button type="button" id="closeModal">Retour</button>
    <img id="modalImage" alt="">
  </div>
  <script>
    const modal = document.getElementById("imageModal");
    const modalImage = document.getElementById("modalImage");
    document.querySelectorAll(".photoButton").forEach((button) => {
      button.addEventListener("click", () => {
        modalImage.src = button.dataset.full;
        modal.classList.add("open");
      });
    });
    document.getElementById("closeModal").addEventListener("click", () => modal.classList.remove("open"));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.classList.remove("open");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") modal.classList.remove("open");
    });
  </script>
</body>
</html>`;
}

async function run() {
  const args = parseArgs(process.argv);
  const baseListings = readCsv(args.baseCsv).map((row) => normalizeListing(row, "Immoweb"));
  const agencyListings = readCsv(args.agencyCsv).map((row) => normalizeListing(row, "Agence locale"));
  const combined = dedupeListings([...baseListings, ...agencyListings]);
  const browserDiagnostics = readCsv(args.browserDiagnosticsCsv);
  const agencyDiagnostics = readCsv(args.agencyDiagnosticsCsv);
  const auditRows = readCsv(args.auditCsv);

  const columns = [
    "Source", "Id", "RequestedLocation", "Locality", "PostalCode", "Address", "Latitude", "Longitude",
    "GeoPrecision", "Price", "Bedrooms", "SurfaceM2", "AgentName", "AgentPhone", "AgentMobile",
    "AgentEmail", "AgentWebsite", "PhotoCount", "PhotoUrls", "Title", "Url"
  ];
  writeCsv(args.outCsv, combined, columns);
  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseCount: baseListings.length,
    agencyCount: agencyListings.length,
    combinedCount: combined.length,
    browserDiagnostics,
    agencyDiagnostics,
    listings: combined
  }, null, 2), "utf8");
  fs.mkdirSync(path.dirname(args.outHtml), { recursive: true });
  fs.writeFileSync(args.outHtml, render(args, {
    baseListings,
    agencyListings,
    combined,
    browserDiagnostics,
    agencyDiagnostics,
    auditRows
  }), "utf8");

  console.log(`Development report: ${args.outHtml}`);
  console.log(`Combined listings: ${combined.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
