import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_MAX_PRICE = 285000;

function parseArgs(argv) {
  const args = {
    config: "config/veille-immo.json",
    outJson: "reports-experimental/browser-source-results.json",
    outCsv: "reports-experimental/browser-source-results.csv",
    diagnosticsJson: "reports-experimental/browser-source-diagnostics.json",
    diagnosticsCsv: "reports-experimental/browser-source-diagnostics.csv",
    networkJson: "reports-experimental/browser-source-network.json",
    maxDetailPerLocation: 5,
    locationLimit: 0,
    delayMs: 2500,
    navigationTimeoutMs: 45000,
    sources: "zimmo,immovlan,2ememain",
    profileDir: ".browser-profiles/zimmo-immovlan",
    headless: "true",
    keepOpen: "false",
    setupOnly: "false",
    setupWaitMs: 120000,
    captureNetwork: "true"
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    i += 1;
    const name = key.slice(2);
    if (["maxDetailPerLocation", "locationLimit", "delayMs", "navigationTimeoutMs", "setupWaitMs"].includes(name)) {
      args[name] = Number(value);
    } else {
      args[name] = value;
    }
  }
  return args;
}

function asBoolean(value) {
  return /^(1|true|yes|oui)$/i.test(String(value || ""));
}

function resolveProfileDir(value) {
  if (!value || value === "temp") return fs.mkdtempSync(path.join(os.tmpdir(), "veille-immo-chrome-"));
  return path.resolve(value);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome introuvable. Definir CHROME_PATH si Chrome est installe ailleurs.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await sleep(100);
  }
  throw new Error(`Timeout fichier Chrome DevTools: ${filePath}`);
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

