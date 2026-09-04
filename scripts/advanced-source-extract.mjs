import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = "config/veille-immo.json";
const DEFAULT_RESULTS = "publish/veille-immo-report/results.json";
const DEFAULT_OUT = "reports-experimental/advanced-source-results.json";
const USER_AGENT = "Mozilla/5.0 veille-immo-advanced/1.0";
const APIFY_API_BASE = "https://api.apify.com/v2";
const DEFAULT_ZIMMO_APIFY_ACTOR_ID = "dz_omar~zimmo-scraper";
let fetchTimeoutMs = 12000;

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    baseResults: DEFAULT_RESULTS,
    outJson: DEFAULT_OUT,
    sources: "immovlan,2ememain,zimmo-apify",
    propertyType: "",
    maxPrice: 0,
    maxPerLocation: 12,
    delayMs: 350,
    apifyToken: process.env.APIFY_TOKEN || "",
    apifyZimmoActorId: process.env.APIFY_ZIMMO_ACTOR_ID || DEFAULT_ZIMMO_APIFY_ACTOR_ID,
    apifyZimmoInput: process.env.APIFY_ZIMMO_INPUT_PATH || "",
    apifyZimmoInputJson: process.env.APIFY_ZIMMO_INPUT_JSON || "",
    apifyZimmoStartUrls: process.env.APIFY_ZIMMO_START_URLS || "",
    apifyWaitSecs: 60,
    apifyPollSecs: 20,
    apifyRunTimeoutMs: 600000,
    apifyDatasetLimit: 500,
    apifyMaxResultsPerUrl: 10,
    agencyCsv: process.env.AGENCY_SITES_CSV || "",
    agencyMaxSites: 30,
    agencyMaxCandidatesPerSite: 8,
    agencyConcurrency: 4,
    agencyIndexPaths: process.env.AGENCY_INDEX_PATHS || "",
    fetchTimeoutMs
  };
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  args.maxPerLocation = Number(args.maxPerLocation || 12);
  args.delayMs = Number(args.delayMs || 350);
  args.maxPrice = Number(args.maxPrice || 0);
  args.apifyWaitSecs = Number(args.apifyWaitSecs || 60);
  args.apifyPollSecs = Number(args.apifyPollSecs || 20);
  args.apifyRunTimeoutMs = Number(args.apifyRunTimeoutMs || 600000);
  args.apifyDatasetLimit = Number(args.apifyDatasetLimit || 500);
  args.apifyMaxResultsPerUrl = Number(args.apifyMaxResultsPerUrl || 10);
  args.agencyMaxSites = Number(args.agencyMaxSites || 30);
  args.agencyMaxCandidatesPerSite = Number(args.agencyMaxCandidatesPerSite || 8);
  args.agencyConcurrency = Math.max(1, Number(args.agencyConcurrency || 4));
  args.fetchTimeoutMs = Number(args.fetchTimeoutMs || fetchTimeoutMs);
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCharCode(parseInt(number, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function textFromHtml(html) {
  return decodeHtml(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function getFirstMatch(text, regex) {
  const match = String(text || "").match(regex);
  return match ? match[1] : "";
}

async function fetchPage(url, referer = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-BE,fr;q=0.9,nl;q=0.8",
    "Connection": "close"
  };
  try {
    if (referer) headers.Referer = referer;
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { text, finalUrl: response.url || url, status: response.status };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timeout ${fetchTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, referer = "") {
  const page = await fetchPage(url, referer);
  return page.text;
}

function normalizeImageUrl(url) {
  let value = decodeHtml(url || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) value = "https:" + value;
  value = value.replace("$_#.jpg", "$_83.jpg").replace("$_#", "$_83");
  return value;
}

function imageIdentityKey(url) {
  const value = normalizeImageUrl(url);
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const imageMatch = parsed.pathname.match(/\/images\/([^/]+)\//i);
    if (imageMatch) return `image:${imageMatch[1].toLowerCase()}`;
    return `${parsed.origin}${parsed.pathname}`
      .replace(/\/(?:thumbnail-webp\/[^/?#]+|gallery-like-image\/[^?#]+)$/i, "")
      .toLowerCase();
  } catch {
    return value.replace(/[?#].*$/, "").toLowerCase();
  }
}

function dedupeImageUrls(urls) {
  const normalized = (urls || []).map(normalizeImageUrl).filter(Boolean);
  const hasImmovlanImages = normalized.some((url) => /api-image\.immovlan\.be\/v1\/property\/[^/]+\/images\//i.test(url));
  const candidates = hasImmovlanImages
    ? normalized.filter((url) => !/api-image\.immovlan\.be\/v1\/property\/[^/]+\/(?:thumbnail-webp|gallery-like-image)\//i.test(url))
    : normalized;
  const seen = new Set();
  return candidates.filter((url) => {
    const key = imageIdentityKey(url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

function sourceLabel(source) {
  return source === "2ememain" ? "2ememain" : source === "immovlan" ? "Immovlan" : source;
}

function shortId(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

function badHouseText(text) {
  const haystack = normalizedWords(text);
  return /\b(appartement|apparemment|appartementen|apartment|flat|studio|studios|garage|garages|garagebox|parking|staanplaats|box|terrain|terrein|grond|bouwgrond|kot|kamer|chambre|room|commercial|commerce|handelspand|handelsruimte|bureau|kantoor|entrepot|magazijn|hangar|loft|duplex|mur uniquement)\b/i.test(haystack);
}

function isLandSearch(config) {
  return String(config?.propertyType || "").trim().toLowerCase() === "terrain";
}

function hasBuildingLandSignal(text) {
  const haystack = normalizedWords(text);
  return /\b(terrain a batir|terrain constructible|building land|building plot|bouwgrond|bouwperceel|bouwterrein|grond voor woningbouw|parcelle a batir|lot a batir)\b/i.test(haystack);
}

function badBuildingLandText(text) {
  const haystack = normalizedWords(text);
  return /\b(terrain agricole|terre agricole|prairie|pature|champ|bois|foret|terrain forestier|terrain de loisirs|non batissable|non constructible|agricultural land|farmland|meadow|forest land|recreational land|landbouwgrond|weiland|bosgrond|recreatiegrond|niet bebouwbaar|garage|garages|garagebox|parking|staanplaats|box|bureau|office|kantoor|commerce|commercial|handelspand|handelsruimte|maison|huis|woning|villa|appartement|apartment|flat|studio)\b/i.test(haystack);
}

function isNotarial(text) {
  const haystack = normalizedWords(text);
  return /\b(biddit|notaire|notaires|notaris|notarissen|vente publique|openbare verkoop)\b/i.test(haystack);
}

function normalizedWords(text) {
  return slug(text).replace(/-/g, " ");
}

function hasHouseSignal(text) {
  const haystack = normalizedWords(text);
  return /\b(maison|maisons|house|houses|huis|woning|woningen|villa|bungalow|bel etage|rijwoning|eengezinswoning|halfopen|fermette|habitation)\b/i.test(haystack);
}

function isRentalText(text) {
  const haystack = normalizedWords(text);
  return /\b(a louer|louer|location|te huur|huur|huurwoning|for rent|rent)\b/i.test(haystack);
}

function hasMonthlySupplementText(text) {
  const raw = String(text || "");
  const haystack = normalizedWords(raw);
  return /\b(viager|lijfrente|rente viagere|rente|bouquet|mensualite|mensualites|maandelijkse|emphyteose|erfpacht)\b/i.test(haystack)
    || /\+\s*\d[\d\s.,]*(?:eur|euro|\u20ac)?\s*\/?\s*(?:mois|maand|month)/i.test(raw);
}

function isUnderOptionText(text) {
  const raw = String(text || "");
  const haystack = normalizedWords(raw);
  return /\b(sous option|vendu sous option|onder optie|under option|sale agreed|reserved|reserve|reservee|compromis)\b/i.test(haystack)
    || /\b(sous[-\s]?option|onder\s+optie|under\s+option|sale\s+agreed|r(?:e|é)serv(?:e|é|ee|ée)|compromis)\b/i.test(raw);
}

function sourceQualityRejectionReason(source, fields, location, config) {
  const price = Number(fields.price || 0);
  const maxPrice = Number(config.maxPrice || 285000);
  const haystack = [
    fields.title,
    fields.description,
    fields.category,
    fields.locality,
    fields.url
  ].filter(Boolean).join(" ");
  const identityText = [
    fields.title,
    fields.category,
    fields.url
  ].filter(Boolean).join(" ");
  const signalText = [
    fields.title,
    fields.description,
    fields.category,
    fields.url
  ].filter(Boolean).join(" ");

  if (!price || price > maxPrice) return `prix ${price || "absent"} hors filtre`;
  if (!isLandSearch(config) && price < 50000) return `prix ${price} sous seuil coherent`;
  if (config.excludeNotarialSales !== false && isNotarial(haystack)) return "vente notariale exclue";
  if (isRentalText(haystack)) return "location exclue";
  if (hasMonthlySupplementText(haystack)) return "viager/rente/mensualite exclu";
  if (isLandSearch(config)) {
    if (badBuildingLandText(haystack)) return "terrain non constructible probable";
    if (!hasBuildingLandSignal(signalText)) return "signal terrain a batir absent";
  } else {
    if (badHouseText(identityText)) return "type non maison probable";
    if (!hasHouseSignal(signalText)) return "signal maison absent";
  }
  if (location && source === "2ememain" && !locationMatches(location, [fields.url, fields.title])) {
    return `commune absente du titre/url; vendeur ${fields.locality || "sans localite"}`;
  }
  if (location && source !== "2ememain" && !locationMatches(location, [fields.locality, fields.postalCode, fields.street, fields.url, fields.title])) {
    return "commune cible absente";
  }
  return "";
}

function locationMatches(location, fields) {
  const haystack = slug(fields.filter(Boolean).join(" "));
  const needles = [location.name, location.postalCode, location.immowebSlug, location.immovlanSlug, location.zimmoSlug]
    .filter(Boolean)
    .map(slug)
    .filter(Boolean);
  return needles.some((needle) => haystack.includes(needle));
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const digits = String(value).replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function cleanText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return cleanText(value.find((item) => cleanText(item)));
  if (typeof value === "object") {
    return cleanText(value.name || value.title || value.label || value.value || value.text || "");
  }
  return decodeHtml(String(value)).replace(/\s+/g, " ").trim();
}

function getPath(object, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, part) => {
    if (current == null) return undefined;
    return current[part];
  }, object);
}

function firstField(object, paths) {
  for (const fieldPath of paths) {
    const value = typeof fieldPath === "function" ? fieldPath(object) : getPath(object, fieldPath);
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return "";
}

function numberFromAny(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object") {
    return numberFromAny(firstField(value, ["amount", "value", "price", "raw", "formatted"]));
  }
  const match = String(value).match(/\d[\d\s.,]*/);
  if (!match) return null;
  const compact = match[0].replace(/\s+/g, "");
  const thousandsOrDecimal = compact.match(/^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/);
  const plainDecimal = compact.match(/^\d+[.,]\d{1,2}$/);
  const normalized = thousandsOrDecimal
    ? compact.replace(/[.,](?=\d{3}([.,]|$))/g, "").replace(",", ".")
    : plainDecimal
      ? compact.replace(",", ".")
      : compact.replace(/[^\d]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function floatFromAny(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const number = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function collectImageUrls(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrls(item, output));
    return output;
  }
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (typeof value === "object") {
    ["url", "src", "href", "large", "medium", "small", "base", "original"].forEach((key) => collectImageUrls(value[key], output));
  }
  return output;
}

function parseJsonLdObjects(html) {
  const objects = [];
  const regex = /<script[^>]+type=["']application\/ld(?:\+|&#x2B;)json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(regex)) {
    const raw = decodeHtml(match[1]).trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) objects.push(...parsed);
      else objects.push(parsed);
    } catch {
      // Ignore malformed analytics/schema blocks.
    }
  }
  return objects;
}

function findJsonLd(objects, type) {
  return objects.find((item) => String(item && item["@type"] || "").trim().toLowerCase() === type.toLowerCase()) || null;
}

function publicationDateInfo(value, source) {
  const raw = cleanText(value);
  return raw ? { publicationDate: raw, publicationDateSource: source } : { publicationDate: null, publicationDateSource: "" };
}

function splitList(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text || "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      if (row.some((item) => String(item || "").trim())) rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((item) => String(item || "").trim())) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => String(header || "").trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function latestAgencyCsvPath() {
  const reportsDir = path.resolve("reports");
  if (!fs.existsSync(reportsDir)) return "";
  const files = fs.readdirSync(reportsDir)
    .filter((name) => /^agences-locales-\d{4}-\d{2}-\d{2}\.csv$/i.test(name))
    .map((name) => {
      const filePath = path.join(reportsDir, name);
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter((item) => item.size > 500)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.filePath || "";
}

function normalizeWebsite(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (/^(mailto|tel|javascript):/i.test(raw)) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function hostKey(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isPortalHost(url) {
  const host = hostKey(url);
  return /(^|\.)immoweb\.be$|(^|\.)immovlan\.be$|(^|\.)vlan\.be$|(^|\.)zimmo\.be$|(^|\.)2ememain\.be$/i.test(host);
}

function isSameAgencyHost(url, baseUrl) {
  const host = hostKey(url);
  const baseHost = hostKey(baseUrl);
  return Boolean(host && baseHost && (host === baseHost || host.endsWith(`.${baseHost}`) || baseHost.endsWith(`.${host}`)));
}

function normalizeLinkUrl(url, baseUrl) {
  try {
    const parsed = new URL(decodeHtml(url), baseUrl);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function extractLinks(html, baseUrl) {
  return [...String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => normalizeLinkUrl(match[1], baseUrl))
    .filter(Boolean);
}

function urlDescriptor(url) {
  try {
    const parsed = new URL(url);
    return normalizedWords(`${decodeURIComponent(parsed.pathname)} ${decodeURIComponent(parsed.search || "")}`);
  } catch {
    return normalizedWords(url);
  }
}

function isBlockedAssetUrl(url) {
  return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|pdf|zip|rar|mp4|webm|woff2?|ttf|eot)(?:[?#].*)?$/i.test(url);
}

function agencyCandidateScore(url) {
  const descriptor = urlDescriptor(url);
  if (!descriptor || isBlockedAssetUrl(url) || isPortalHost(url)) return 0;
  if (/\b(contact|privacy|cookies?|mentions|conditions|login|admin|wp json|feed|tag|category|author|estimation|estimate|valuation|syndic|jobs?|carrieres?|vacatures?|about|over ons|team|kantoor|agence|agents?)\b/i.test(descriptor)) {
    return 0;
  }
  if (/\b(a louer|te huur|location|huur|rent|vendu|sold|verkocht|loue|verhuurd)\b/i.test(descriptor)) {
    return 0;
  }
  let score = 0;
  if (/\b(a vendre|vente|acheter|te koop|koop|for sale|sale|buy)\b/i.test(descriptor)) score += 1;
  if (/\b(maison|maisons|house|houses|huis|woning|woningen|villa|bungalow|bel etage|rijwoning|eengezinswoning|halfopen|habitation|pand|bien|property)\b/i.test(descriptor)) score += 1;
  if (/\b(detail|annonce|property|bien|pand|ref|reference|listing|object)\b/i.test(descriptor)) score += 1;
  if (/(?:^|[-/])\d{5,}(?:[-/]|$)/.test(url) || /[a-z0-9-]{20,}/i.test(descriptor)) score += 1;
  return score;
}

function commonAgencyIndexUrls(baseUrl, configuredPaths) {
  const paths = splitList(configuredPaths).length ? splitList(configuredPaths) : [
    "/a-vendre",
    "/fr/a-vendre",
    "/fr/acheter",
    "/fr/biens/a-vendre",
    "/biens-a-vendre",
    "/nos-biens/a-vendre",
    "/vente",
    "/te-koop",
    "/nl/te-koop",
    "/aanbod/te-koop",
    "/panden/te-koop"
  ];
  return paths.map((item) => normalizeLinkUrl(item, baseUrl)).filter(Boolean);
}

function readAgencyRows(args) {
  const agencyCsv = args.agencyCsv
    ? path.resolve(args.agencyCsv)
    : latestAgencyCsvPath();
  if (!agencyCsv || !fs.existsSync(agencyCsv)) return { agencyCsv, rows: [] };
  const seen = new Set();
  const rows = parseCsvRows(fs.readFileSync(agencyCsv, "utf8"))
    .map((row) => ({
      name: cleanText(row.Name || row.name),
      address: cleanText(row.Address || row.address),
      latitude: floatFromAny(row.Latitude || row.latitude),
      longitude: floatFromAny(row.Longitude || row.longitude),
      phone: cleanText(row.Phone || row.phone),
      email: cleanText(row.Email || row.email),
      website: normalizeWebsite(row.Website || row.website),
      osmUrl: cleanText(row.OsmUrl || row.osmUrl)
    }))
    .filter((row) => row.website && !isPortalHost(row.website))
    .filter((row) => {
      const key = hostKey(row.website);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { agencyCsv, rows };
}

function flattenJsonLd(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenJsonLd(item, output));
    return output;
  }
  if (typeof value !== "object") return output;
  output.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLd(value["@graph"], output);
  return output;
}

function parseAllJsonLdObjects(html) {
  return parseJsonLdObjects(html).flatMap((item) => flattenJsonLd(item));
}

function jsonLdTypeIncludes(item, needles) {
  const rawType = item && item["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return types.some((type) => needles.some((needle) => String(type || "").toLowerCase().includes(needle)));
}

function findAgencyPropertySchema(objects) {
  return objects.find((item) => jsonLdTypeIncludes(item, [
    "house",
    "singlefamilyresidence",
    "residence",
    "land",
    "apartment",
    "realestatelisting",
    "product"
  ])) || null;
}

function priceCandidatesFromText(text) {
  const candidates = [
    ...[...String(text || "").matchAll(/(?:\bEUR\b|\u20ac)\s*(\d{2,3}(?:[\s.,\u00a0\u202f]\d{3})+|\d{5,8})/gi)].map((match) => match[1]),
    ...[...String(text || "").matchAll(/(\d{2,3}(?:[\s.,\u00a0\u202f]\d{3})+|\d{5,8})\s*(?:\bEUR\b|\u20ac)/gi)].map((match) => match[1])
  ]
    .map((value) => numberFromAny(value))
    .filter((price) => price && price >= 50000 && price <= 2000000);
  return [...new Set(candidates)];
}

function priceFromJsonLd(object) {
  return numberFromAny(firstField(object || {}, [
    "price",
    "offers.price",
    "offers.0.price",
    "offers.priceSpecification.price",
    "offers.0.priceSpecification.price"
  ]));
}

function extractMetaContent(html, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<meta\\s+(?:property|name)=["']${escaped}["']\\s+content=["']([^"']+)["']`, "i");
  return cleanText(getFirstMatch(html, regex));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugHasSegment(haystack, needle) {
  if (!haystack || !needle) return false;
  return new RegExp(`(?:^|-)${escapeRegExp(needle)}(?:-|$)`).test(haystack);
}

function fieldHasPostalCode(field, postal) {
  const value = String(field || "");
  if (!value || !postal) return false;
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const matches = normalized.matchAll(new RegExp(`(^|[^0-9])${escapeRegExp(postal)}([^0-9]|$)`, "gi"));
  for (const match of matches) {
    const start = Math.max(0, match.index || 0);
    const end = Math.min(normalized.length, start + match[0].length);
    const context = normalized.slice(Math.max(0, start - 16), Math.min(normalized.length, end + 16));
    if (new RegExp(`${escapeRegExp(postal)}\\s*[-_]?\\s*(?:m2|m²|m\\u00b2|sqm|vierkante)`, "i").test(context)) {
      continue;
    }
    return true;
  }
  return false;
}

function detectLocation(config, fields) {
  const haystack = slug(fields.filter(Boolean).join(" "));
  let best = null;
  for (const location of config.locations || []) {
    let score = 0;
    const postal = slug(location.postalCode);
    if (postal && fields.some((field) => fieldHasPostalCode(field, postal))) score += 10;
    const primary = [location.name, location.immowebSlug, location.immovlanSlug, location.zimmoSlug]
      .map(slug)
      .filter(Boolean);
    if (primary.some((needle) => slugHasSegment(haystack, needle))) score += 4;
    const aliases = (location.aliases || []).map(slug).filter((needle) => needle.length >= 4);
    if (aliases.some((needle) => slugHasSegment(haystack, needle))) score += 2;
    if (score > 0 && (!best || score > best.score)) {
      best = { score, location };
    }
  }
  return best?.location || null;
}

function addressFromJsonLd(value) {
  if (typeof value === "string") return cleanText(value);
  const address = value && typeof value === "object" ? value : {};
  return cleanText(firstField(address, [
    (item) => [item.streetAddress, item.postalCode, item.addressLocality].filter(Boolean).join(" "),
    "name",
    "text"
  ]));
}

function addressKey(listing) {
  const address = slug(listing.address || "");
  const postalLocality = slug([listing.postalCode, listing.locality].filter(Boolean).join(" "));
  if (!address || address === postalLocality || !/\d/.test(address) || address.length < 8) return "";
  return `${listing.price || ""}|${listing.postalCode || ""}|${slug(listing.locality || "")}|${address}`;
}

function typedListingKey(listing) {
  const locality = slug(listing.locality || listing.requestedLocation);
  const price = Number(listing.price || 0);
  const surface = Number(listing.surfaceM2 || 0);
  const bedrooms = Number(listing.bedrooms || 0);
  if (!locality || !price || (!surface && !bedrooms)) return "";
  return `${locality}|${price}|${surface || ""}|${bedrooms || ""}`;
}

function lightListingKey(listing) {
  const locality = slug(listing.locality || listing.requestedLocation);
  const price = Number(listing.price || 0);
  return locality && price ? `${locality}|${price}` : "";
}

function titleTokens(value) {
  const stop = new Set(["maison", "maisons", "house", "huis", "woning", "villa", "vendre", "vente", "koop", "te", "a", "de", "du", "des", "het", "een", "avec", "chambre", "chambres", "kamers", "immoweb", "immovlan", "zimmo"]);
  return normalizedWords(value).split(/\s+/).filter((word) => word.length >= 4 && !stop.has(word) && !/^\d+$/.test(word));
}

function buildPortalDedupe(base) {
  const sourceMatches = (source) => /immoweb|immovlan/i.test(String(source || ""));
  const listings = (base.listings || []).filter((listing) => sourceMatches(listing.source));
  const byLight = new Map();
  const titleByLight = new Map();
  const bedroomsByLight = new Map();
  for (const listing of listings) {
    const light = lightListingKey(listing);
    if (light) {
      byLight.set(light, (byLight.get(light) || 0) + 1);
      const tokens = titleTokens(listing.title || "");
      if (!titleByLight.has(light)) titleByLight.set(light, []);
      titleByLight.get(light).push(new Set(tokens));
      if (listing.bedrooms) {
        if (!bedroomsByLight.has(light)) bedroomsByLight.set(light, new Set());
        bedroomsByLight.get(light).add(Number(listing.bedrooms));
      }
    }
  }
  return {
    urls: new Set(listings.map((listing) => canonicalUrl(listing.url)).filter(Boolean)),
    addresses: new Set(listings.map(addressKey).filter(Boolean)),
    addressTexts: listings
      .map((listing) => ({ price: Number(listing.price || 0), value: slug(listing.address || "") }))
      .filter((item) => item.price && item.value && /\d/.test(item.value) && item.value.length >= 12),
    typed: new Set(listings.map(typedListingKey).filter(Boolean)),
    imageKeys: new Set(listings.flatMap((listing) => (listing.photoUrls || []).map(imageIdentityKey)).filter(Boolean)),
    byLight,
    titleByLight,
    bedroomsByLight
  };
}

function portalDuplicateReason(listing, dedupe) {
  if (!dedupe) return "";
  if (isPortalHost(listing.url)) return "lien portail deja couvert";
  const canonical = canonicalUrl(listing.url);
  if (canonical && dedupe.urls.has(canonical)) return "url deja presente";
  const address = addressKey(listing);
  if (address && dedupe.addresses.has(address)) return "adresse/prix deja presents sur portail";
  const candidateAddressText = slug([listing.title, listing.address].filter(Boolean).join(" "));
  if (candidateAddressText && dedupe.addressTexts.some((item) => item.price === Number(listing.price || 0) && candidateAddressText.includes(item.value))) {
    return "adresse detectee deja presente sur portail";
  }
  const typed = typedListingKey(listing);
  if (typed && dedupe.typed.has(typed)) return "commune/prix/surface/chambres deja presents sur portail";
  const imageKeys = (listing.photoUrls || []).map(imageIdentityKey).filter(Boolean);
  if (imageKeys.some((key) => dedupe.imageKeys.has(key))) return "photo deja presente sur portail";
  const light = lightListingKey(listing);
  const matchingPortalCount = light ? (dedupe.byLight.get(light) || 0) : 0;
  if (matchingPortalCount) {
    const candidateTokens = new Set(titleTokens(listing.title || ""));
    const similarTitle = (dedupe.titleByLight.get(light) || []).some((tokens) => {
      let overlap = 0;
      for (const token of candidateTokens) if (tokens.has(token)) overlap += 1;
      return overlap >= 3;
    });
    if (similarTitle) return "titre/prix/commune deja presents sur portail";
    if (listing.bedrooms && !address && !listing.surfaceM2 && dedupe.bedroomsByLight.get(light)?.has(Number(listing.bedrooms))) {
      return "meme commune/prix/chambres deja presents sur portail, details insuffisants";
    }
    if (!address && !listing.surfaceM2 && !listing.bedrooms) {
      return "meme commune/prix deja present sur portail, details insuffisants pour dedoublonner";
    }
  }
  return "";
}

function hasDetailSchema(objects) {
  return objects.some((item) => jsonLdTypeIncludes(item, ["house", "singlefamilyresidence", "land", "realestatelisting", "product"]) && priceFromJsonLd(item));
}

async function parseAgencyDetail(url, agency, config, dedupe) {
  const page = await fetchPage(url, agency.website);
  const html = page.text;
  const text = textFromHtml(html);
  const objects = parseAllJsonLdObjects(html);
  const property = findAgencyPropertySchema(objects) || {};
  const title = cleanText(
    extractMetaContent(html, "og:title")
    || getFirstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i)
    || getFirstMatch(html, /<title>([\s\S]*?)<\/title>/i)
  );
  const description = cleanText(extractMetaContent(html, "description") || extractMetaContent(html, "og:description") || firstField(property, ["description"]));
  const addressValue = property.address || objects.find((item) => jsonLdTypeIncludes(item, ["postaladdress"])) || {};
  const address = addressFromJsonLd(addressValue);
  const location = detectLocation(config, [title, description, address, url]);
  if (!location) return { listing: null, message: "commune cible absente" };

  const jsonLdPrice = priceFromJsonLd(property);
  const titlePrices = priceCandidatesFromText(title);
  const descriptionPrices = priceCandidatesFromText(description);
  const textPrices = priceCandidatesFromText(text);
  const price = titlePrices[0] || descriptionPrices[0] || jsonLdPrice || textPrices[0] || null;
  const detailSchema = hasDetailSchema(objects);
  if (!detailSchema && textPrices.length > 4) {
    return { listing: null, message: "page de liste probable, plusieurs prix detectes" };
  }

  const category = cleanText(firstField(property, ["category", "additionalType", "@type"]));
  const rejection = sourceQualityRejectionReason("Agence locale", {
    title,
    description,
    category,
    locality: location.name,
    postalCode: location.postalCode,
    street: address,
    url,
    price
  }, location, config);
  if (rejection) return { listing: null, message: rejection };

  const detailText = [title, description, text].join(" ");
  const bedrooms = numberFromAny(firstField(property, [
    "numberOfRooms",
    "numberOfBedrooms",
    "bedrooms",
    "accommodationFloorPlan.numberOfBedrooms"
  ])) || extractBedroomsFromText(detailText);
  const surfaceM2 = numberFromAny(firstField(property, [
    "floorSize.value",
    "floorSize",
    "area.value",
    "area",
    "size"
  ])) || extractSurfaceFromText(detailText);
  const geo = objects.find((item) => jsonLdTypeIncludes(item, ["geocoordinates"])) || property.geo || {};
  const images = dedupeImageUrls([
    property.image,
    extractMetaContent(html, "og:image"),
    ...[...html.matchAll(/<img\b[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi)].map((match) => normalizeLinkUrl(match[1], page.finalUrl))
  ]).filter((image) => !/logo|favicon|avatar|placeholder|spinner/i.test(image)).slice(0, 12);
  const publication = publicationDateInfo(firstField(property, [
    "datePosted",
    "datePublished",
    "dateCreated",
    "uploadDate"
  ]) || extractMetaContent(html, "article:published_time"), "Agence locale JSON-LD/meta");
  const isUnderOption = isUnderOptionText(detailText);
  const listing = {
    source: "Agence locale (site direct)",
    id: `agency-${shortId(url)}`,
    propertyType: isLandSearch(config) ? "terrain" : "maison",
    title: title || `${isLandSearch(config) ? "Terrain" : "Maison"} a vendre - ${location.name} - ${agency.name || "Agence locale"}`,
    price,
    bedrooms: bedrooms || null,
    surfaceM2: surfaceM2 || null,
    locality: location.name,
    requestedLocation: location.name,
    postalCode: location.postalCode,
    address,
    latitude: floatFromAny(firstField(geo, ["latitude", "lat"])) || location.latitude || agency.latitude || null,
    longitude: floatFromAny(firstField(geo, ["longitude", "lon", "lng"])) || location.longitude || agency.longitude || null,
    geoPrecision: geo?.latitude && geo?.longitude ? "adresse publiee - agence locale" : "centre commune - agence locale",
    agentName: agency.name || "Agence locale",
    agentPhone: agency.phone || "",
    agentEmail: agency.email || "",
    agentWebsite: agency.website,
    isUnderOption,
    underOption: isUnderOption,
    saleStatus: isUnderOption ? "sous option" : "",
    publicationDate: publication.publicationDate,
    publicationDateSource: publication.publicationDateSource,
    photoCount: images.length,
    photoUrl: images[0] || null,
    photoUrls: images,
    url: page.finalUrl || url
  };
  const duplicateReason = portalDuplicateReason(listing, dedupe);
  if (duplicateReason) return { listing: null, message: `doublon portail: ${duplicateReason}` };
  return { listing, message: `${price} EUR` };
}

async function extractAgencyForRow(agency, config, args, dedupe, diagnostics) {
  const listings = [];
  const seenPages = new Set();
  const seenDetails = new Set();
  try {
    const home = await fetchPage(agency.website);
    const baseUrl = home.finalUrl || agency.website;
    const homeLinks = extractLinks(home.text, baseUrl)
      .filter((url) => isSameAgencyHost(url, baseUrl) && !isPortalHost(url) && !isBlockedAssetUrl(url));
    const indexUrls = [
      baseUrl,
      ...homeLinks.filter((url) => agencyCandidateScore(url) === 1),
      ...commonAgencyIndexUrls(baseUrl, args.agencyIndexPaths)
    ].filter((url) => url && isSameAgencyHost(url, baseUrl));
    const detailCandidates = homeLinks.filter((url) => agencyCandidateScore(url) >= 2);

    diagnostics.push({ source: "Agence locale", location: agency.name, status: "Site lu", message: `${homeLinks.length} lien(s) interne(s), ${detailCandidates.length} candidat(s) direct(s)`, url: baseUrl });

    for (const pageUrl of indexUrls) {
      const pageKey = canonicalUrl(pageUrl);
      if (!pageKey || seenPages.has(pageKey)) continue;
      seenPages.add(pageKey);
      if (detailCandidates.length >= args.agencyMaxCandidatesPerSite) break;
      try {
        const page = pageUrl === baseUrl ? home : await fetchPage(pageUrl, baseUrl);
        const links = extractLinks(page.text, page.finalUrl || pageUrl)
          .filter((url) => isSameAgencyHost(url, baseUrl) && agencyCandidateScore(url) >= 2);
        for (const link of links) {
          const key = canonicalUrl(link);
          if (key && !seenDetails.has(key)) {
            seenDetails.add(key);
            detailCandidates.push(link);
          }
          if (detailCandidates.length >= args.agencyMaxCandidatesPerSite) break;
        }
        diagnostics.push({ source: "Agence locale", location: agency.name, status: "Page candidats", message: `${links.length} lien(s) annonce potentiel(s)`, url: pageUrl });
      } catch (error) {
        diagnostics.push({ source: "Agence locale", location: agency.name, status: "Page ignoree", message: error.message, url: pageUrl });
      }
    }

    for (const detailUrl of detailCandidates.slice(0, args.agencyMaxCandidatesPerSite)) {
      await sleep(config.delayMs || 100);
      try {
        const { listing, message } = await parseAgencyDetail(detailUrl, agency, config, dedupe);
        diagnostics.push({ source: "Agence locale", location: agency.name, status: listing ? "Fiche exploitable" : "Candidat ignore", message, url: detailUrl });
        if (listing) listings.push(listing);
      } catch (error) {
        diagnostics.push({ source: "Agence locale", location: agency.name, status: "Erreur detail", message: error.message, url: detailUrl });
      }
    }
  } catch (error) {
    diagnostics.push({ source: "Agence locale", location: agency.name, status: "Site bloque ou illisible", message: error.message, url: agency.website });
  }
  return listings;
}

async function extractAgencySites(config, args, base, diagnostics) {
  const { agencyCsv, rows } = readAgencyRows(args);
  if (!rows.length) {
    diagnostics.push({ source: "Agence locale", location: "CSV agences", status: "Absent", message: agencyCsv ? `Aucune agence exploitable dans ${agencyCsv}` : "CSV agences introuvable", url: "" });
    return [];
  }
  const selected = rows.slice(0, args.agencyMaxSites);
  const dedupe = buildPortalDedupe(base);
  const listings = [];
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const agency = selected[index];
      const agencyListings = await extractAgencyForRow(agency, config, args, dedupe, diagnostics);
      for (const listing of agencyListings) {
        const key = canonicalUrl(listing.url);
        if (key && listings.some((item) => canonicalUrl(item.url) === key)) continue;
        listings.push(listing);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.agencyConcurrency, selected.length) }, () => worker()));
  diagnostics.push({ source: "Agence locale", location: "Synthese", status: "Essai termine", message: `${listings.length} annonce(s) integree(s) depuis ${selected.length}/${rows.length} site(s) OSM avec dedoublonnage portail`, url: agencyCsv });
  return listings;
}

function immovlanSearchUrl(location, maxPrice, config) {
  const type = isLandSearch(config) ? "terrain" : "maison";
  return `https://www.immovlan.be/fr/immobilier/${type}/a-vendre/${location.immovlanSlug}?maxprice=${maxPrice}`;
}

function immovlanAbsolute(url) {
  return new URL(url, "https://www.immovlan.be").href;
}

async function getImmovlanPhone(vlanCode, detailUrl) {
  if (!vlanCode) return "";
  try {
    const html = await fetchText(`https://www.immovlan.be/fr/workers/property/view/contact-by-phone/${vlanCode}/ContactRequestPropertyDetail`, detailUrl);
    const text = textFromHtml(html);
    const phones = [...text.matchAll(/(?:\+32|0)\s?\d[\d\s./-]{6,}/g)].map((match) => match[0].replace(/\s+/g, " ").trim());
    return phones.find((phone) => phone.replace(/[^\d+]/g, "").length >= 9) || "";
  } catch {
    return "";
  }
}

async function parseImmovlanDetail(url, location, config) {
  const html = await fetchText(url);
  const text = textFromHtml(html);
  const objects = parseJsonLdObjects(html);
  const house = findJsonLd(objects, "House");
  const land = findJsonLd(objects, "Land");
  const realEstateListing = findJsonLd(objects, "RealEstateListing");
  const property = isLandSearch(config) ? (land || house || {}) : (house || {});
  const sell = findJsonLd(objects, "SellAction");
  const geo = findJsonLd(objects, "GeoCoordinates");
  const address = findJsonLd(objects, "PostalAddress") || property?.address || sell?.location || {};
  const agent = findJsonLd(objects, "RealEstateAgent") || {};
  const title = decodeHtml(getFirstMatch(html, /<title>([\s\S]*?)<\/title>/i)).trim();
  const price = Number(sell?.price || sell?.priceSpecification?.price || getFirstMatch(html, /name="cXenseParse:rbf-immovlan-prix"\s+content="([\d,.]+)/i).replace(",", "."));
  const surface = Number(
    (isLandSearch(config) ? (property?.floorSize?.value || property?.area?.value) : property?.floorSize?.value)
    || getFirstMatch(text, isLandSearch(config) ? /(?:Surface du terrain|Superficie du terrain|Terrain)\s+(\d{2,6})\s*m/i : /Surface habitable\s+(\d{2,4})m/i)
  );
  const bedrooms = isLandSearch(config) ? 0 : Number(property?.numberOfRooms || getFirstMatch(text, /(\d+)\s*Chambres?/i));
  const postalCode = String(address?.postalCode || "");
  const locality = decodeHtml(address?.addressLocality || "");
  const street = decodeHtml(address?.streetAddress || "");
  const vlanCode = (url.match(/\/([^/]+)$/) || [])[1] || "";
  const description = `${property?.description || ""} ${sell?.description || ""}`;
  const isUnderOption = isUnderOptionText([title, description, text].filter(Boolean).join(" "));

  if (postalCode && String(location.postalCode) !== postalCode) return { listing: null, message: `code postal ${postalCode} hors commune` };
  const rejection = sourceQualityRejectionReason("Immovlan", {
    title,
    description,
    category: isLandSearch(config) ? "terrain a batir building land bouwgrond" : "maison villa",
    locality,
    postalCode,
    street,
    url,
    price
  }, location, config);
  if (rejection) return { listing: null, message: rejection };

  const imageMatches = [...html.matchAll(/data-src=["']([^"']*api-image\.immovlan\.be\/v1\/property\/[^"']+)["']/gi)].map((match) => decodeHtml(match[1]));
  const images = dedupeImageUrls([
    property?.image,
    sell?.image,
    getFirstMatch(html, /<meta property="og:image" content="([^"]+)"/i),
    ...imageMatches
  ]).slice(0, 12);
  const phone = await getImmovlanPhone(vlanCode.toUpperCase(), url);
  const publication = publicationDateInfo(firstField(realEstateListing || {}, ["datePosted", "datePublished", "dateCreated"]), "Immovlan JSON-LD RealEstateListing.datePosted");

  return {
    listing: {
      source: "Immovlan",
      id: `immovlan-${vlanCode.toLowerCase() || shortId(url)}`,
      propertyType: isLandSearch(config) ? "terrain" : "maison",
      title: title || `${isLandSearch(config) ? "Terrain a batir" : "Maison"} a vendre - ${locality || location.name} - Immovlan`,
      price,
      bedrooms: bedrooms || null,
      surfaceM2: surface || null,
      locality: locality || location.name,
      requestedLocation: location.name,
      postalCode: postalCode || location.postalCode,
      address: [street, postalCode, locality].filter(Boolean).join(" "),
      latitude: geo?.latitude || location.latitude || null,
      longitude: geo?.longitude || location.longitude || null,
      geoPrecision: geo?.latitude && geo?.longitude ? "adresse publiee - Immovlan" : "centre commune - Immovlan",
      agentName: decodeHtml(agent?.name || "Immovlan"),
      agentPhone: phone,
      agentEmail: "",
      agentWebsite: agent?.url ? immovlanAbsolute(agent.url) : "https://www.immovlan.be",
      isUnderOption,
      underOption: isUnderOption,
      saleStatus: isUnderOption ? "sous option" : "",
      publicationDate: publication.publicationDate,
      publicationDateSource: publication.publicationDateSource,
      photoCount: images.length,
      photoUrl: images[0] || null,
      photoUrls: images,
      url
    },
    message: `${price} EUR`
  };
}

async function extractImmovlan(config, locations, diagnostics) {
  const listings = [];
  const seen = new Set();
  for (const location of locations) {
    const searchUrl = immovlanSearchUrl(location, config.maxPrice, config);
    try {
      const html = await fetchText(searchUrl);
      const detailPattern = isLandSearch(config)
        ? /(?:https:\/\/www\.immovlan\.be)?\/fr\/detail\/terrain\/a-vendre\/[^"'<> \n]+/gi
        : /(?:https:\/\/www\.immovlan\.be)?\/fr\/detail\/(?:maison|villa|immeuble-de-rapport|bien-exceptionnel)\/a-vendre\/[^"'<> \n]+/gi;
      const links = [...new Map([...html.matchAll(detailPattern)]
        .map((match) => immovlanAbsolute(match[0]))
        .map((url) => [canonicalUrl(url), url])).values()]
        .filter((url) => !seen.has(canonicalUrl(url)));
      diagnostics.push({ source: "Immovlan", location: location.name, status: "Recherche OK", message: `${links.length} URL candidates`, url: searchUrl });
      for (const detailUrl of links.slice(0, config.maxPerLocation || 12)) {
        seen.add(canonicalUrl(detailUrl));
        await sleep(config.delayMs || 350);
        try {
          const { listing, message } = await parseImmovlanDetail(detailUrl, location, config);
          diagnostics.push({ source: "Immovlan", location: location.name, status: listing ? "Fiche exploitable" : "Candidat ignore", message, url: detailUrl });
          if (listing) listings.push(listing);
        } catch (error) {
          diagnostics.push({ source: "Immovlan", location: location.name, status: "Erreur detail", message: error.message, url: detailUrl });
        }
      }
    } catch (error) {
      diagnostics.push({ source: "Immovlan", location: location.name, status: "Recherche indisponible", message: error.message, url: searchUrl });
    }
  }
  return listings;
}

function secondHandSearchUrl(location, maxPrice, config) {
  const category = isLandSearch(config) ? "terrains-terrains-a-batir" : "maisons-a-vendre";
  return `https://www.2ememain.be/l/immo/${category}/q/${encodeURIComponent(slug(location.name))}/?priceTo=${encodeURIComponent(maxPrice)}`;
}

function parseSecondHandConfig(html) {
  const match = html.match(/window\.__CONFIG__\s*=\s*(\{.*?\});\s*window\.__BE_API_GATEWAY_URL__/s) || html.match(/window\.__CONFIG__\s*=\s*(\{.*?\});/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractSurfaceFromText(text) {
  const value = cleanText(text);
  const match = value.match(/\b(\d{2,4})\s*(?:m2|m\u00b2|m\s*2|m(?:e|è)tre[s]?\s*carr(?:e|é)s?)\b/i);
  return match ? Number(match[1]) : null;
}

function extractBedroomsFromText(text) {
  const value = cleanText(text);
  const match = value.match(/\b([1-9]\d?)\s*(?:ch(?:ambre|ambres)?|kamer|kamers|slaapkamer|slaapkamers|slpk|slpks)\b/i);
  return match ? Number(match[1]) : null;
}

async function parseSecondHandDetail(url, location, config) {
  const html = await fetchText(url);
  const cfg = parseSecondHandConfig(html);
  const listing = cfg?.listing;
  if (!listing) return { listing: null, message: "configuration annonce absente" };

  const price = Number(listing.priceInfo?.priceCents || 0) / 100;
  const seller = listing.seller || {};
  const sellerLocation = seller.location || {};
  const locality = decodeHtml(sellerLocation.cityName || "");
  const title = decodeHtml(listing.title || getFirstMatch(html, /<title>([\s\S]*?)<\/title>/i));
  const description = cleanText(firstField(listing, ["description", "descriptionText", "itemDescription", "body", "content"]));
  const category = `${listing.category?.parentName || ""} ${listing.category?.fullName || ""} ${listing.category?.name || ""}`;

  const rejection = sourceQualityRejectionReason("2ememain", {
    title,
    description,
    category,
    locality,
    url,
    price
  }, location, config);
  if (rejection) return { listing: null, message: rejection };
  if (isLandSearch(config)) {
    if (!/terrains?|bouwgrond|grond/i.test(normalizedWords(category))) return { listing: null, message: "categorie non terrain" };
  } else if (!/maisons?/i.test(normalizedWords(category))) {
    return { listing: null, message: "categorie non maison" };
  }
  if (seller.sellerType && seller.sellerType !== "CONSUMER") return { listing: null, message: `vendeur ${seller.sellerType} non particulier` };

  const images = [...new Set((listing.gallery?.imageUrls || listing.gallery?.media?.images?.map((image) => image.base) || [])
    .map(normalizeImageUrl)
    .filter(Boolean))].slice(0, 12);
  const detailText = [title, description].join(" ");
  const bedrooms = numberFromAny(firstField(listing, [
    "bedrooms",
    "numberOfBedrooms",
    "attributes.bedrooms",
    "property.bedrooms"
  ])) || extractBedroomsFromText(detailText);
  const surfaceM2 = numberFromAny(firstField(listing, [
    "surface",
    "surfaceM2",
    "livingArea",
    "attributes.surface",
    "property.surface",
    "property.livingArea"
  ])) || extractSurfaceFromText(detailText);
  const sellerProfileUrl = seller.sellerProfileUrl ? new URL(seller.sellerProfileUrl, "https://www.2ememain.be").href : "";
  const sellerName = decodeHtml(seller.name || "");
  const hasSpecificSeller = sellerName && !/^particulier(?:\s+2ememain)?$/i.test(sellerName);
  const publication = publicationDateInfo(firstField(listing, [
    "datePosted",
    "datePublished",
    "publicationDate",
    "publishedAt",
    "createdAt",
    "dateCreated",
    "firstSeenAt"
  ]), "2ememain window.__CONFIG__");

  if (!images.length) return { listing: null, message: "photos absentes - annonce particulier non exploitable" };
  if (!surfaceM2 && !bedrooms) return { listing: null, message: "surface/chambres absentes - annonce particulier non exploitable" };
  if (!sellerProfileUrl && !hasSpecificSeller) return { listing: null, message: "contact vendeur absent - annonce particulier non exploitable" };

  return {
    listing: {
      source: "2ememain",
      id: `2ememain-${listing.itemId || shortId(url)}`,
      propertyType: isLandSearch(config) ? "terrain" : "maison",
      title: `${title} - 2ememain`,
      price,
      bedrooms: bedrooms || null,
      surfaceM2: surfaceM2 || null,
      locality: locality || location.name,
      requestedLocation: location.name,
      postalCode: location.postalCode,
      address: locality || "",
      latitude: location.latitude || null,
      longitude: location.longitude || null,
      geoPrecision: "centre commune - 2ememain",
      agentName: sellerName || "Particulier 2ememain",
      agentPhone: "",
      agentEmail: "",
      agentWebsite: sellerProfileUrl,
      publicationDate: publication.publicationDate,
      publicationDateSource: publication.publicationDateSource,
      photoCount: images.length,
      photoUrl: images[0] || null,
      photoUrls: images,
      url
    },
    message: `${price} EUR`
  };
}

async function extractSecondHand(config, locations, diagnostics) {
  const listings = [];
  const seen = new Set();
  for (const location of locations) {
    const searchUrl = secondHandSearchUrl(location, config.maxPrice, config);
    try {
      const html = await fetchText(searchUrl);
      const detailPattern = isLandSearch(config)
        ? /(?:https:\/\/www\.2ememain\.be)?\/v\/immo\/terrains-terrains-a-batir\/m\d+[^"'<> \n]*/gi
        : /(?:https:\/\/www\.2ememain\.be)?\/v\/immo\/maisons-a-vendre\/m\d+[^"'<> \n]*/gi;
      const links = [...new Map([...html.matchAll(detailPattern)]
        .map((match) => new URL(match[0], "https://www.2ememain.be").href)
        .map((url) => [canonicalUrl(url), url])).values()]
        .filter((url) => !seen.has(canonicalUrl(url)));
      diagnostics.push({ source: "2ememain", location: location.name, status: "Recherche OK", message: `${links.length} URL candidates`, url: searchUrl });
      for (const detailUrl of links.slice(0, config.maxPerLocation || 12)) {
        seen.add(canonicalUrl(detailUrl));
        await sleep(config.delayMs || 350);
        try {
          const { listing, message } = await parseSecondHandDetail(detailUrl, location, config);
          diagnostics.push({ source: "2ememain", location: location.name, status: listing ? "Fiche exploitable" : "Candidat ignore", message, url: detailUrl });
          if (listing) listings.push(listing);
        } catch (error) {
          diagnostics.push({ source: "2ememain", location: location.name, status: "Erreur detail", message: error.message, url: detailUrl });
        }
      }
    } catch (error) {
      diagnostics.push({ source: "2ememain", location: location.name, status: "Recherche indisponible", message: error.message, url: searchUrl });
    }
  }
  return listings;
}

function zimmoSearchUrl(location, maxPrice, config) {
  const type = isLandSearch(config) ? "terrain" : "maison";
  return `https://www.zimmo.be/fr/${location.zimmoSlug}-${location.postalCode}/a-vendre/${type}/?priceIncludeUnknown=0&priceMax=${maxPrice}`;
}

function zimmoEncodedSearchUrl(location, maxPrice, config) {
  if (!location.zimmoPlaceId) return "";
  const search = {
    filter: {
      status: { in: ["FOR_SALE", "TAKE_OVER"] },
      placeId: { in: [Number(location.zimmoPlaceId)] },
      price: { unknown: false, range: { min: 0, max: Number(maxPrice || 285000) } },
      category: { in: [isLandSearch(config) ? "LAND" : "HOUSE"] }
    },
    paging: { from: 0, size: 17 },
    sorting: [{ type: "PRICE", order: "ASC" }]
  };
  const encoded = encodeURIComponent(Buffer.from(JSON.stringify(search), "utf8").toString("base64"));
  return `https://www.zimmo.be/fr/rechercher/?search=${encoded}&p=1#combi`;
}

function normalizeApifyActorId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}~${parts[1]}`;
  } catch {
    // Not a URL; normalize below.
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}~${parts[1]}`;
  return raw;
}

function buildZimmoApifyInput(config, args) {
  if (args.apifyZimmoInput) {
    const inputPath = path.resolve(args.apifyZimmoInput);
    return JSON.parse(fs.readFileSync(inputPath, "utf8"));
  }
  if (args.apifyZimmoInputJson) {
    return JSON.parse(args.apifyZimmoInputJson);
  }
  const configuredUrls = [
    ...String(args.apifyZimmoStartUrls || "").split(/[\r\n,;]+/),
    ...(config.apify?.zimmo?.startUrls || [])
  ].map((item) => typeof item === "string" ? item : item?.url).map((url) => String(url || "").trim()).filter(Boolean);
  const generatedUrls = configuredUrls.length
    ? configuredUrls
    : (config.locations || []).map((location) => zimmoEncodedSearchUrl(location, config.maxPrice, config) || zimmoSearchUrl(location, config.maxPrice, config));
  return {
    startUrls: generatedUrls.map((url) => ({ url })),
    maxResults: Number(config.apify?.zimmo?.maxResultsPerUrl || args.apifyMaxResultsPerUrl || 10),
    proxyConfiguration: config.apify?.zimmo?.proxyConfiguration || { useApifyProxy: false }
  };
}

async function apifyJson(url, options = {}) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${options.token}`
  };
  const request = {
    method: options.method || "GET",
    headers
  };
  if (options.body != null) {
    headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, request);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!response.ok) {
    const message = json?.error?.message || json?.message || String(text || "").slice(0, 240) || `HTTP ${response.status}`;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return json;
}

async function waitForApifyRun(runId, token, args) {
  const deadline = Date.now() + Number(args.apifyRunTimeoutMs || 600000);
  let lastRun = null;
  while (Date.now() < deadline) {
    const waitSecs = Math.max(1, Number(args.apifyPollSecs || 20));
    const payload = await apifyJson(`${APIFY_API_BASE}/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${waitSecs}`, { token });
    lastRun = payload?.data || payload;
    if (["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(lastRun?.status)) {
      return lastRun;
    }
  }
  return lastRun;
}

async function runApifyActor(actorId, token, input, args) {
  const waitSecs = Math.max(0, Number(args.apifyWaitSecs || 60));
  const runPayload = await apifyJson(`${APIFY_API_BASE}/actors/${encodeURIComponent(actorId)}/runs?waitForFinish=${waitSecs}`, {
    method: "POST",
    token,
    body: input
  });
  let run = runPayload?.data || runPayload;
  if (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run?.status)) {
    run = await waitForApifyRun(run.id, token, args);
  }
  if (!run || run.status !== "SUCCEEDED") {
    throw new Error(`run ${run?.id || "inconnu"} ${run?.status || "sans statut"}`);
  }
  if (!run.defaultDatasetId) {
    return { run, items: [] };
  }
  const limit = Math.max(1, Number(args.apifyDatasetLimit || 500));
  const items = await apifyJson(`${APIFY_API_BASE}/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&format=json&limit=${limit}`, { token });
  return { run, items: Array.isArray(items) ? items : [] };
}

function findMatchingLocation(config, fields) {
  const postalCode = cleanText(fields.find((field) => /^\d{4}$/.test(cleanText(field))) || "");
  if (postalCode) {
    const byPostal = (config.locations || []).find((location) => String(location.postalCode) === postalCode);
    if (byPostal) return byPostal;
  }
  return (config.locations || []).find((location) => locationMatches(location, fields)) || null;
}

function normalizeZimmoApifyItem(item, config) {
  const url = cleanText(firstField(item, [
    "url",
    "link",
    "detailUrl",
    "propertyUrl",
    "listingUrl",
    "sourceUrl",
    "canonicalUrl"
  ]));
  if (!url) return { listing: null, message: "URL absente" };

  const addressObject = firstField(item, ["address", "location.address", "property.address"]) || {};
  const postalCode = cleanText(firstField(item, [
    "postalCode",
    "zip",
    "zipCode",
    "address.postalCode",
    "address.zip",
    "location.postalCode",
    "property.address.postalCode",
    "userData.postalCode"
  ]));
  const locality = cleanText(firstField(item, [
    "locality",
    "city",
    "municipality",
    "address.locality",
    "address.city",
    "address.addressLocality",
    "location.city",
    "userData.location"
  ]));
  const street = cleanText(firstField(item, [
    "street",
    "streetAddress",
    "address.street",
    "address.streetAddress",
    "property.address.streetAddress"
  ]));
  const address = cleanText(firstField(item, [
    "fullAddress",
    "addressText",
    "address.full",
    "location.addressText",
    () => [street, postalCode, locality].filter(Boolean).join(" ")
  ]));
  const titleBase = cleanText(firstField(item, [
    "title",
    "name",
    "heading",
    "propertyTitle",
    "summary",
    "description"
  ])) || `${isLandSearch(config) ? "Terrain a batir" : "Maison"} a vendre - ${locality || postalCode || "Zimmo"}`;
  const title = /zimmo/i.test(titleBase) ? titleBase : `${titleBase} - Zimmo`;
  const description = cleanText(firstField(item, ["description", "summary", "property.description", "details.description"]));
  const statusText = cleanText(firstField(item, [
    "status",
    "availability",
    "transactionStatus",
    "saleStatus",
    "publicationStatus",
    "property.status",
    "details.status"
  ]));
  const isUnderOption = isUnderOptionText([title, description, statusText].filter(Boolean).join(" "));

  const priceCents = numberFromAny(firstField(item, ["priceCents", "priceInfo.priceCents"]));
  const price = priceCents ? Math.round(priceCents / 100) : numberFromAny(firstField(item, [
    "price",
    "priceValue",
    "priceAmount",
    "askingPrice",
    "transaction.price",
    "pricing.price",
    "details.price",
    "sale.price"
  ]));
  if (!price || price > Number(config.maxPrice || 285000)) return { listing: null, message: `prix ${price || "absent"} hors filtre` };

  const matchedLocation = findMatchingLocation(config, [
    postalCode,
    locality,
    address,
    street,
    url,
    title,
    firstField(item, ["userData.location", "searchLocation"])
  ]);
  if (config.strictExactLocation !== false && !matchedLocation) {
    return { listing: null, message: "commune cible absente" };
  }

  const rejection = sourceQualityRejectionReason("Zimmo", {
    title,
    description,
    category: cleanText(firstField(item, ["propertyType", "type", "category"])),
    locality,
    postalCode,
    street,
    url,
    price
  }, matchedLocation, config);
  if (rejection) return { listing: null, message: rejection };

  const latitude = floatFromAny(firstField(item, [
    "latitude",
    "lat",
    "geo.latitude",
    "location.latitude",
    "coordinates.latitude",
    "address.latitude"
  ]));
  const longitude = floatFromAny(firstField(item, [
    "longitude",
    "lon",
    "lng",
    "geo.longitude",
    "location.longitude",
    "coordinates.longitude",
    "address.longitude"
  ]));

  const agentObject = firstField(item, ["agent", "agency", "broker", "realtor", "advertiser", "seller"]) || {};
  const agentName = cleanText(firstField(item, [
    "agentName",
    "agencyName",
    "brokerName",
    "realtorName",
    "advertiserName",
    () => agentObject.name,
    () => agentObject.companyName
  ])) || "Zimmo";
  const agentPhone = cleanText(firstField(item, [
    "agentPhone",
    "phone",
    "telephone",
    "contact.phone",
    () => agentObject.phone,
    () => agentObject.telephone
  ]));
  const agentEmail = cleanText(firstField(item, [
    "agentEmail",
    "email",
    "contact.email",
    () => agentObject.email
  ]));
  const agentWebsite = cleanText(firstField(item, [
    "agentWebsite",
    "agencyWebsite",
    "website",
    () => agentObject.url,
    () => agentObject.website
  ])) || "https://www.zimmo.be";
  const images = [...new Set([
    ...collectImageUrls(firstField(item, ["photoUrls", "photos", "images", "imageUrls", "gallery", "media"])),
    ...collectImageUrls(firstField(item, ["image", "photo", "thumbnail"]))
  ].map(normalizeImageUrl).filter(Boolean))].slice(0, 12);
  const publication = publicationDateInfo(firstField(item, [
    "publicationDate",
    "datePublished",
    "datePosted",
    "publishedAt",
    "createdAt",
    "dateCreated",
    "onlineSince",
    "firstSeenAt"
  ]), "Zimmo Apify item publication field");

  return {
    listing: {
      source: "Zimmo",
      id: `zimmo-${cleanText(firstField(item, ["id", "listingId", "propertyId", "zimmoId", "reference", "referenceId"])) || shortId(url)}`,
      propertyType: isLandSearch(config) ? "terrain" : "maison",
      title,
      price,
      bedrooms: isLandSearch(config) ? null : (numberFromAny(firstField(item, ["bedrooms", "numberOfBedrooms", "rooms.bedrooms", "details.bedrooms"])) || null),
      surfaceM2: numberFromAny(firstField(item, isLandSearch(config)
        ? ["landSurface", "plotArea", "parcelArea", "surface", "surfaceM2", "area", "details.landSurface", "details.surface"]
        : ["surface", "surfaceM2", "livingArea", "area", "habitableSurface", "details.surface"])) || null,
      locality: locality || matchedLocation?.name || "",
      requestedLocation: matchedLocation?.name || locality || "",
      postalCode: postalCode || matchedLocation?.postalCode || "",
      address: address || cleanText(addressObject) || locality || "",
      latitude: latitude || matchedLocation?.latitude || null,
      longitude: longitude || matchedLocation?.longitude || null,
      geoPrecision: latitude && longitude ? "adresse publiee - Zimmo/Apify" : "centre commune - Zimmo/Apify",
      agentName,
      agentPhone,
      agentEmail,
      agentWebsite,
      isUnderOption,
      underOption: isUnderOption,
      saleStatus: isUnderOption ? "sous option" : statusText,
      publicationDate: publication.publicationDate,
      publicationDateSource: publication.publicationDateSource,
      photoCount: images.length,
      photoUrl: images[0] || null,
      photoUrls: images,
      url
    },
    message: `${price} EUR`
  };
}

async function extractZimmoApify(config, args, diagnostics) {
  const actorId = normalizeApifyActorId(args.apifyZimmoActorId || config.apify?.zimmo?.actorId || "");
  const token = args.apifyToken || "";
  if (!token) {
    diagnostics.push({
      source: "Zimmo (Apify)",
      location: "Configuration",
      status: "Extraction bloquee",
      message: `APIFY_TOKEN absent. Acteur ${actorId || DEFAULT_ZIMMO_APIFY_ACTOR_ID} identifie mais import Zimmo non executable sans token.`,
      url: "https://apify.com/dz_omar/zimmo-scraper"
    });
    return [];
  }
  if (!actorId) {
    diagnostics.push({
      source: "Zimmo (Apify)",
      location: "Configuration",
      status: "Connecteur incomplet",
      message: "APIFY_ZIMMO_ACTOR_ID absent.",
      url: "https://apify.com/dz_omar/zimmo-scraper"
    });
    return [];
  }
  const listings = [];
  try {
    const input = buildZimmoApifyInput(config, args);
    diagnostics.push({
      source: "Zimmo (Apify)",
      location: "Toutes communes",
      status: "Execution lancee",
      message: `${(input.startUrls || []).length || "schema acteur"} recherche(s) envoyee(s) a ${actorId}`,
      url: "https://apify.com"
    });
    const { run, items } = await runApifyActor(actorId, token, input, args);
    diagnostics.push({
      source: "Zimmo (Apify)",
      location: "Dataset",
      status: "Dataset recu",
      message: `${items.length} ligne(s) brutes, run ${run.id}`,
      url: run.defaultDatasetId ? `${APIFY_API_BASE}/datasets/${run.defaultDatasetId}/items` : "https://apify.com"
    });
    for (const item of items) {
      const { listing, message } = normalizeZimmoApifyItem(item, config);
      diagnostics.push({
        source: "Zimmo (Apify)",
        location: listing?.requestedLocation || cleanText(firstField(item, ["userData.location", "locality", "city", "address.city"])) || "Annonce",
        status: listing ? "Fiche exploitable" : "Candidat ignore",
        message,
        url: listing?.url || cleanText(firstField(item, ["url", "link", "detailUrl", "propertyUrl"])) || "https://www.zimmo.be"
      });
      if (listing) listings.push(listing);
    }
  } catch (error) {
    diagnostics.push({
      source: "Zimmo (Apify)",
      location: "Execution",
      status: "Erreur Apify",
      message: error.message,
      url: "https://docs.apify.com/api/v2"
    });
  }
  return listings;
}

function replacementSourceMatches(listingSource, requestedSource) {
  const source = String(listingSource || "").toLowerCase();
  if (requestedSource === "immovlan") return source.includes("immovlan");
  if (requestedSource === "2ememain") return source.includes("2ememain");
  if (["zimmo", "zimmo-apify", "apify-zimmo"].includes(requestedSource)) return source.includes("zimmo");
  if (["agency-sites", "agences", "agence-locale"].includes(requestedSource)) return source.includes("agence locale");
  return false;
}

function countBySource(listings) {
  return (Array.isArray(listings) ? listings : []).reduce((acc, listing) => {
    const source = String(listing?.source || "Source inconnue");
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
}

function mergeResults(base, additions, replacementSources = []) {
  const activeReplacementSources = replacementSources.map((source) => String(source || "").toLowerCase()).filter(Boolean);
  const baseListings = (base.listings || []).filter((listing) => {
    return !activeReplacementSources.some((source) => replacementSourceMatches(listing.source, source));
  });
  const seen = new Set(baseListings.map((listing) => canonicalUrl(listing.url)));
  const merged = [...baseListings];
  for (const listing of additions) {
    const key = canonicalUrl(listing.url);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(listing);
  }
  merged.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  return {
    ...base,
    generatedAt: new Date().toISOString(),
    count: merged.length,
    sources: countBySource(merged),
    listings: merged
  };
}

async function run() {
  const args = parseArgs(process.argv);
  fetchTimeoutMs = args.fetchTimeoutMs;
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
  if (args.propertyType) config.propertyType = String(args.propertyType);
  if (args.maxPrice > 0) config.maxPrice = args.maxPrice;
  config.maxPerLocation = args.maxPerLocation;
  config.delayMs = args.delayMs;
  const base = JSON.parse(fs.readFileSync(args.baseResults, "utf8"));
  const sources = String(args.sources || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const diagnostics = [];
  const additions = [];
  if (sources.includes("immovlan")) {
    additions.push(...await extractImmovlan(config, config.locations, diagnostics));
  }
  if (sources.includes("2ememain")) {
    additions.push(...await extractSecondHand(config, config.locations, diagnostics));
  }
  if (sources.some((source) => ["zimmo", "zimmo-apify", "apify-zimmo"].includes(source))) {
    additions.push(...await extractZimmoApify(config, args, diagnostics));
  }
  if (sources.some((source) => ["agency-sites", "agences", "agence-locale"].includes(source))) {
    additions.push(...await extractAgencySites(config, args, base, diagnostics));
  }
  const merged = mergeResults(base, additions, sources);
  const combinedDiagnostics = [
    ...(Array.isArray(base.sourceDiagnostics) ? base.sourceDiagnostics : []),
    ...diagnostics
  ];
  merged.propertyType = isLandSearch(config) ? "terrain" : "maison";
  merged.maxPrice = Number(config.maxPrice || 0);
  merged.sourceDiagnostics = combinedDiagnostics;
  const agencyCount = countBySource(merged.listings)["Agence locale (site direct)"] || 0;
  if (sources.some((source) => ["agency-sites", "agences", "agence-locale"].includes(source))) {
    merged.sourceAudit = {
      ...(merged.sourceAudit || {}),
      agencesLocales: {
        status: agencyCount > 0 ? "presente-et-rendue" : "presente-recherche-mais-filtre-ou-bloquee",
        count: agencyCount
      }
    };
  }
  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify(merged, null, 2), "utf8");
  fs.writeFileSync(args.outJson.replace(/\.json$/, "-diagnostics.json"), JSON.stringify({ generatedAt: new Date().toISOString(), count: combinedDiagnostics.length, diagnostics: combinedDiagnostics }, null, 2), "utf8");
  console.log(JSON.stringify({
    baseCount: base.count,
    additions: additions.length,
    mergedCount: merged.count,
    diagnostics: diagnostics.length,
    totalDiagnostics: combinedDiagnostics.length,
    bySource: additions.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {})
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
