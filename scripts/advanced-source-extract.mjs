import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = "config/veille-immo.json";
const DEFAULT_RESULTS = "publish/veille-immo-report/results.json";
const DEFAULT_OUT = "reports-experimental/advanced-source-results.json";
const USER_AGENT = "Mozilla/5.0 veille-immo-advanced/1.0";
const APIFY_API_BASE = "https://api.apify.com/v2";
const DEFAULT_ZIMMO_APIFY_ACTOR_ID = "dz_omar~zimmo-scraper";

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    baseResults: DEFAULT_RESULTS,
    outJson: DEFAULT_OUT,
    sources: "immovlan,2ememain,zimmo-apify",
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
    apifyMaxResultsPerUrl: 10
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
  args.apifyWaitSecs = Number(args.apifyWaitSecs || 60);
  args.apifyPollSecs = Number(args.apifyPollSecs || 20);
  args.apifyRunTimeoutMs = Number(args.apifyRunTimeoutMs || 600000);
  args.apifyDatasetLimit = Number(args.apifyDatasetLimit || 500);
  args.apifyMaxResultsPerUrl = Number(args.apifyMaxResultsPerUrl || 10);
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

async function fetchText(url, referer = "") {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-BE,fr;q=0.9,nl;q=0.8"
  };
  if (referer) headers.Referer = referer;
  const response = await fetch(url, { headers, redirect: "follow" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return text;
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
  return /\b(appartement|apparemment|appartementen|apartment|flat|studio|studios|garage|garages|garagebox|parking|staanplaats|box|terrain|terrein|grond|bouwgrond|kot|kamer|chambre|room|commercial|commerce|handelsruimte|bureau|kantoor|entrepot|magazijn|hangar|loft|duplex|mur uniquement)\b/i.test(haystack);
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

  if (!price || price > maxPrice) return `prix ${price || "absent"} hors filtre`;
  if (price < 50000) return `prix ${price} sous seuil coherent`;
  if (config.excludeNotarialSales !== false && isNotarial(haystack)) return "vente notariale exclue";
  if (isRentalText(haystack)) return "location exclue";
  if (hasMonthlySupplementText(haystack)) return "viager/rente/mensualite exclu";
  if (badHouseText(identityText)) return "type non maison probable";
  if (!hasHouseSignal(identityText)) return "signal maison absent";
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

function immovlanSearchUrl(location, maxPrice) {
  return `https://www.immovlan.be/fr/immobilier/maison/a-vendre/${location.immovlanSlug}?maxprice=${maxPrice}`;
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
  const sell = findJsonLd(objects, "SellAction");
  const geo = findJsonLd(objects, "GeoCoordinates");
  const address = findJsonLd(objects, "PostalAddress") || house?.address || sell?.location || {};
  const agent = findJsonLd(objects, "RealEstateAgent") || {};
  const title = decodeHtml(getFirstMatch(html, /<title>([\s\S]*?)<\/title>/i)).trim();
  const price = Number(sell?.price || sell?.priceSpecification?.price || getFirstMatch(html, /name="cXenseParse:rbf-immovlan-prix"\s+content="([\d,.]+)/i).replace(",", "."));
  const surface = Number(house?.floorSize?.value || getFirstMatch(text, /Surface habitable\s+(\d{2,4})m/i));
  const bedrooms = Number(house?.numberOfRooms || getFirstMatch(text, /(\d+)\s*Chambres?/i));
  const postalCode = String(address?.postalCode || "");
  const locality = decodeHtml(address?.addressLocality || "");
  const street = decodeHtml(address?.streetAddress || "");
  const vlanCode = (url.match(/\/([^/]+)$/) || [])[1] || "";

  if (postalCode && String(location.postalCode) !== postalCode) return { listing: null, message: `code postal ${postalCode} hors commune` };
  const rejection = sourceQualityRejectionReason("Immovlan", {
    title,
    description: `${house?.description || ""} ${sell?.description || ""}`,
    category: "maison villa",
    locality,
    postalCode,
    street,
    url,
    price
  }, location, config);
  if (rejection) return { listing: null, message: rejection };

  const imageMatches = [...html.matchAll(/data-src=["']([^"']*api-image\.immovlan\.be\/v1\/property\/[^"']+)["']/gi)].map((match) => decodeHtml(match[1]));
  const images = dedupeImageUrls([
    house?.image,
    sell?.image,
    getFirstMatch(html, /<meta property="og:image" content="([^"]+)"/i),
    ...imageMatches
  ]).slice(0, 12);
  const phone = await getImmovlanPhone(vlanCode.toUpperCase(), url);

  return {
    listing: {
      source: "Immovlan",
      id: `immovlan-${vlanCode.toLowerCase() || shortId(url)}`,
      title: title || `Maison a vendre - ${locality || location.name} - Immovlan`,
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
    const searchUrl = immovlanSearchUrl(location, config.maxPrice);
    try {
      const html = await fetchText(searchUrl);
      const links = [...new Map([...html.matchAll(/(?:https:\/\/www\.immovlan\.be)?\/fr\/detail\/(?:maison|villa|immeuble-de-rapport|bien-exceptionnel)\/a-vendre\/[^"'<> \n]+/gi)]
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

function secondHandSearchUrl(location, maxPrice) {
  return `https://www.2ememain.be/l/immo/maisons-a-vendre/q/${encodeURIComponent(slug(location.name))}/?priceTo=${encodeURIComponent(maxPrice)}`;
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
  const match = value.match(/\b([1-9]\d?)\s*(?:ch(?:ambre|ambres)?|kamer|kamers|slaapkamer|slaapkamers)\b/i);
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
  if (!/maisons?/i.test(normalizedWords(category))) return { listing: null, message: "categorie non maison" };
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

  if (!images.length) return { listing: null, message: "photos absentes - annonce particulier non exploitable" };
  if (!surfaceM2 && !bedrooms) return { listing: null, message: "surface/chambres absentes - annonce particulier non exploitable" };
  if (!sellerProfileUrl && !hasSpecificSeller) return { listing: null, message: "contact vendeur absent - annonce particulier non exploitable" };

  return {
    listing: {
      source: "2ememain",
      id: `2ememain-${listing.itemId || shortId(url)}`,
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
    const searchUrl = secondHandSearchUrl(location, config.maxPrice);
    try {
      const html = await fetchText(searchUrl);
      const links = [...new Map([...html.matchAll(/(?:https:\/\/www\.2ememain\.be)?\/v\/immo\/maisons-a-vendre\/m\d+[^"'<> \n]*/gi)]
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

function zimmoSearchUrl(location, maxPrice) {
  return `https://www.zimmo.be/fr/${location.zimmoSlug}-${location.postalCode}/a-vendre/maison/?priceIncludeUnknown=0&priceMax=${maxPrice}`;
}

function zimmoEncodedSearchUrl(location, maxPrice) {
  if (!location.zimmoPlaceId) return "";
  const search = {
    filter: {
      status: { in: ["FOR_SALE", "TAKE_OVER"] },
      placeId: { in: [Number(location.zimmoPlaceId)] },
      price: { unknown: false, range: { min: 0, max: Number(maxPrice || 285000) } },
      category: { in: ["HOUSE"] }
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
    : (config.locations || []).map((location) => zimmoEncodedSearchUrl(location, config.maxPrice) || zimmoSearchUrl(location, config.maxPrice));
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
  ])) || `Maison a vendre - ${locality || postalCode || "Zimmo"}`;
  const title = /zimmo/i.test(titleBase) ? titleBase : `${titleBase} - Zimmo`;

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
    description: cleanText(firstField(item, ["description", "summary", "property.description", "details.description"])),
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

  return {
    listing: {
      source: "Zimmo",
      id: `zimmo-${cleanText(firstField(item, ["id", "listingId", "propertyId", "zimmoId", "reference", "referenceId"])) || shortId(url)}`,
      title,
      price,
      bedrooms: numberFromAny(firstField(item, ["bedrooms", "numberOfBedrooms", "rooms.bedrooms", "details.bedrooms"])) || null,
      surfaceM2: numberFromAny(firstField(item, ["surface", "surfaceM2", "livingArea", "area", "habitableSurface", "details.surface"])) || null,
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
      status: "Connecteur pret",
      message: `Acteur ${actorId || DEFAULT_ZIMMO_APIFY_ACTOR_ID} identifie. Definir APIFY_TOKEN pour activer l'import Zimmo via Apify.`,
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
  return false;
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
    listings: merged
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
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
  const merged = mergeResults(base, additions, sources);
  merged.sourceDiagnostics = diagnostics;
  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify(merged, null, 2), "utf8");
  fs.writeFileSync(args.outJson.replace(/\.json$/, "-diagnostics.json"), JSON.stringify({ generatedAt: new Date().toISOString(), count: diagnostics.length, diagnostics }, null, 2), "utf8");
  console.log(JSON.stringify({
    baseCount: base.count,
    additions: additions.length,
    mergedCount: merged.count,
    diagnostics: diagnostics.length,
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
