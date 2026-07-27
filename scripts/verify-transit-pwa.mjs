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

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Chrome introuvable");
  }
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

function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(ROOT, relative);
      if (!filePath.startsWith(ROOT)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const data = await fsp.readFile(filePath);
      response.writeHead(200, {
        "Content-Type": mimeFor(filePath),
        "Cache-Control": "no-store"
      });
      response.end(data);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/index.html`
      });
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
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
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
        if (message.error) {
          reject(new Error(message.error.message || "CDP error"));
        } else {
          resolve(message.result);
        }
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
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
      throw new Error(result.exceptionDetails.text || "Runtime exception");
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
    if (last && last.ok) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Condition non atteinte: ${JSON.stringify(last)}`);
}

async function startChrome(url) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "veille-immo-pwa-verify-"));
  const devToolsFile = path.join(profileDir, "DevToolsActivePort");
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--window-size=820,1180",
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
      try {
        await fsp.rm(profileDir, { recursive: true, force: true });
      } catch {
      }
    }
  };
}

async function main() {
  const { server, url } = await startServer();
  const chrome = await startChrome(url);
  try {
    await waitFor(chrome.page, `(() => ({
      ok: Boolean(window.veilleImmoTransitRoutes && window.veilleImmoTransitRoutes.diagnostics && window.veilleImmoRenderedMarkerLayers && window.veilleImmoRenderedMarkerLayers.length),
      transit: window.veilleImmoTransitRoutes && window.veilleImmoTransitRoutes.diagnostics,
      markers: window.veilleImmoRenderedMarkerLayers && window.veilleImmoRenderedMarkerLayers.length
    }))()`);

    const distanceInitial = await waitFor(chrome.page, `(() => {
      const slider = document.querySelector('#locationDistanceSlider');
      const output = document.querySelector('#locationDistanceValue');
      const state = window.veilleImmoLocationDistanceState || {};
      return {
        ok: Boolean(slider && output && state.available && state.selected > 0),
        value: slider ? slider.value : null,
        output: output ? output.textContent.trim() : null,
        state,
        chips: document.querySelectorAll('.location-chip.is-active').length,
        markers: window.veilleImmoRenderedMarkerLayers && window.veilleImmoRenderedMarkerLayers.length
      };
    })()`);

    const distanceZero = await chrome.page.evaluate(`(() => {
      const slider = document.querySelector('#locationDistanceSlider');
      if (!slider) return { ok: false, reason: 'slider missing' };
      slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      const output = document.querySelector('#locationDistanceValue');
      const state = window.veilleImmoLocationDistanceState || {};
      return {
        ok: state.km === 0 && /0 km/.test(output ? output.textContent : '') && state.selected < ${distanceInitial.state.selected},
        value: slider.value,
        output: output ? output.textContent.trim() : null,
        state,
        chips: document.querySelectorAll('.location-chip.is-active').length,
        markers: window.veilleImmoRenderedMarkerLayers && window.veilleImmoRenderedMarkerLayers.length
      };
    })()`);
    if (!distanceZero.ok) {
      throw new Error(`Slider 0 km invalide: ${JSON.stringify(distanceZero)}`);
    }

    await waitFor(chrome.page, `(() => {
      const state = window.veilleImmoLocationDistanceState || {};
      const output = document.querySelector('#locationDistanceValue');
      const active = document.querySelectorAll('.location-chip.is-active').length;
      return {
        ok: state.km === 0 && /0 km/.test(output ? output.textContent : '') && active === state.selected && state.selected < ${distanceInitial.state.selected},
        state,
        active
      };
    })()`);
    const distanceMax = await chrome.page.evaluate(`(() => {
      const slider = document.querySelector('#locationDistanceSlider');
      if (!slider) return { ok: false, reason: 'slider missing' };
      slider.value = '15';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      const output = document.querySelector('#locationDistanceValue');
      const state = window.veilleImmoLocationDistanceState || {};
      return {
        ok: state.km === 15 && /15 km/.test(output ? output.textContent : '') && state.selected >= ${distanceInitial.state.selected},
        value: slider.value,
        output: output ? output.textContent.trim() : null,
        state,
        chips: document.querySelectorAll('.location-chip.is-active').length,
        markers: window.veilleImmoRenderedMarkerLayers && window.veilleImmoRenderedMarkerLayers.length
      };
    })()`);
    if (!distanceMax.ok) {
      throw new Error(`Slider 15 km invalide: ${JSON.stringify(distanceMax)}`);
    }

    await waitFor(chrome.page, `(() => {
      const state = window.veilleImmoLocationDistanceState || {};
      const output = document.querySelector('#locationDistanceValue');
      const active = document.querySelectorAll('.location-chip.is-active').length;
      return {
        ok: state.km === 15 && /15 km/.test(output ? output.textContent : '') && active === state.selected && state.selected >= ${distanceInitial.state.selected},
        state,
        active
      };
    })()`);

    await waitFor(chrome.page, `(() => {
      try {
        const seen = JSON.parse(localStorage.getItem('veille-immo-last-launch-ids') || '[]');
        const rendered = (window.veilleImmoRenderedMarkerListings || []).length;
        return { ok: Array.isArray(seen) && rendered > 0 && seen.length >= Math.max(100, Math.floor(rendered * 0.8)), seenCount: seen.length, rendered };
      } catch {
        return { ok: false, seenCount: 0 };
      }
    })()`);

    const newListingsCheck = await chrome.page.evaluate(`(async () => {
      const payload = await fetch('results.json?t=' + Date.now(), { cache: 'no-store' }).then((response) => response.json());
      const expectedIds = new Set(payload && payload.newListings && Array.isArray(payload.newListings.ids) ? payload.newListings.ids : []);
      const initialState = window.veilleImmoNewListingState || {};
      const markerListings = window.veilleImmoRenderedMarkerListings || [];
      const markerLayers = window.veilleImmoRenderedMarkerLayers || [];
      const newPanel = document.querySelector('#newListingFilterPanel');
      const toggle = document.querySelector('#newListingsOnlyToggle');
      const count = document.querySelector('#newListingsCount');
      if (!toggle || expectedIds.size === 0) {
        return { ok: false, reason: 'published snapshot or toggle missing', expectedCount: expectedIds.size, initialState };
      }

      const markerChecks = markerListings.map((listing, index) => {
        let key = '';
        try {
          const parsed = new URL(String(listing && listing.url || ''), location.href);
          key = (parsed.origin + parsed.pathname).toLowerCase();
        } catch {
          key = String(listing && listing.id || '').trim().toLowerCase();
        }
        if (!expectedIds.has(key)) return null;
        const source = String(listing && listing.source || '').toLowerCase();
        const expectedColor = source.includes('immoweb')
          ? 'rgb(11, 92, 134)'
          : (source.includes('immovlan') ? 'rgb(225, 29, 72)' : '');
        const icon = markerLayers[index] && markerLayers[index]._icon;
        const star = icon && icon.querySelector('.source-map-star');
        return {
          key,
          source,
          hasStar: Boolean(star),
          color: star ? getComputedStyle(star).color : '',
          expectedColor
        };
      }).filter(Boolean);

      const firstMarkerIndex = markerListings.findIndex((listing) => {
        try {
          const parsed = new URL(String(listing && listing.url || ''), location.href);
          return expectedIds.has((parsed.origin + parsed.pathname).toLowerCase());
        } catch {
          return expectedIds.has(String(listing && listing.id || '').trim().toLowerCase());
        }
      });
      if (firstMarkerIndex >= 0 && markerLayers[firstMarkerIndex] && markerLayers[firstMarkerIndex].openPopup) {
        markerLayers[firstMarkerIndex].openPopup();
      }
      const popupHasNewBadge = Boolean(document.querySelector('.leaflet-popup .map-popup-new'));
      const starsBeforeFilter = Array.from(document.querySelectorAll('.source-map-star')).length;
      const badgesBeforeFilter = Array.from(document.querySelectorAll('.new-badge')).length;

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const filteredState = window.veilleImmoPriceFilterState || {};
      const visibleCardsAfterFilter = Array.from(document.querySelectorAll('.listing-card')).filter((card) => !card.hidden).length;
      const visibleStarsAfterFilter = Array.from(document.querySelectorAll('.source-map-star')).filter((star) => {
        const marker = star.closest('.leaflet-marker-icon');
        return marker && marker.style.display !== 'none';
      }).length;
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));

      return {
        ok: initialState.count === expectedIds.size
          && initialState.criterion === 'absent-rapport-quotidien-precedent'
          && initialState.previousSource === 'previous-daily-report'
          && Boolean(newPanel)
          && !toggle.disabled
          && count && count.textContent.includes(String(expectedIds.size))
          && starsBeforeFilter >= expectedIds.size
          && badgesBeforeFilter >= expectedIds.size
          && popupHasNewBadge
          && markerChecks.length === expectedIds.size
          && markerChecks.every((item) => item.hasStar && item.expectedColor && item.color === item.expectedColor)
          && filteredState.showNewListingsOnly === true
          && filteredState.visibleCount === expectedIds.size
          && visibleCardsAfterFilter === expectedIds.size
          && visibleStarsAfterFilter >= expectedIds.size,
        expectedCount: expectedIds.size,
        initialState,
        countText: count ? count.textContent.trim() : '',
        starsBeforeFilter,
        badgesBeforeFilter,
        popupHasNewBadge,
        markerChecks,
        filteredState,
        visibleCardsAfterFilter,
        visibleStarsAfterFilter
      };
    })()`);
    if (!newListingsCheck.ok) {
      throw new Error(`Nouveautes invalides: ${JSON.stringify(newListingsCheck)}`);
    }

    const opened = await chrome.page.evaluate(`(() => {
      function listingUrlKey(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        try {
          const parsed = new URL(raw, location.href);
          return (parsed.origin + parsed.pathname).toLowerCase();
        } catch {
          return raw.split(/[?#]/)[0].toLowerCase();
        }
      }
      const routes = (window.veilleImmoTransitRoutes && window.veilleImmoTransitRoutes.routes) || {};
      const listings = window.veilleImmoRenderedMarkerListings || [];
      const layers = window.veilleImmoRenderedMarkerLayers || [];
      const index = listings.findIndex((listing) => {
        const key = listingUrlKey(listing && listing.url) || String(listing && listing.id || '').trim().toLowerCase();
        return routes[key] && ((routes[key].bourse && routes[key].bourse.available) || (routes[key].decoster && routes[key].decoster.available));
      });
      if (index < 0 || !layers[index]) return { ok: false, reason: 'no candidate marker' };
      layers[index].openPopup();
      return { ok: true, index, title: listings[index].title };
    })()`);
    if (!opened.ok) {
      throw new Error(JSON.stringify(opened));
    }

    await waitFor(chrome.page, `(() => ({ ok: Boolean(document.querySelector('.leaflet-popup .route-preview-toggle[data-route-mode="transit"]:not([disabled])')) }))()`);
    const checked = await chrome.page.evaluate(`(() => {
      const input = document.querySelector('.leaflet-popup .route-preview-toggle[data-route-mode="transit"]:not([disabled])');
      if (!input) return { ok: false, reason: 'input missing' };
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        routeId: input.dataset.routeId,
        listingKey: input.dataset.listingKey
      };
    })()`);
    if (!checked.ok) {
      throw new Error(JSON.stringify(checked));
    }

    const drawn = await waitFor(chrome.page, `(() => {
      const state = window.veilleImmoTransitPreviewState || {};
      const routeState = window.veilleImmoRoutePreviewState || {};
      const layer = window.veilleImmoRoutePreviewLayer;
      const layerCount = layer && layer._layers ? Object.keys(layer._layers).length : 0;
      const status = document.querySelector('.route-preview-status');
      const pane = window.veilleImmoMap && window.veilleImmoMap.getPane && window.veilleImmoMap.getPane('routePreviewPane');
      const routeLines = document.querySelectorAll('.route-preview-line').length;
      const routeHalos = document.querySelectorAll('.route-preview-halo').length;
      const connectors = document.querySelectorAll('.route-stop-connector').length;
      const stopLabels = document.querySelectorAll('.route-stop-tooltip').length;
      const strokes = Array.from(document.querySelectorAll('.route-preview-line')).map((line) => (line.getAttribute('stroke') || '').toLowerCase());
      const hasNetworkTile = Boolean(window.veilleImmoTransitTileLayerActive);
      return {
        ok: state.source === 'gtfs-precomputed'
          && state.segments > 0
          && state.straightFallback === false
          && layerCount > 0
          && routeLines > 0
          && routeHalos > 0
          && connectors >= 2
          && stopLabels >= 2
          && !hasNetworkTile
          && strokes.includes('#111111')
          && strokes.includes('#2563eb')
          && strokes.includes('#f2a900')
          && strokes.includes('#16a34a')
          && status
          && status.style.display !== 'none'
          && /TC/.test(status.textContent || '')
          && Boolean(pane),
        state,
        routeState,
        layerCount,
        routeLines,
        routeHalos,
        connectors,
        stopLabels,
        strokes,
        hasNetworkTile,
        statusText: status ? status.textContent.trim().replace(/\\s+/g, ' ') : '',
        panePresent: Boolean(pane)
      };
    })()`, 15000);

    await chrome.page.evaluate(`(() => {
      const map = document.querySelector('.leaflet-container');
      if (map) {
        map.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      return { ok: true };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screenshot = await chrome.page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const outDir = path.join(ROOT, "reports");
    await fsp.mkdir(outDir, { recursive: true });
    const screenshotPath = path.join(outDir, "validation-transit-pwa.png");
    await fsp.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    console.log(JSON.stringify({
      ok: true,
      url,
      distanceInitial,
      distanceZero,
      distanceMax,
      opened,
      checked,
      newListingsCheck,
      drawn,
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
