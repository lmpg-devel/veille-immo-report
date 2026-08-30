import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const RESULT_PATH = path.join(ROOT, "results.json");

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Chrome introuvable");
  return found;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".geojson": "application/geo+json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function listingKey(listing) {
  const rawUrl = String(listing?.url || "").trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return (parsed.origin + parsed.pathname).toLowerCase();
    } catch {
      return rawUrl.split(/[?#]/)[0].toLowerCase();
    }
  }
  return String(listing?.id || "").trim().toLowerCase();
}

function listingLaunchIds(listing) {
  const stable = listingKey(listing);
  const raw = String(listing?.id || "").trim();
  return [stable, raw && raw.toLowerCase() !== stable ? raw : ""].filter(Boolean);
}

function publicationTime(listing) {
  const fields = ["publicationDate", "publishedAt", "publishedDate", "datePublished", "createdAt", "creationDate", "firstSeenAt", "firstSeen", "listedAt", "listingDate", "date"];
  for (const field of fields) {
    const value = listing?.[field];
    if (value == null || value === "") continue;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sourceCounts(listings) {
  return listings.reduce((acc, listing) => {
    const source = String(listing?.source || "Source inconnue");
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
}

function startServer(overrideResultsJson) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/__blank.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end("<!doctype html><title>qa blank</title>");
        return;
      }
      if (url.pathname === "/results.json") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(overrideResultsJson);
        return;
      }
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(ROOT, relative);
      if (!filePath.startsWith(ROOT)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const data = await fsp.readFile(filePath);
      response.writeHead(200, { "Content-Type": mimeFor(filePath), "Cache-Control": "no-store" });
      response.end(data);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, baseUrl });
    });
  });
}

function waitForFile(filePath, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout fichier ${filePath}`));
      }
    }, 100);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || "CDP error"));
        else resolve(message.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout CDP ${method}`));
        }
      }, 20000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ||
        result.exceptionDetails.exception?.value ||
        result.exceptionDetails.text ||
        "Runtime exception";
      throw new Error(detail);
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
    }
  }
}