function normalizePrice(text) {
  if (!text) return null;
  const match = String(text).match(/(\d[\d\s.,\u00A0\u202F]{3,})\s*(?:EUR|€)/i);
  if (!match) return null;
  const digits = match[1].replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

function shortHash(value) {
  let h1 = 0x811c9dc5;
  for (const char of String(value)) {
    h1 ^= char.charCodeAt(0);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0");
}

function searchUrl(source, location, maxPrice) {
  if (source === "zimmo") {
    return `https://www.zimmo.be/fr/${location.zimmoSlug}-${location.postalCode}/a-vendre/maison/?priceIncludeUnknown=0&priceMax=${maxPrice}`;
  }
  if (source === "immovlan") {
    return `https://immovlan.be/fr/immobilier/maison/a-vendre/${location.immovlanSlug}?maxprice=${maxPrice}`;
  }
  if (source === "2ememain") {
    const query = encodeURIComponent(slugForPath(location.name));
    return `https://www.2ememain.be/l/immo/maisons-a-vendre/q/${query}/?priceTo=${maxPrice}`;
  }
  throw new Error(`Source inconnue: ${source}`);
}

function slugForPath(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourceLabel(source) {
  return source === "zimmo" ? "Zimmo" : source === "immovlan" ? "Immovlan" : source === "2ememain" ? "2ememain" : source;
}

function experimentalListingRejectionReason(source, data, price, location) {
  if (source !== "2ememain") return "";
  const titleAndDescription = `${data.title || ""}\n${data.description || ""}`;
  const identitySlug = slugForPath(`${data.title || ""}\n${data.description || ""}\n${data.url || ""}`);
  const locationNeedles = [
    location.name,
    location.postalCode,
    location.immowebSlug,
    location.zimmoSlug,
    location.immovlanSlug
  ].filter(Boolean).map(slugForPath).filter(Boolean);

  if (price < 50000) return `Prix ${price} sous le seuil coherent pour une vente`;
  if (/\b(appartement|apparemment|appartementen|apartment|flat|studio|garage|garages|parking|staanplaats|box|terrain|grond|kot|kamer|chambre)\b/i.test(titleAndDescription)) {
    return "Annonce non maison probable";
  }
  if (locationNeedles.length && !locationNeedles.some((needle) => identitySlug.includes(needle))) {
    return "Commune cible absente de la fiche";
  }
  return "";
}

function looksLikeListingUrl(source, href) {
  try {
    const url = new URL(href);
    const clean = `${url.origin}${url.pathname}`;
    if (source === "zimmo") {
      return /(^|\.)zimmo\.be$/i.test(url.hostname)
        && /\/fr\//i.test(url.pathname)
        && /\/a-vendre\//i.test(url.pathname)
        && /\/(?:maison|huis|woning)\//i.test(url.pathname)
        && !/\/a-vendre\/(?:maison|huis|woning)\/?$/i.test(url.pathname);
    }
    if (source === "immovlan") {
      return /(^|\.)((immo\.)?vlan|immovlan)\.be$/i.test(url.hostname)
        && /\/fr\//i.test(url.pathname)
        && /\/(?:maison|house|huis)\//i.test(clean)
        && /\/(?:a-vendre|te-koop|for-sale|detail)\//i.test(clean)
        && !/\/maison\/a-vendre\/?$/i.test(url.pathname);
    }
    if (source === "2ememain") {
      return /(^|\.)2ememain\.be$/i.test(url.hostname)
        && /\/v\/immo\/maisons-a-vendre\/m\d+/i.test(url.pathname);
    }
  } catch {
    return false;
  }
  return false;
}

class CdpPage {
  constructor(wsUrl, options = {}) {
    this.wsUrl = wsUrl;
    this.options = options;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.documentStatus = null;
    this.responses = new Map();
    this.networkPayloads = [];
    this.bodyPromises = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout WebSocket Chrome")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`Erreur WebSocket Chrome: ${event.message || "unknown"}`));
      }, { once: true });
    });

    this.ws.addEventListener("message", (event) => this.onMessage(event));
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable", {
      maxResourceBufferSize: 10_000_000,
      maxTotalBufferSize: 50_000_000
    });
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }

    if (message.method === "Network.responseReceived") {
      const response = message.params.response || {};
      if (message.params?.type === "Document") {
        this.documentStatus = response.status || null;
      }
      this.responses.set(message.params.requestId, {
        url: response.url || "",
        status: response.status || "",
        mimeType: response.mimeType || "",
        type: message.params.type || "",
        headers: response.headers || {}
      });
    }

    if (message.method === "Network.loadingFinished" && this.options.captureNetwork) {
      const requestId = message.params?.requestId;
      const response = this.responses.get(requestId);
      if (response && this.shouldCaptureBody(response)) {
        const promise = this.collectResponseBody(requestId, response)
          .catch(() => {})
          .finally(() => this.bodyPromises.delete(promise));
        this.bodyPromises.add(promise);
      }
    }

    const listeners = this.events.get(message.method);
    if (listeners) {
      for (const listener of listeners.splice(0)) listener(message.params);
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout CDP ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  once(method, timeoutMs) {
    return new Promise((resolve) => {
      const listeners = this.events.get(method) || [];
      listeners.push(resolve);
      this.events.set(method, listeners);
      setTimeout(() => resolve(null), timeoutMs);
    });
  }

  async navigate(url, timeoutMs, delayMs) {
    this.documentStatus = null;
    this.responses.clear();
    this.networkPayloads = [];
    const loadPromise = this.once("Page.loadEventFired", timeoutMs);
    await this.send("Page.navigate", { url });
    await loadPromise;
    await sleep(delayMs);
    await this.flushNetworkBodies(2000);
    const location = await this.evaluate("location.href", 5000).catch(() => url);
    const title = await this.evaluate("document.title", 5000).catch(() => "");
    return { status: this.documentStatus, location, title };
  }

  shouldCaptureBody(response) {
    const haystack = `${response.url}\n${response.mimeType}`.toLowerCase();
    return response.type === "XHR"
      || response.type === "Fetch"
      || haystack.includes("json")
      || /(api|graphql|search|estate|property|classified|realestate|listing|pand|annonce|immobilier)/i.test(response.url);
  }

  async collectResponseBody(requestId, response) {
    const result = await this.send("Network.getResponseBody", { requestId });
    if (!result?.body) return;
    const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
    if (!body || body.length < 20) return;
    this.networkPayloads.push({
      url: response.url,
      status: response.status,
      mimeType: response.mimeType,
      type: response.type,
      body: body.slice(0, 2_000_000)
    });
  }

  async flushNetworkBodies(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.bodyPromises.size && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.bodyPromises]),
        sleep(250)
      ]);
    }
  }

  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Erreur evaluation runtime");
    }
    return result.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function startChrome(args) {
  const chromePath = findChrome();
  const profileDir = resolveProfileDir(args.profileDir);
  const temporaryProfile = !args.profileDir || args.profileDir === "temp";
  fs.mkdirSync(profileDir, { recursive: true });

  const chromeArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--window-size=1365,900",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "about:blank"
  ];
  if (asBoolean(args.headless)) {
    chromeArgs.unshift("--headless=new", "--disable-gpu");
  }

  const chrome = spawn(chromePath, chromeArgs, { stdio: "ignore" });

  const devToolsFile = path.join(profileDir, "DevToolsActivePort");
  await waitForFile(devToolsFile, 15000);
  const [port] = fs.readFileSync(devToolsFile, "utf8").trim().split(/\r?\n/);
  const tabs = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const tab = tabs.find((item) => item.type === "page") || tabs[0];
  const page = new CdpPage(tab.webSocketDebuggerUrl, { captureNetwork: asBoolean(args.captureNetwork) });
  await page.connect();

  return {
    page,
    profileDir,
    stop() {
      page.close();
      if (!asBoolean(args.keepOpen)) {
        try { chrome.kill(); } catch {}
      }
      if (temporaryProfile && !asBoolean(args.keepOpen)) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
      }
    }
  };
}

