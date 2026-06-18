import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    config: "config/veille-immo.json",
    auditCsv: "reports-experimental/agency-platform-audit.csv",
    outJson: "reports-experimental/agency-platform-listings.json",
    outCsv: "reports-experimental/agency-platform-listings.csv",
    diagnosticsJson: "reports-experimental/agency-platform-extract-diagnostics.json",
    diagnosticsCsv: "reports-experimental/agency-platform-extract-diagnostics.csv",
    maxCandidates: 200,
    timeoutMs: 25000
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    i += 1;
    const name = key.slice(2);
    args[name] = name === "maxCandidates" || name === "timeoutMs" ? Number(value) : value;
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&euro;/g, "€")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
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

function textFromHtml(html) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\s+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\s+content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function titleFromHtml(html) {
  return decodeHtml(meta(html, "og:title") || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
}

function asPrice(value) {
  const price = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(price) && price >= 50000 && price <= 2000000 ? price : null;
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  for (const item of Object.values(value)) walk(item, visit);
}

function pricesFromJsonLd(html) {
  const prices = [];
  const scripts = String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const raw = decodeHtml(script[1]).trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      walk(data, (item) => {
        const offers = item.offers;
        const offerItems = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const offer of offerItems) {
          const currency = String(offer.priceCurrency || offer.currency || "").toUpperCase();
          if (currency && currency !== "EUR") continue;
          const price = asPrice(offer.price || offer.lowPrice || offer.highPrice);
          if (price) prices.push(price);
        }
      });
    } catch {
      // Some agency sites embed invalid JSON-LD. Fall back to visible text below.
    }
  }
  return prices;
}

function priceFromText(text) {
  const source = String(text || "");
  const contextualPatterns = [
    /(?:prix|price|prijs|vraagprijs|offre|bieding)[^\d€]{0,80}(\d[\d\s.,\u00A0\u202F]{4,})\s*(?:EUR|€)?/gi,
    /(\d[\d\s.,\u00A0\u202F]{4,})\s*(?:EUR|€)/gi
  ];
  for (const pattern of contextualPatterns) {
    const matches = [...source.matchAll(pattern)]
      .map((match) => asPrice(match[1]))
      .filter(Boolean);
    if (matches.length) return matches[0];
  }
  return null;
}

function priceFromHtml(html, text) {
  const structuredPrices = pricesFromJsonLd(html);
  if (structuredPrices.length) return structuredPrices[0];
  return priceFromText(text);
}