async function waitFor(page, expression, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(expression).catch((error) => ({ error: error.message }));
    if (last?.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Condition non atteinte: ${JSON.stringify(last)}`);
}

async function startChrome(url) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "veille-immo-newness-qa-"));
  const devToolsFile = path.join(profileDir, "DevToolsActivePort");
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--window-size=1040,1280",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    url
  ], { stdio: "ignore" });
  await waitForFile(devToolsFile, 15000);
  const [port] = fs.readFileSync(devToolsFile, "utf8").trim().split(/\r?\n/);
  const tabs = await fetchJson(`http://127.0.0.1:${port}/json`);
  const tab = tabs.find((item) => item.type === "page") || tabs[0];
  const page = new Cdp(tab.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  return {
    page,
    async stop() {
      page.close();
      try {
        chrome.kill();
      } catch {
      }
      await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function buildScenario(payload) {
  const listings = Array.isArray(payload.listings) ? payload.listings : [];
  const now = Date.now();
  const cutoff = now - 72 * 60 * 60 * 1000;
  const recentListings = listings.filter((listing) => {
    const time = publicationTime(listing);
    return time && time <= now && time >= cutoff;
  });
  const recentPresent = recentListings.find((listing) => listingKey(listing) && Number.isFinite(Number(listing.latitude)) && Number.isFinite(Number(listing.longitude)));
  const absentOnly = listings.find((listing) => {
    const key = listingKey(listing);
    const time = publicationTime(listing);
    return key && key !== listingKey(recentPresent) && !(time && time <= now && time >= cutoff) && Number.isFinite(Number(listing.latitude)) && Number.isFinite(Number(listing.longitude));
  });
  if (!recentPresent || !absentOnly) {
    throw new Error("Scenario QA impossible: annonce recente ou annonce absente non recente introuvable");
  }

  const absentKey = listingKey(absentOnly);
  const expectedKeys = new Set(recentListings.map(listingKey).filter(Boolean));
  expectedKeys.add(absentKey);
  const expectedMarkerKeys = new Set(listings.filter((listing) => {
    const key = listingKey(listing);
    return expectedKeys.has(key) && Number.isFinite(Number(listing.latitude)) && Number.isFinite(Number(listing.longitude));
  }).map(listingKey));
  const previousIds = [];
  for (const listing of listings) {
    if (listingKey(listing) === absentKey) continue;
    previousIds.push(...listingLaunchIds(listing));
  }

  return {
    previousIds: Array.from(new Set(previousIds)),
    expectedKeys: Array.from(expectedKeys),
    expectedMarkerKeys: Array.from(expectedMarkerKeys),
    recentPresentKey: listingKey(recentPresent),
    absentOnlyKey: absentKey,
    sources: sourceCounts(listings)
  };
}

async function main() {
  const sourcePayload = JSON.parse(fs.readFileSync(RESULT_PATH, "utf8"));
  const testPayload = JSON.parse(JSON.stringify(sourcePayload));
  delete testPayload.newListings;
  const scenario = buildScenario(testPayload);
  const { server, baseUrl } = await startServer(JSON.stringify(testPayload));
  const chrome = await startChrome(`${baseUrl}/__blank.html`);
  try {
    await waitFor(chrome.page, `(() => ({ ok: location.href.indexOf('http://127.0.0.1:') === 0, href: location.href }))()`, 15000);
    await chrome.page.evaluate(`(() => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('veille-immo-search-mode', 'house');
      localStorage.setItem('veille-immo-show-option', '1');
      localStorage.setItem('veille-immo-location-distance-km', '15');
      localStorage.setItem('veille-immo-last-launch-ids-house', ${JSON.stringify(JSON.stringify(scenario.previousIds))});
      localStorage.setItem('veille-immo-initialized-house', '1');
      return { ok: true };
    })()`);

    await chrome.page.send("Page.navigate", { url: `${baseUrl}/index.html?qa=${Date.now()}` });
    await waitFor(chrome.page, `(() => ({
      ok: Boolean(window.veilleImmoNewListingState && window.veilleImmoPriceFilterState && document.querySelector('#newListingsOnlyToggle') && window.veilleImmoRenderedMarkerLayers),
      state: window.veilleImmoNewListingState || null,
      price: window.veilleImmoPriceFilterState || null
    }))()`, 45000);

    const result = await chrome.page.evaluate(`(() => {
      function keyFor(listing) {
        const raw = String(listing && listing.url || '').trim();
        if (raw) {
          try {
            const parsed = new URL(raw, location.href);
            return (parsed.origin + parsed.pathname).toLowerCase();
          } catch {
            return raw.split(/[?#]/)[0].toLowerCase();
          }
        }
        return String(listing && listing.id || '').trim().toLowerCase();
      }
      const expected = new Set(${JSON.stringify(scenario.expectedKeys)});
      const expectedMarkerKeys = new Set(${JSON.stringify(scenario.expectedMarkerKeys)});
      const recentPresentKey = ${JSON.stringify(scenario.recentPresentKey)};
      const absentOnlyKey = ${JSON.stringify(scenario.absentOnlyKey)};
      const state = window.veilleImmoNewListingState || {};
      const stateIds = new Set(Array.isArray(state.ids) ? state.ids : []);
      const missingExpected = Array.from(expected).filter((key) => !stateIds.has(key));
      const extra = Array.from(stateIds).filter((key) => !expected.has(key));
      const countText = (document.querySelector('#newListingsCount') || {}).textContent || '';
      const sourceNote = (document.querySelector('#otherSourcesSection .other-source-note') || {}).textContent || '';
      const sourceDiagnosticsText = (document.querySelector('#otherSourcesSection') || {}).textContent || '';

      const chip = document.querySelector('.location-chip');
      const activeBefore = document.querySelectorAll('.location-chip.is-active').length;
      if (chip) chip.click();
      const activeAfterChipClick = document.querySelectorAll('.location-chip.is-active').length;
      const firstChipPressedAfterClick = chip ? chip.getAttribute('aria-pressed') : null;
      const selectAll = document.querySelector('#locationSelectAll');
      if (selectAll) selectAll.click();
      const activeAfterSelectAll = document.querySelectorAll('.location-chip.is-active').length;

      const markerListings = window.veilleImmoRenderedMarkerListings || [];
      const markerLayers = window.veilleImmoRenderedMarkerLayers || [];
      const markerChecks = [];
      markerListings.forEach((listing, index) => {
        const key = keyFor(listing);
        if (!expectedMarkerKeys.has(key)) return;
        const source = String(listing && listing.source || '').toLowerCase();
        const expectedColor = source.includes('immoweb')
          ? 'rgb(11, 92, 134)'
          : (source.includes('immovlan') ? 'rgb(225, 29, 72)' : '');
        const icon = markerLayers[index] && markerLayers[index]._icon;
        const star = icon && icon.querySelector('.source-map-star');
        markerChecks.push({
          key,
          source,
          hasStar: Boolean(star),
          color: star ? getComputedStyle(star).color : '',
          expectedColor
        });
      });

      const toggle = document.querySelector('#newListingsOnlyToggle');
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const filteredState = window.veilleImmoPriceFilterState || {};
      const visibleCards = Array.from(document.querySelectorAll('.listing-card')).filter((card) => !card.hidden);
      const visibleNewCards = visibleCards.filter((card) => card.classList.contains('is-new-listing') && card.querySelector('.new-badge'));
      const visibleStars = Array.from(document.querySelectorAll('.source-map-star')).filter((star) => {
        const marker = star.closest('.leaflet-marker-icon');
        return marker && marker.style.display !== 'none';
      });

      return {
        ok: state.count === expected.size
          && state.criterion === 'absent-ouverture-precedente-ou-publication-fiable-72h'
          && missingExpected.length === 0
          && extra.length === 0
          && String(state.details && state.details[recentPresentKey] && state.details[recentPresentKey].reason || '').includes('publication-fiable-72h')
          && String(state.details && state.details[absentOnlyKey] && state.details[absentOnlyKey].reason || '').includes('absent-ouverture-precedente')
          && countText.includes(String(expected.size))
          && chip
          && activeAfterChipClick !== activeBefore
          && firstChipPressedAfterClick === 'false'
          && activeAfterSelectAll >= activeBefore
          && markerChecks.length === expectedMarkerKeys.size
          && markerChecks.every((item) => item.hasStar && item.expectedColor && item.color === item.expectedColor)
          && filteredState.showNewListingsOnly === true
          && filteredState.visibleCount === expected.size
          && visibleCards.length === expected.size
          && visibleNewCards.length === expected.size
          && visibleStars.length === expectedMarkerKeys.size
          && /Immoweb 544/.test(sourceNote)
          && /Immovlan 56/.test(sourceNote)
          && /Zimmo 0/.test(sourceNote)
          && /agences locales 0/.test(sourceNote)
          && /2ememain 0/.test(sourceNote)
          && /APIFY_TOKEN/.test(sourceDiagnosticsText)
          && /2ememain/.test(sourceDiagnosticsText),
        expectedCount: expected.size,
        expectedMarkerCount: expectedMarkerKeys.size,
        state,
        missingExpected,
        extra,
        countText: countText.trim(),
        chipClick: { activeBefore, activeAfterChipClick, firstChipPressedAfterClick, activeAfterSelectAll },
        markerChecks,
        filteredState,
        visibleCards: visibleCards.length,
        visibleNewCards: visibleNewCards.length,
        visibleStars: visibleStars.length,
        sourceNote: sourceNote.trim(),
        hasApifyDiagnostic: /APIFY_TOKEN/.test(sourceDiagnosticsText)
      };
    })()`);
    if (!result.ok) {
      throw new Error(`QA nouveautes/sources invalide: ${JSON.stringify(result, null, 2)}`);
    }

    await chrome.page.evaluate(`(() => {
      const panel = document.querySelector('#newListingFilterPanel');
      if (panel) panel.scrollIntoView({ block: 'center', inline: 'nearest' });
      return { ok: true };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screenshot = await chrome.page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const outDir = path.join(ROOT, "reports");
    await fsp.mkdir(outDir, { recursive: true });
    const screenshotPath = path.join(outDir, "validation-newness-sources-pwa.png");
    await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

    console.log(JSON.stringify({
      ok: true,
      url: `${baseUrl}/index.html`,
      scenario,
      result,
      screenshotPath
    }, null, 2));
  } finally {
    await chrome.stop();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