async function extractCandidateLinks(page, source, baseUrl) {
  const expression = `(() => Array.from(document.querySelectorAll('a[href]')).map(a => new URL(a.getAttribute('href'), location.href).href))()`;
  const domLinks = await page.evaluate(expression, 5000).catch(() => []);
  const networkLinks = extractNetworkLinks(page.networkPayloads, source, baseUrl);
  return [...new Set([...(domLinks || []), ...networkLinks].filter((href) => looksLikeListingUrl(source, href)))].slice(0, 60);
}

function extractNetworkLinks(payloads, source, baseUrl) {
  const links = new Set();
  for (const payload of payloads || []) {
    collectLinksFromText(payload.body, source, baseUrl, links);
    const parsed = parseLooseJson(payload.body);
    if (parsed) collectLinksFromValue(parsed, source, baseUrl, links);
  }
  return [...links];
}

function parseLooseJson(text) {
  const source = String(text || "").trim().replace(/^\)\]\}',?\s*/, "");
  if (!/^[{[]/.test(source)) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function collectLinksFromText(text, source, baseUrl, links) {
  const sourceText = String(text || "").replaceAll("\\/", "/");
  const urlMatches = sourceText.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  for (const match of urlMatches) {
    const clean = match.replace(/[),.;]+$/, "");
    if (looksLikeListingUrl(source, clean)) links.add(clean);
  }

  const relativeMatches = sourceText.match(/\/(?:fr|nl|v)\/[^\s"'<>\\]+/gi) || [];
  for (const match of relativeMatches) {
    try {
      const url = new URL(match.replace(/[),.;]+$/, ""), baseUrl).href;
      if (looksLikeListingUrl(source, url)) links.add(url);
    } catch {}
  }
}

function collectLinksFromValue(value, source, baseUrl, links) {
  if (typeof value === "string") {
    try {
      const url = new URL(value, baseUrl).href;
      if (looksLikeListingUrl(source, url)) links.add(url);
    } catch {}
    collectLinksFromText(value, source, baseUrl, links);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectLinksFromValue(item, source, baseUrl, links);
    return;
  }
  for (const item of Object.values(value)) collectLinksFromValue(item, source, baseUrl, links);
}

async function pageTextSample(page) {
  return await page.evaluate(`(() => document.body ? document.body.innerText.slice(0, 1000) : "")()`, 5000).catch(() => "");
}

async function extractDetail(page, source, location, url, args, maxPrice) {
  const nav = await page.navigate(url, args.navigationTimeoutMs, args.delayMs);
  const data = await page.evaluate(`(() => {
    const meta = (name) => document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]')?.content || "";
    return {
      title: document.title || meta("og:title") || "",
      description: meta("og:description") || "",
      image: meta("og:image") || "",
      text: document.body ? document.body.innerText.slice(0, 50000) : "",
      url: location.href
    };
  })()`, 7000);

  const price = normalizePrice(`${data.title}\n${data.description}\n${data.text}`);
  if (!price || price > maxPrice) {
    return { listing: null, diagnostic: {
      source: sourceLabel(source),
      location: location.name,
      status: "Candidat ignore",
      message: price ? `Prix ${price} superieur au plafond` : "Prix absent dans le DOM navigateur",
      url
    }};
  }

  const rejectionReason = experimentalListingRejectionReason(source, data, price, location);
  if (rejectionReason) {
    return { listing: null, diagnostic: {
      source: sourceLabel(source),
      location: location.name,
      status: "Candidat ignore",
      message: rejectionReason,
      url
    }};
  }

  const text = `${data.title}\n${data.description}\n${data.text}`;
  const bedrooms = (text.match(/(\d+)\s*(?:chambres?|slaapkamers?|bedrooms?)/i) || [])[1] || "";
  const surfaceM2 = (text.match(/(\d{2,4})\s*m(?:²|2|\b)/i) || [])[1] || "";

  return {
    listing: {
      Source: sourceLabel(source),
      Id: shortHash(`${source}|${data.url || url}`),
      RequestedLocation: location.name,
      Locality: location.name,
      PostalCode: location.postalCode,
      Address: "",
      Latitude: location.latitude || "",
      Longitude: location.longitude || "",
      GeoPrecision: "centre commune - navigateur experimental",
      Price: price,
      Bedrooms: bedrooms,
      SurfaceM2: surfaceM2,
      AgentName: sourceLabel(source),
      AgentPhone: "",
      AgentMobile: "",
      AgentEmail: "",
      AgentWebsite: "",
      PhotoCount: data.image ? 1 : 0,
      PhotoUrls: data.image || "",
      Title: data.title || `${sourceLabel(source)} - ${location.name}`,
      Url: data.url || url
    },
    diagnostic: {
      source: sourceLabel(source),
      location: location.name,
      status: "Fiche exploitable",
      message: `${price} EUR`,
      url: data.url || url
    }
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const maxPrice = Number(config.maxPrice || DEFAULT_MAX_PRICE);
  const sources = args.sources.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const listings = [];
  const diagnostics = [];
  const networkDumps = [];
  const seenUrls = new Set();
  const chrome = await startChrome(args);
  console.log(`Chrome profile: ${chrome.profileDir}`);

  try {
    const locations = args.locationLimit > 0 ? (config.locations || []).slice(0, args.locationLimit) : (config.locations || []);
    if (asBoolean(args.setupOnly)) {
      const setupLocations = locations.slice(0, Math.max(1, Math.min(locations.length, 2)));
      for (const location of setupLocations) {
        for (const source of sources) {
          const url = searchUrl(source, location, maxPrice);
          console.log(`Setup navigateur: ${sourceLabel(source)} ${location.name} -> ${url}`);
          await chrome.page.navigate(url, args.navigationTimeoutMs, args.delayMs);
        }
      }
      console.log(`Setup ouvert. Attente ${args.setupWaitMs} ms pour cookies/consentements/challenges si Chrome est visible.`);
      await sleep(args.setupWaitMs);
      return;
    }

    for (const location of locations) {
      for (const source of sources) {
        const url = searchUrl(source, location, maxPrice);
        try {
          const nav = await chrome.page.navigate(url, args.navigationTimeoutMs, args.delayMs);
          const links = await extractCandidateLinks(chrome.page, source, url);
          const networkPayloadCount = chrome.page.networkPayloads.length;
          for (const payload of chrome.page.networkPayloads) {
            networkDumps.push({
              source: sourceLabel(source),
              location: location.name,
              pageUrl: url,
              responseUrl: payload.url,
              status: payload.status,
              mimeType: payload.mimeType,
              type: payload.type,
              sample: String(payload.body || "").slice(0, 1200)
            });
          }
          const textSample = await pageTextSample(chrome.page);
          const blocked = /un instant|just a moment|checking your browser|service unavailable|access denied|forbidden/i.test(`${nav.title}\n${textSample}`);
          diagnostics.push({
            source: sourceLabel(source),
            location: location.name,
            status: blocked ? "Blocage navigateur" : (nav.status && nav.status >= 400 ? `HTTP ${nav.status}` : "Recherche navigateur OK"),
            message: `${links.length} lien(s) candidat(s), ${networkPayloadCount} reponse(s) reseau capturee(s), titre: ${nav.title || ""}`.trim(),
            url
          });

          for (const detailUrl of links.slice(0, args.maxDetailPerLocation)) {
            const cleanUrl = detailUrl.replace(/#.*$/, "").replace(/\?.*$/, "");
            if (seenUrls.has(cleanUrl)) continue;
            seenUrls.add(cleanUrl);

            const { listing, diagnostic } = await extractDetail(chrome.page, source, location, detailUrl, args, maxPrice);
            diagnostics.push(diagnostic);
            if (listing) listings.push(listing);
          }
        } catch (error) {
          diagnostics.push({
            source: sourceLabel(source),
            location: location.name,
            status: "Erreur navigateur",
            message: error.message,
            url
          });
        }
      }
    }
  } finally {
    chrome.stop();
  }

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify({ generatedAt: new Date().toISOString(), count: listings.length, listings }, null, 2), "utf8");
  fs.writeFileSync(args.diagnosticsJson, JSON.stringify({ generatedAt: new Date().toISOString(), count: diagnostics.length, diagnostics }, null, 2), "utf8");
  fs.writeFileSync(args.networkJson, JSON.stringify({ generatedAt: new Date().toISOString(), count: networkDumps.length, networkDumps }, null, 2), "utf8");
  writeCsv(args.outCsv, listings, [
    "Source", "Id", "RequestedLocation", "Locality", "PostalCode", "Address", "Latitude", "Longitude",
    "GeoPrecision", "Price", "Bedrooms", "SurfaceM2", "AgentName", "AgentPhone", "AgentMobile",
    "AgentEmail", "AgentWebsite", "PhotoCount", "PhotoUrls", "Title", "Url"
  ]);
  writeCsv(args.diagnosticsCsv, diagnostics, ["source", "location", "status", "message", "url"]);
  console.log(`Browser listings: ${listings.length}`);
  console.log(`Browser diagnostics: ${diagnostics.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
