const { app, BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const REMOTE_RESULTS_BASE_URL = "https://lmpg-devel.github.io/veille-immo-report/";
const REMOTE_RESULTS_FILES = new Set(["results.json", "results-terrain.json"]);
const DIAGNOSTIC_LOG = path.join(app.getPath("temp"), "veille-immo-startup.log");
const DESKTOP_ZOOM_FACTOR = 0.67;

function diagnostic(message) {
  fs.appendFileSync(DIAGNOSTIC_LOG, new Date().toISOString() + " " + message + "\n");
}

app.setName("Veille Immo");
app.setAppUserModelId("be.unaa.veilleimmo");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-proxy-server");

function contentType(filePath) {
  return {
    ".css": "text/css; charset=utf-8",
    ".geojson": "application/geo+json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function remoteResults(relativePath) {
  const response = await fetch(REMOTE_RESULTS_BASE_URL + relativePath + "?t=" + Date.now(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return Buffer.from(await response.arrayBuffer());
}

function resultsPayloadInfo(content) {
  const payload = JSON.parse(Buffer.isBuffer(content) ? content.toString("utf8") : String(content || ""));
  const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
  const bySource = listings.reduce((acc, listing) => {
    const source = String(listing && listing.source || "Source inconnue");
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  return { count: listings.length, bySource };
}

function sourceCount(bySource, needle) {
  return Object.keys(bySource || {}).reduce((total, source) => {
    return source.toLowerCase().includes(needle) ? total + bySource[source] : total;
  }, 0);
}

function remoteResultsLooksComplete(remoteContent, bundledContent, relativePath) {
  const bundled = resultsPayloadInfo(bundledContent);
  if (bundled.count === 0) {
    return true;
  }
  const remote = resultsPayloadInfo(remoteContent);
  if (remote.count === 0) {
    return false;
  }
  if (remote.count < Math.max(1, Math.floor(bundled.count * 0.35))) {
    return false;
  }
  if (relativePath === "results.json") {
    const bundledImmoweb = sourceCount(bundled.bySource, "immoweb");
    const remoteImmoweb = sourceCount(remote.bySource, "immoweb");
    if (bundledImmoweb >= 25 && remoteImmoweb < Math.max(25, Math.floor(bundledImmoweb * 0.2))) {
      return false;
    }
  }
  return true;
}

function startLocalServer() {
  const webRoot = path.join(__dirname, "..", "web");
  diagnostic("webRoot=" + webRoot + " exists=" + fs.existsSync(webRoot));
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const relativePath = requestUrl.pathname === "/" ? "index.html" : decodeURIComponent(requestUrl.pathname.slice(1));
      const filePath = path.resolve(webRoot, relativePath);
      if (!filePath.startsWith(webRoot + path.sep) && filePath !== path.join(webRoot, "index.html")) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let content;
      if (REMOTE_RESULTS_FILES.has(relativePath)) {
        const bundledContent = fs.readFileSync(filePath);
        try {
          const remoteContent = await remoteResults(relativePath);
          if (!remoteResultsLooksComplete(remoteContent, bundledContent, relativePath)) {
            throw new Error("remote results look incomplete");
          }
          content = remoteContent;
        } catch {
          content = bundledContent;
        }
      } else {
        content = fs.readFileSync(filePath);
      }
      response.writeHead(200, {
        "Content-Type": contentType(filePath),
        "Cache-Control": "no-store"
      });
      response.end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      url: "http://127.0.0.1:" + server.address().port + "/"
    }));
  });
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#f4f6f8",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: 0.67
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.setZoomFactor(DESKTOP_ZOOM_FACTOR);
  window.webContents.on("did-navigate", () => {
    window.webContents.setZoomFactor(DESKTOP_ZOOM_FACTOR);
  });

  if (process.env.VEILLE_IMMO_QA_SCREENSHOT) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const requestedMode = process.env.VEILLE_IMMO_QA_SEARCH_MODE;
        if (requestedMode === "house" || requestedMode === "land") {
          await window.webContents.executeJavaScript(
            `window.VeilleImmoPwa && window.VeilleImmoPwa.setSearchMode(${JSON.stringify(requestedMode)})`
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        const screenshot = await window.webContents.capturePage();
        fs.writeFileSync(process.env.VEILLE_IMMO_QA_SCREENSHOT, screenshot.toPNG());
        const state = await window.webContents.executeJavaScript(`({
          title: document.title,
          bodyTextLength: (document.body && document.body.innerText || "").trim().length,
          cards: document.querySelectorAll(".listing-card").length,
          markers: document.querySelectorAll(".leaflet-marker-icon").length,
          mapHeight: document.getElementById("map") ? Math.round(document.getElementById("map").getBoundingClientRect().height) : 0,
          mainWidth: document.querySelector("main") ? Math.round(document.querySelector("main").getBoundingClientRect().width) : 0,
          headingHeight: document.querySelector("h1") ? Math.round(document.querySelector("h1").getBoundingClientRect().height) : 0,
          searchMode: window.VeilleImmoPwa && window.VeilleImmoPwa.searchMode ? window.VeilleImmoPwa.searchMode() : null,
          priceMax: document.querySelector('input[type="range"]') ? document.querySelector('input[type="range"]').max : null,
          activeSearch: Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map((item) => item.textContent.trim()).find((text) => /Maisons|Terrains/.test(text)) || null
        })`);
        state.zoomFactor = window.webContents.getZoomFactor();
        if (process.env.VEILLE_IMMO_QA_STATE) {
          fs.writeFileSync(process.env.VEILLE_IMMO_QA_STATE, JSON.stringify(state, null, 2));
        }
        app.quit();
      }, 10000);
    });
  }

  window.loadURL(url);
}

let localServer;

diagnostic("module-loaded");

app.whenReady().then(async () => {
  diagnostic("app-ready");
  localServer = await startLocalServer();
  diagnostic("server-ready " + localServer.url);
  createWindow(localServer.url);
  diagnostic("window-created");
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(localServer.url);
  });
}).catch((error) => {
  diagnostic("startup-error " + (error && error.stack || error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (localServer && localServer.server) localServer.server.close();
  if (process.platform !== "darwin") app.quit();
});
