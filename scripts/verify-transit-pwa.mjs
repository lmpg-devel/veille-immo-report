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
      opened,
      checked,
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