function shortHash(value) {
  let h1 = 0x811c9dc5;
  for (const char of String(value)) {
    h1 ^= char.charCodeAt(0);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0");
}

function candidateUrls(auditRows) {
  const rows = [];
  for (const agency of auditRows) {
    const raw = agency.Candidates || "";
    for (const url of raw.split(/\s+\|\s+/).map((item) => decodeHtml(item.trim())).filter(Boolean)) {
      if (!looksLikeDetail(url)) continue;
      rows.push({ agency, url: url.replace(/#.*$/, "") });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.url.replace(/\?.*$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeDetail(url) {
  if (/\.(xml|json|css|js|png|jpe?g|gif|webp|svg|pdf|docx?)(\?|$)/i.test(url)) return false;
  if (/(facebook|twitter|pinterest|whatsapp|instagram|ipi\.be|webulous|mason\.immo|immoscoop)/i.test(url)) return false;
  if (/(feed|wp-json|xmlrpc|sitemap|oembed|login|contact|estimation|jobs|blog|actualite|nieuws|cookie|privacy|mentions|services|notre-agence|over-ons)/i.test(url)) return false;
  if (/(appartement|apartment|studio|garage|parking|commerce|commercial|kantoor|bureau|terrain|grond|loods|horeca|studentenkamer)/i.test(url)) return false;

  const detailPatterns = [
    /\/fr\/bien\/a-vendre\/(?:maison|villa|immeuble[^/]*)\/[^/]+\/\d+/i,
    /\/nl\/pand\/te-koop\/(?:huis|woning|villa|opbrengst[^/]*)\/[^/]+\/\d+/i,
    /\/detail\/vente-(?:villa-maison|maison|huis|woning|immeuble|opbrengst)/i,
    /\/aanbod\/\d+\/(?:huis|woning|villa|.*koop)/i,
    /\/properties\/[^/]*(?:maison|villa|house|immeuble)[^/]*\//i,
    /\/fr\/l\/a-vendre\/(?:maison|immeuble-de-rapport|villa)\/[^/]+\/lis_/i,
    /\/biens\/[^/]*(?:maison|villa|house)[^/]*a-vendre/i
  ];
  return detailPatterns.some((pattern) => pattern.test(url));
}

function findLocation(config, url, title, text) {
  const haystack = `${url}\n${title}\n${text.slice(0, 3000)}`.toLowerCase();
  for (const location of config.locations || []) {
    if (!location.postalCode) continue;
    const postalPattern = new RegExp(`(^|\\D)${location.postalCode}(\\D|$)`);
    if (postalPattern.test(haystack)) return location;
  }
  for (const location of config.locations || []) {
    const names = [
      location.name,
      location.immowebSlug,
      location.zimmoSlug,
      location.immovlanSlug,
      location.postalCode
    ].filter(Boolean).map((item) => String(item).toLowerCase());
    if (names.some((name) => haystack.includes(name))) {
      return location;
    }
  }
  return null;
}

function bedroomsFromText(text) {
  return (String(text || "").match(/(\d+)\s*(?:chambres?|slaapkamers?|bedrooms?|ch\.|slpk)/i) || [])[1] || "";
}

function surfaceFromText(text) {
  const source = String(text || "");
  const patterns = [
    /(?:surface|habitable|woonoppervlakte|bewoonbare|living area)[^\d]{0,80}(\d{2,4})\s*m(?:²|2|\b)/i,
    /(\d{2,4})\s*m(?:²|2|\b)[^\n.]{0,60}(?:habitable|woonoppervlakte|bewoonbare|living area)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[1] || "";
  }
  return "";
}

async function extractCandidate(config, agency, url, timeoutMs) {
  const response = await fetchText(url, timeoutMs);
  const html = response.text;
  const title = titleFromHtml(html) || agency.Name;
  const text = textFromHtml(html);
  const joined = `${title}\n${meta(html, "og:description")}\n${text}`;
  const price = priceFromHtml(html, joined);
  const maxPrice = Number(config.maxPrice || 285000);

  if (!price || price > maxPrice) {
    return {
      listing: null,
      diagnostic: {
        Agency: agency.Name,
        Platform: agency.Platform,
        Status: "Ignored",
        Message: price ? `Prix ${price} superieur au plafond` : "Prix absent",
        Url: response.url || url
      }
    };
  }

  if (/(appartement|apartment|studio|garage|parking|commerce|commercial|terrain|grond|kantoor|bureau)/i.test(`${title}\n${url}`)) {
    return {
      listing: null,
      diagnostic: {
        Agency: agency.Name,
        Platform: agency.Platform,
        Status: "Ignored",
        Message: "Type explicitement exclu",
        Url: response.url || url
      }
    };
  }

  if (!/(maison|huis|woning|villa|immeuble|rapport|house)/i.test(`${title}\n${url}\n${text.slice(0, 5000)}`)) {
    return {
      listing: null,
      diagnostic: {
        Agency: agency.Name,
        Platform: agency.Platform,
        Status: "Ignored",
        Message: "Type de bien non maison",
        Url: response.url || url
      }
    };
  }

  const location = findLocation(config, response.url || url, title, text);
  const image = meta(html, "og:image");
  const finalUrl = response.url || url;
  const platformLabel = agency.Platform && agency.Platform !== "Unknown" ? agency.Platform : "site direct";
  const bedrooms = bedroomsFromText(joined);
  const surface = surfaceFromText(joined);
  const surfaceNumber = Number(surface);
  const bedroomsNumber = Number(bedrooms);
  const safeSurface = surface && !(surfaceNumber < 50 && bedroomsNumber >= 3) ? surface : "";
  return {
    listing: {
      Source: `Agence locale (${platformLabel})`,
      Id: shortHash(`${agency.Name}|${finalUrl}`),
      RequestedLocation: location?.name || "Agences locales",
      Locality: location?.name || "",
      PostalCode: location?.postalCode || "",
      Address: "",
      Latitude: location?.latitude || "",
      Longitude: location?.longitude || "",
      GeoPrecision: location ? "centre commune - agence experimental" : "a verifier - agence experimental",
      Price: price,
      Bedrooms: bedrooms,
      SurfaceM2: safeSurface,
      AgentName: agency.Name,
      AgentPhone: agency.Phone || "",
      AgentMobile: "",
      AgentEmail: agency.Email || "",
      AgentWebsite: agency.Website || "",
      PhotoCount: image ? 1 : 0,
      PhotoUrls: image || "",
      Title: title,
      Url: finalUrl
    },
    diagnostic: {
      Agency: agency.Name,
      Platform: agency.Platform,
      Status: "Listing",
      Message: `${price} EUR`,
      Url: finalUrl
    }
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const auditRows = parseCsv(fs.readFileSync(args.auditCsv, "utf8"));
  const candidates = candidateUrls(auditRows).slice(0, args.maxCandidates);
  const listings = [];
  const diagnostics = [];

  for (const { agency, url } of candidates) {
    console.log(`Extract agence: ${agency.Name} -> ${url}`);
    try {
      const { listing, diagnostic } = await extractCandidate(config, agency, url, args.timeoutMs);
      diagnostics.push(diagnostic);
      if (listing) listings.push(listing);
    } catch (error) {
      diagnostics.push({
        Agency: agency.Name,
        Platform: agency.Platform,
        Status: "Error",
        Message: error.message,
        Url: url
      });
    }
  }

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify({ generatedAt: new Date().toISOString(), count: listings.length, listings }, null, 2), "utf8");
  fs.writeFileSync(args.diagnosticsJson, JSON.stringify({ generatedAt: new Date().toISOString(), count: diagnostics.length, diagnostics }, null, 2), "utf8");
  writeCsv(args.outCsv, listings, [
    "Source", "Id", "RequestedLocation", "Locality", "PostalCode", "Address", "Latitude", "Longitude",
    "GeoPrecision", "Price", "Bedrooms", "SurfaceM2", "AgentName", "AgentPhone", "AgentMobile",
    "AgentEmail", "AgentWebsite", "PhotoCount", "PhotoUrls", "Title", "Url"
  ]);
  writeCsv(args.diagnosticsCsv, diagnostics, ["Agency", "Platform", "Status", "Message", "Url"]);
  console.log(`Agency listings: ${listings.length}`);
  console.log(`Agency diagnostics: ${diagnostics.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
