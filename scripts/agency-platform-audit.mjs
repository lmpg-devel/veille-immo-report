import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    agenciesCsv: "reports-experimental/agences-locales-2026-06-19.csv",
    outJson: "reports-experimental/agency-platform-audit.json",
    outCsv: "reports-experimental/agency-platform-audit.csv",
    maxAgencies: 60,
    timeoutMs: 25000
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    i += 1;
    const name = key.slice(2);
    args[name] = name === "maxAgencies" || name === "timeoutMs" ? Number(value) : value;
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
  return rows.filter((item) => item.length && item.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
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

function absoluteUrl(base, href) {
  if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept-Language": "fr-BE,fr;q=0.9,nl-BE;q=0.8,nl;q=0.7,en;q=0.6"
      }
    });
    const text = await response.text();
    return { status: response.status, url: response.url, text };
  } finally {
    clearTimeout(timer);
  }
}

function detectPlatform(url, html) {
  const haystack = `${url}\n${html}`.toLowerCase();
  const checks = [
    ["Century21", /century21\.be|century 21/],
    ["ERA", /era\.be|erabelgium|era belgium/],
    ["Dewaele", /dewaele\.com|dewaele vastgoed/],
    ["Omnicasa", /omnicasa|omnicasaassets|skynetimmo|importfrommedia/],
    ["WHISE", /whise|api\.whise\.eu|whiseapi/],
    ["Skarabee", /skarabee|contactme\.skarabee/],
    ["RealSmart", /realsmart|real smart/],
    ["SweepBright", /sweepbright/],
    ["Apimo", /apimo/],
    ["WordPress", /wp-content|wp-json|wordpress/],
    ["Wix", /wixstatic|wix\.com/],
    ["Webflow", /webflow/],
    ["Next/Gatsby", /__next_data__|webpack-runtime|gatsby/]
  ];
  return checks.filter(([, pattern]) => pattern.test(haystack)).map(([name]) => name);
}

function candidateLinks(baseUrl, html) {
  const links = [];
  const re = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html))) {
    const url = absoluteUrl(baseUrl, match[1]);
    if (!url) continue;
    if (/\.(css|js|png|jpe?g|gif|webp|svg|pdf|ico)(\?|$)/i.test(url)) continue;
    if (/(a-vendre|vente|acheter|te-koop|koop|for-sale|maison|huis|woning|pand|bien|property|immobilier|immo)/i.test(url)) {
      links.push(url);
    }
  }
  return [...new Set(links)].slice(0, 20);
}

async function sitemapCandidates(siteUrl, timeoutMs) {
  const urls = [];
  for (const sitemapPath of ["/sitemap.xml", "/sitemap/sitemap-index.xml"]) {
    try {
      const sitemapUrl = new URL(sitemapPath, siteUrl).href;
      const response = await fetchText(sitemapUrl, timeoutMs);
      if (response.status >= 400) continue;
      const matches = [...response.text.matchAll(/<loc>(.*?)<\/loc>/gi)].map((match) => match[1].trim());
      urls.push(...matches.filter((url) => /(a-vendre|vente|acheter|te-koop|koop|for-sale|maison|huis|woning|pand|bien|property|immobilier|immo)/i.test(url)));
    } catch {
      // Ignore sitemap failures; many agency sites do not expose one.
    }
  }
  return [...new Set(urls)].slice(0, 20);
}

function normalizeWebsite(website) {
  if (!website) return "";
  const trimmed = website.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function auditAgency(agency, timeoutMs) {
  const website = normalizeWebsite(agency.Website);
  if (!website) {
    return null;
  }
  try {
    const response = await fetchText(website, timeoutMs);
    const platforms = detectPlatform(response.url, response.text);
    const links = candidateLinks(response.url, response.text);
    const sitemapLinks = await sitemapCandidates(response.url, timeoutMs);
    const candidates = [...new Set([...links, ...sitemapLinks])].slice(0, 30);
    return {
      Name: agency.Name,
      Website: website,
      FinalUrl: response.url,
      Status: response.status,
      Platform: platforms.length ? platforms.join(" + ") : "Unknown",
      CandidateCount: candidates.length,
      Candidates: candidates.join(" | "),
      Phone: agency.Phone || "",
      Email: agency.Email || ""
    };
  } catch (error) {
    return {
      Name: agency.Name,
      Website: website,
      FinalUrl: "",
      Status: "ERROR",
      Platform: "Unreadable",
      CandidateCount: 0,
      Candidates: "",
      Phone: agency.Phone || "",
      Email: agency.Email || "",
      Error: error.message
    };
  }
}

async function run() {
  const args = parseArgs(process.argv);
  const agencies = parseCsv(fs.readFileSync(args.agenciesCsv, "utf8"))
    .filter((agency) => agency.Website)
    .slice(0, args.maxAgencies);
  const rows = [];
  for (const agency of agencies) {
    console.log(`Audit agence: ${agency.Name}`);
    const row = await auditAgency(agency, args.timeoutMs);
    if (row) rows.push(row);
  }
  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, agencies: rows }, null, 2), "utf8");
  writeCsv(args.outCsv, rows, ["Name", "Website", "FinalUrl", "Status", "Platform", "CandidateCount", "Candidates", "Phone", "Email", "Error"]);
  console.log(`Agency platform audit: ${rows.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
