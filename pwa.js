(function () {
  "use strict";

const APP_VERSION = "pwa-2026-06-20-02";
  const RESULTS_URL = "results.json";
  const CONFIG_URL = "config/veille-immo.json";
  const STORAGE_KEY = "veille-immo-seen-ids";
  const INIT_KEY = "veille-immo-initialized";
  const LOCAL_IMPORTS_KEY = "veille-immo-local-zimmo-imports";
  let deferredInstallPrompt = null;
  let latestPayload = null;
  let latestConfig = null;

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function injectControls() {
    if (document.getElementById("pwaControls")) {
      return;
    }

    const style = document.createElement("style");
    style.textContent = [
      ".pwa-controls{position:fixed;right:14px;bottom:14px;z-index:10001;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
      ".pwa-controls button{border:1px solid #c8d1d8;background:#fff;color:#17202a;border-radius:6px;padding:9px 11px;font:600 13px Arial,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.14)}",
      ".pwa-controls button.primary{background:#0b5c86;border-color:#0b5c86;color:#fff}",
      ".pwa-status{position:fixed;left:14px;bottom:62px;z-index:10001;max-width:420px;background:#17202a;color:#fff;border-radius:8px;padding:10px 12px;font:13px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)}",
      ".other-source-note{background:#eef7fb;border:1px solid #b8d9e8;border-radius:6px;padding:12px 14px;margin:18px 0;color:#253540}",
      ".source-diagnostic-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:12px 0 20px}",
      ".source-diagnostic-item{background:#fff;border:1px solid #d9e0e4;border-radius:6px;padding:10px}",
      ".source-diagnostic-item strong{display:block;margin-bottom:4px}",
      ".source-badge-row{display:flex;align-items:center;gap:8px;margin-bottom:9px}",
      ".source-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;color:#fff;font:700 11px/1 Arial,sans-serif;text-transform:uppercase;letter-spacing:.02em}",
      ".source-badge-immoweb{background:#0b5c86}",
      ".source-badge-immovlan{background:#e11d48}",
      ".source-badge-zimmo{background:#7c3aed}",
      ".source-badge-agency{background:#2f6f3e}",
      ".source-badge-p2p{background:#d97706}",
      ".source-map-icon-wrap{background:transparent;border:0}",
      ".source-map-pin{display:block;width:18px;height:18px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 2px 7px rgba(0,0,0,.35)}",
      ".source-map-pin::after{content:'';position:absolute;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.88);left:6px;top:6px}",
      ".source-map-pin-immoweb{background:#0b5c86}",
      ".source-map-pin-immovlan{background:#e11d48}",
      ".source-map-pin-zimmo{background:#7c3aed}",
      ".source-map-pin-agency{background:#2f6f3e}",
      ".source-map-pin-p2p{background:#d97706}",
      ".zimmo-import-panel{background:#fff;border:1px solid #d4dce2;border-radius:6px;padding:12px 14px;margin:14px 0 96px}",
      ".zimmo-import-panel h3{margin:0 0 10px;font-size:16px}",
      ".zimmo-import-grid{display:grid;grid-template-columns:minmax(160px,1fr) repeat(2,auto);gap:8px;align-items:end}",
      ".zimmo-import-panel label{display:flex;flex-direction:column;gap:4px;font:600 12px Arial,sans-serif;color:#33424d}",
      ".zimmo-import-panel select,.zimmo-import-panel input,.zimmo-import-panel textarea{border:1px solid #cbd5dc;border-radius:5px;padding:8px;font:14px Arial,sans-serif;background:#fff;color:#17202a}",
      ".zimmo-import-panel textarea{width:100%;min-height:86px;resize:vertical;margin-top:10px}",
      ".zimmo-import-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px}",
      ".zimmo-import-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}",
      ".zimmo-import-actions button,.zimmo-import-grid button{border:1px solid #0b5c86;background:#0b5c86;color:#fff;border-radius:5px;padding:8px 10px;font:700 13px Arial,sans-serif}",
      ".zimmo-import-actions button.secondary,.zimmo-import-grid button.secondary{background:#fff;color:#0b5c86}",
      ".zimmo-import-status{font:13px Arial,sans-serif;color:#33424d}",
      "@media(max-width:680px){.pwa-controls{left:12px;right:12px}.pwa-controls button{flex:1}}"
    ].join("");
    document.head.appendChild(style);

    const controls = document.createElement("div");
    controls.id = "pwaControls";
    controls.className = "pwa-controls";

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.textContent = "Verifier";
    refreshButton.addEventListener("click", function () {
      checkForNewListings(true);
    });
    controls.appendChild(refreshButton);

    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.textContent = "Actualiser app";
    updateButton.addEventListener("click", hardRefreshApplication);
    controls.appendChild(updateButton);

    const zimmoButton = document.createElement("button");
    zimmoButton.type = "button";
    zimmoButton.textContent = "Importer Zimmo";
    zimmoButton.addEventListener("click", function () {
      const panel = document.getElementById("zimmoImportPanel");
      if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
        const textarea = document.getElementById("zimmoImportText");
        if (textarea) textarea.focus();
      } else {
        showStatus("Le module Zimmo se charge avec les resultats.");
      }
    });
    controls.appendChild(zimmoButton);

    if ("Notification" in window) {
      const notificationButton = document.createElement("button");
      notificationButton.type = "button";
      notificationButton.textContent = "Notifications";
      notificationButton.addEventListener("click", requestNotifications);
      controls.appendChild(notificationButton);
    }

    const installButton = document.createElement("button");
    installButton.type = "button";
    installButton.id = "pwaInstallFloatingButton";
    installButton.className = "primary";
    installButton.textContent = "Installer";
    installButton.hidden = isStandalone();
    installButton.addEventListener("click", promptInstall);
    controls.appendChild(installButton);

    document.body.appendChild(controls);
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return null;
    }
    const registration = await navigator.serviceWorker.register("sw.js");
    registration.addEventListener("updatefound", function () {
      const installing = registration.installing;
      if (!installing) {
        return;
      }
      installing.addEventListener("statechange", function () {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          showStatus("Nouvelle version prete. Touche Actualiser app.");
        }
      });
    });
    if (registration.waiting) {
      showStatus("Nouvelle version prete. Touche Actualiser app.");
    }
    try {
      await registration.update();
    } catch (error) {
    }
    if ("periodicSync" in registration) {
      try {
        await registration.periodicSync.register("check-listings", {
          minInterval: 24 * 60 * 60 * 1000
        });
      } catch (error) {
        // Android/Chrome may refuse this unless the PWA is installed and eligible.
      }
    }
    return registration;
  }

  function showStatus(message) {
    let node = document.getElementById("pwaStatus");
    if (!node) {
      node = document.createElement("div");
      node.id = "pwaStatus";
      node.className = "pwa-status";
      document.body.appendChild(node);
    }
    node.textContent = message;
    window.setTimeout(function () {
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }, 9000);
  }

  async function hardRefreshApplication() {
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration && registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        if (registration && registration.active) {
          registration.active.postMessage({ type: "CLEAR_RUNTIME_CACHE" });
          await registration.update();
        }
      }
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.filter(function (name) {
          return name.indexOf("veille-immo-pwa-") === 0;
        }).map(function (name) {
          return caches.delete(name);
        }));
      }
    } catch (error) {
    }
    window.location.replace(window.location.pathname + "?refresh=" + Date.now());
  }

  function seenIdsFromStorage() {
    try {
      return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
    } catch (error) {
      return new Set();
    }
  }

  function saveSeenIds(ids) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
    localStorage.setItem(INIT_KEY, "1");
  }

  async function fetchResults() {
    const response = await fetch(RESULTS_URL + "?t=" + Date.now(), {
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return response.json();
  }

  async function fetchConfig() {
    const response = await fetch(CONFIG_URL + "?t=" + Date.now(), {
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return response.json();
  }

  function listingText(listing) {
    const price = listing.price ? new Intl.NumberFormat("fr-BE").format(listing.price) + " EUR" : "Prix inconnu";
    const locality = listing.locality || "Commune inconnue";
    return price + " - " + locality;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatPrice(value) {
    const number = Number(value || 0);
    return number > 0 ? new Intl.NumberFormat("fr-BE").format(number) + " EUR" : "Prix a verifier";
  }

  function sourceCounts(listings) {
    return listings.reduce(function (acc, listing) {
      const source = String(listing.source || "Source inconnue");
      acc[source] = (acc[source] || 0) + 1;
      return acc;
    }, {});
  }

  function sourceKind(source) {
    const value = String(source || "").toLowerCase();
    if (value.indexOf("immoweb") !== -1) return "immoweb";
    if (value.indexOf("immovlan") !== -1) return "immovlan";
    if (value.indexOf("zimmo") !== -1) return "zimmo";
    if (value.indexOf("2ememain") !== -1 || value.indexOf("particulier") !== -1) return "p2p";
    return "agency";
  }

  function sourceLabel(source) {
    const kind = sourceKind(source);
    if (kind === "immoweb") return "Immoweb";
    if (kind === "immovlan") return "Immovlan";
    if (kind === "zimmo") return "Zimmo";
    if (kind === "p2p") return String(source || "").toLowerCase().indexOf("2ememain") !== -1 ? "2ememain" : "Particulier";
    return "Agence locale";
  }

  function renderSourceBadge(source) {
    const kind = sourceKind(source);
    return "<div class='source-badge-row'><span class='source-badge source-badge-" + kind + "'>" + escapeHtml(sourceLabel(source)) + "</span></div>";
  }

  function sourceMarkerIcon(source) {
    if (!window.L) {
      return null;
    }
    const kind = sourceKind(source);
    return window.L.divIcon({
      className: "source-map-icon-wrap",
      html: "<span class='source-map-pin source-map-pin-" + kind + "'></span>",
      iconSize: [24, 24],
      iconAnchor: [12, 24],
      popupAnchor: [0, -22]
    });
  }

  function shortHash(value) {
    let hash = 0x811c9dc5;
    String(value || "").split("").forEach(function (char) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    });
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function readLocalImports() {
    try {
      const value = JSON.parse(localStorage.getItem(LOCAL_IMPORTS_KEY) || "[]");
      return Array.isArray(value) ? value.filter(function (item) {
        return item && item.source === "Zimmo";
      }) : [];
    } catch (error) {
      return [];
    }
  }

  function writeLocalImports(items) {
    localStorage.setItem(LOCAL_IMPORTS_KEY, JSON.stringify(items));
  }

  function mergeLocalImports(payload) {
    const base = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const imports = readLocalImports();
    const byId = {};
    base.concat(imports).forEach(function (listing) {
      const id = String(listing.id || listing.url || shortHash(JSON.stringify(listing)));
      byId[id] = Object.assign({}, listing, { id: id });
    });
    return Object.assign({}, payload || {}, {
      listings: Object.keys(byId).map(function (id) { return byId[id]; })
    });
  }

  function locationsFromConfig(config) {
    return Array.isArray(config && config.locations) ? config.locations : [];
  }

  function selectedLocation(config) {
    const select = document.getElementById("zimmoImportLocation");
    const index = select ? Number(select.value || 0) : 0;
    const locations = locationsFromConfig(config);
    return locations[Math.max(0, Math.min(index, locations.length - 1))] || null;
  }

  function zimmoSearchUrl(location, config) {
    const maxPrice = Number(config && config.maxPrice ? config.maxPrice : 285000);
    if (!location) return "https://www.zimmo.be/fr/rechercher/?search=";
    return "https://www.zimmo.be/fr/" + encodeURIComponent(location.zimmoSlug || slugForPath(location.name)) + "-" + encodeURIComponent(location.postalCode || "") + "/a-vendre/maison/?priceIncludeUnknown=0&priceMax=" + encodeURIComponent(maxPrice);
  }

  function parsePriceFromText(text) {
    const match = String(text || "").match(/(\d[\d .,\u00a0\u202f]{3,})[ \t\u00a0\u202f]*(?:EUR|€)/i);
    if (!match) return "";
    const value = Number(match[1].replace(/[^\d]/g, ""));
    return Number.isFinite(value) ? value : "";
  }

  function firstNumber(regex, text) {
    const match = String(text || "").match(regex);
    return match ? Number(match[1].replace(/[^\d]/g, "")) || "" : "";
  }

  function firstUrl(text) {
    const match = String(text || "").match(/https?:\/\/(?:www\.)?zimmo\.be[^\s<>"']*/i);
    return match ? match[0].replace(/[),.;]+$/, "") : "";
  }

  function parseZimmoText(text, location) {
    const lines = String(text || "").split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    const url = firstUrl(text);
    const title = lines.find(function (line) {
      return !/^https?:\/\//i.test(line) && !/^(prix|contact|description)$/i.test(line);
    }) || (location ? "Annonce Zimmo - " + location.name : "Annonce Zimmo");
    const postal = location && location.postalCode ? location.postalCode : "";
    const addressMatch = postal ? String(text || "").match(new RegExp("([^\\n]{3,80}" + postal + "[^\\n]{0,80})", "i")) : null;
    const photoMatch = String(text || "").match(/https?:\/\/[^\s<>"']+\.(?:jpg|jpeg|png|webp)(?:\?[^\s<>"']*)?/i);
    return {
      title: title,
      url: url,
      price: parsePriceFromText(text),
      bedrooms: firstNumber(/(\d+)\s*(?:chambres?|slaapkamers?|bedrooms?)/i, text),
      surfaceM2: firstNumber(/(\d{2,4})\s*m(?:²|2|\b)/i, text),
      address: addressMatch ? addressMatch[1].trim() : "",
      photoUrl: photoMatch ? photoMatch[0] : ""
    };
  }

  function fillZimmoImportForm(data) {
    [
      ["zimmoImportTitle", data.title],
      ["zimmoImportUrl", data.url],
      ["zimmoImportPrice", data.price],
      ["zimmoImportBedrooms", data.bedrooms],
      ["zimmoImportSurface", data.surfaceM2],
      ["zimmoImportAddress", data.address],
      ["zimmoImportPhoto", data.photoUrl]
    ].forEach(function (pair) {
      const node = document.getElementById(pair[0]);
      if (node && pair[1] !== undefined && pair[1] !== "") node.value = pair[1];
    });
  }

  function readZimmoImportForm(config) {
    const location = selectedLocation(config);
    const value = function (id) {
      const node = document.getElementById(id);
      return node ? String(node.value || "").trim() : "";
    };
    const url = value("zimmoImportUrl") || firstUrl(value("zimmoImportText"));
    const title = value("zimmoImportTitle") || (location ? "Annonce Zimmo - " + location.name : "Annonce Zimmo");
    const photo = value("zimmoImportPhoto");
    const price = Number(String(value("zimmoImportPrice")).replace(/[^\d]/g, "")) || 0;
    return {
      source: "Zimmo",
      id: "zimmo-local-" + shortHash(url || title + "|" + price + "|" + Date.now()),
      title: title,
      price: price,
      bedrooms: Number(value("zimmoImportBedrooms")) || "",
      surfaceM2: Number(value("zimmoImportSurface")) || "",
      locality: location ? location.name : "",
      requestedLocation: location ? location.name : "",
      postalCode: location ? location.postalCode : "",
      address: value("zimmoImportAddress") || (location ? location.name : ""),
      latitude: location ? Number(location.latitude) : "",
      longitude: location ? Number(location.longitude) : "",
      geoPrecision: "centre commune - import manuel Zimmo",
      agentName: "Zimmo",
      agentPhone: "",
      agentEmail: "",
      agentWebsite: "",
      photoCount: photo ? 1 : 0,
      photoUrl: photo,
      photoUrls: photo ? [photo] : [],
      url: url || "https://www.zimmo.be",
      localImport: true
    };
  }

  function setZimmoStatus(message) {
    const node = document.getElementById("zimmoImportStatus");
    if (node) node.textContent = message;
    showStatus(message);
  }

  function refreshRenderedPayload() {
    if (!latestPayload) return;
    const merged = mergeLocalImports(latestPayload);
    renderOtherSources(merged, latestConfig);
    annotateSourceBadges(merged);
    syncImportedZimmoMapMarkers(readLocalImports());
    bindZimmoAssistantEvents();
  }

  function saveZimmoImport(config) {
    const listing = readZimmoImportForm(config);
    if (!listing.price || listing.price > Number(config && config.maxPrice ? config.maxPrice : 285000)) {
      setZimmoStatus("Prix absent ou superieur au plafond.");
      return;
    }
    const imports = readLocalImports().filter(function (item) {
      return item.id !== listing.id && item.url !== listing.url;
    });
    imports.unshift(listing);
    writeLocalImports(imports.slice(0, 80));
    refreshRenderedPayload();
    setZimmoStatus("Annonce Zimmo ajoutee localement.");
  }

  function removeZimmoImport(id) {
    writeLocalImports(readLocalImports().filter(function (item) {
      return String(item.id) !== String(id);
    }));
    refreshRenderedPayload();
    setZimmoStatus("Annonce Zimmo retiree.");
  }

  function clearZimmoImports() {
    writeLocalImports([]);
    refreshRenderedPayload();
    setZimmoStatus("Imports Zimmo effaces.");
  }

  function syncImportedZimmoMapMarkers(imports) {
    if (!window.L || !window.veilleImmoMap) return;
    if (window.veilleImmoLocalZimmoLayer) {
      window.veilleImmoMap.removeLayer(window.veilleImmoLocalZimmoLayer);
    }
    const layer = window.L.layerGroup().addTo(window.veilleImmoMap);
    imports.forEach(function (listing) {
      const lat = Number(listing.latitude);
      const lon = Number(listing.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const marker = window.L.marker([lat, lon], { icon: sourceMarkerIcon("Zimmo") }).addTo(layer);
      marker.bindPopup([
        "<strong>" + escapeHtml(formatPrice(listing.price)) + "</strong><br>",
        "<span>Zimmo</span><br>",
        escapeHtml(listing.address || listing.locality || "") + "<br>",
        "<button type='button' class='external-link-button' data-external-url='" + escapeHtml(listing.url || "https://www.zimmo.be") + "'>Ouvrir l'annonce</button>"
      ].join(""));
    });
    window.veilleImmoLocalZimmoLayer = layer;
  }

  function annotateSourceBadges(payload) {
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const byId = listings.reduce(function (acc, listing) {
      if (listing.id) {
        acc[String(listing.id)] = listing;
      }
      return acc;
    }, {});
    document.querySelectorAll(".listing-card[id^='listing-']").forEach(function (card) {
      if (card.querySelector(".source-badge-row")) {
        return;
      }
      const id = String(card.id || "").replace(/^listing-other-/, "").replace(/^listing-/, "");
      const listing = byId[id];
      if (!listing) {
        return;
      }
      const body = card.querySelector(".listing-body");
      if (body) {
        body.insertAdjacentHTML("afterbegin", renderSourceBadge(listing.source));
      }
    });
  }

  function syncSourceMapMarkers(payload) {
    if (typeof window.veilleImmoRenderMapFromPayload === "function") {
      window.veilleImmoRenderMapFromPayload(payload);
    }
  }

  function renderDiagnosticSummary(diagnostics) {
    if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
      return "";
    }
    const groups = diagnostics.reduce(function (acc, item) {
      const source = String(item.source || "Source inconnue");
      const status = String(item.status || "Etat inconnu");
      const key = source + "||" + status;
      if (!acc[key]) {
        acc[key] = { source: source, status: status, count: 0, message: item.message || "", url: item.url || "" };
      }
      acc[key].count += 1;
      return acc;
    }, {});
    const rows = Object.keys(groups).sort().map(function (key) {
      const group = groups[key];
      return [
        "<tr>",
        "<td>" + escapeHtml(group.source) + "</td>",
        "<td>" + escapeHtml(group.status) + "</td>",
        "<td>" + escapeHtml(group.count) + "</td>",
        "<td>" + escapeHtml(group.message || "") + "</td>",
        "</tr>"
      ].join("");
    }).join("");
    return [
      "<details class='source-diagnostic-details'>",
      "<summary>Diagnostic technique des sources consultees</summary>",
      "<table><thead><tr><th>Source</th><th>Etat</th><th>Nb</th><th>Exemple</th></tr></thead><tbody>",
      rows,
      "</tbody></table>",
      "</details>"
    ].join("");
  }

  function renderPhotoStrip(listing) {
    const photos = Array.isArray(listing.photoUrls) ? listing.photoUrls.filter(Boolean) : [];
    const sources = photos.length ? photos : (listing.photoUrl ? [listing.photoUrl] : []);
    if (!sources.length) {
      return "<div class='photo-strip'><div class='photo-empty'>Photos non disponibles depuis cette source</div></div>";
    }
    return "<div class='photo-strip'>" + sources.slice(0, 12).map(function (src, index) {
      return [
        "<button type='button' class='photo-button' data-photo-src='" + escapeHtml(src) + "' data-photo-title='" + escapeHtml((listing.title || "Annonce") + " - photo " + (index + 1)) + "'>",
        "<img loading='lazy' src='" + escapeHtml(src) + "' alt='Photo annonce'>",
        "</button>"
      ].join("");
    }).join("") + "</div>";
  }

  function slugForPath(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function secondHandSearchUrl(location, maxPrice) {
    return "https://www.2ememain.be/l/immo/maisons-a-vendre/q/" + encodeURIComponent(slugForPath(location.name)) + "/?priceTo=" + encodeURIComponent(maxPrice);
  }

  function facebookMarketplaceSearchUrl(location, maxPrice) {
    return "https://www.facebook.com/marketplace/search/?query=" + encodeURIComponent("maison a vendre " + location.name + " " + maxPrice);
  }

  function privateWebSearchUrl(location, maxPrice) {
    return "https://www.bing.com/search?q=" + encodeURIComponent("maison a vendre " + location.name + " " + maxPrice + " particulier sans agence");
  }

  function renderZimmoImportPanel(config) {
    const locations = locationsFromConfig(config);
    const options = locations.map(function (location, index) {
      return "<option value='" + escapeHtml(index) + "'>" + escapeHtml(location.name + " " + (location.postalCode || "")) + "</option>";
    }).join("");
    return [
      "<section id='zimmoImportPanel' class='zimmo-import-panel'>",
      "<h3>Zimmo - import assiste</h3>",
      "<div class='zimmo-import-grid'>",
      "<label>Commune<select id='zimmoImportLocation'>" + options + "</select></label>",
      "<button id='zimmoOpenSearchButton' class='secondary' type='button'>Ouvrir Zimmo</button>",
      "<button id='zimmoParseButton' type='button'>Analyser le texte</button>",
      "</div>",
      "<textarea id='zimmoImportText' placeholder='Coller ici le lien ou le texte de l annonce Zimmo apres validation humaine'></textarea>",
      "<div class='zimmo-import-fields'>",
      "<label>Titre<input id='zimmoImportTitle' type='text'></label>",
      "<label>Prix EUR<input id='zimmoImportPrice' inputmode='numeric' type='text'></label>",
      "<label>Chambres<input id='zimmoImportBedrooms' inputmode='numeric' type='text'></label>",
      "<label>Surface m2<input id='zimmoImportSurface' inputmode='numeric' type='text'></label>",
      "<label>Adresse<input id='zimmoImportAddress' type='text'></label>",
      "<label>Lien annonce<input id='zimmoImportUrl' type='url'></label>",
      "<label>Photo URL<input id='zimmoImportPhoto' type='url'></label>",
      "</div>",
      "<div class='zimmo-import-actions'>",
      "<button id='zimmoSaveButton' type='button'>Ajouter a la carte</button>",
      "<button id='zimmoClearImportsButton' class='secondary' type='button'>Effacer imports Zimmo</button>",
      "<span id='zimmoImportStatus' class='zimmo-import-status'></span>",
      "</div>",
      "</section>"
    ].join("");
  }

  function bindZimmoAssistantEvents() {
    const panel = document.getElementById("zimmoImportPanel");
    if (!panel || panel.dataset.bound === "1") return;
    panel.dataset.bound = "1";
    const parseButton = document.getElementById("zimmoParseButton");
    const openButton = document.getElementById("zimmoOpenSearchButton");
    const saveButton = document.getElementById("zimmoSaveButton");
    const clearButton = document.getElementById("zimmoClearImportsButton");
    const textarea = document.getElementById("zimmoImportText");
    if (openButton) {
      openButton.addEventListener("click", function () {
        const url = zimmoSearchUrl(selectedLocation(latestConfig), latestConfig);
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (opened) opened.opener = null;
      });
    }
    if (parseButton) {
      parseButton.addEventListener("click", function () {
        fillZimmoImportForm(parseZimmoText(textarea ? textarea.value : "", selectedLocation(latestConfig)));
        setZimmoStatus("Texte analyse. Complete les champs manquants puis ajoute.");
      });
    }
    if (textarea) {
      textarea.addEventListener("paste", function () {
        window.setTimeout(function () {
          fillZimmoImportForm(parseZimmoText(textarea.value, selectedLocation(latestConfig)));
        }, 0);
      });
    }
    if (saveButton) {
      saveButton.addEventListener("click", function () {
        saveZimmoImport(latestConfig || {});
      });
    }
    if (clearButton) {
      clearButton.addEventListener("click", clearZimmoImports);
    }
  }

  function renderPrivateSourceLinks(config) {
    const locations = Array.isArray(config && config.locations) ? config.locations : [];
    const maxPrice = Number(config && config.maxPrice ? config.maxPrice : 285000);
    if (!locations.length) {
      return "";
    }
    const rows = locations.map(function (location) {
      return [
        "<tr>",
        "<td>" + escapeHtml(location.name || "") + "</td>",
        "<td><button type='button' class='external-link-button' data-external-url='" + escapeHtml(secondHandSearchUrl(location, maxPrice)) + "'>2ememain</button></td>",
        "<td><button type='button' class='external-link-button' data-external-url='" + escapeHtml(facebookMarketplaceSearchUrl(location, maxPrice)) + "'>Facebook</button></td>",
        "<td><button type='button' class='external-link-button' data-external-url='" + escapeHtml(privateWebSearchUrl(location, maxPrice)) + "'>Web privé</button></td>",
        "</tr>"
      ].join("");
    }).join("");
    return [
      "<h3>Particulier a particulier</h3>",
      "<div class='other-source-note'>2ememain est teste comme source experimentale. Facebook Marketplace et la recherche Web privee sont fournis comme liens de controle, car l'extraction automatique y depend souvent d'une session utilisateur.</div>",
      "<table><thead><tr><th>Commune</th><th>2ememain</th><th>Facebook Marketplace</th><th>Recherche web</th></tr></thead><tbody>",
      rows,
      "</tbody></table>"
    ].join("");
  }

  function renderOtherSources(payload, config) {
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const others = listings.filter(function (listing) {
      return String(listing.source || "").toLowerCase() !== "immoweb";
    });
    const existing = document.getElementById("otherSourcesSection");
    if (existing) {
      existing.remove();
    }

    const anchor = Array.from(document.querySelectorAll("h2")).find(function (heading) {
      return /annonces trouvees automatiquement/i.test(heading.textContent || "");
    });
    if (!anchor || !anchor.parentNode) {
      return;
    }

    const counts = sourceCounts(listings);
    const localAgencyCount = counts["Agence locale (site direct)"] || 0;
    const immovlanCount = counts.Immovlan || 0;
    const zimmoCount = counts.Zimmo || 0;
    const secondHandCount = counts["2ememain"] || 0;
    const zimmoMessage = zimmoCount > 0
      ? "Import Apify actif: " + zimmoCount + " annonce(s) integree(s)."
      : "Connecteur Apify pret: acteur dz_omar/zimmo-scraper identifie. Definir APIFY_TOKEN cote pipeline pour integrer les annonces Zimmo.";
    const section = document.createElement("section");
    section.id = "otherSourcesSection";
    section.innerHTML = [
      "<h2>Autres sources</h2>",
      "<div class='other-source-note'>Sources publiees dans cette PWA: Immoweb " + (counts.Immoweb || 0) + ", Immovlan " + immovlanCount + ", Zimmo " + zimmoCount + ", agences locales " + localAgencyCount + ", 2ememain " + secondHandCount + ".</div>",
      "<div class='source-diagnostic-list'>",
      "<div class='source-diagnostic-item'><strong>Agences locales</strong>" + localAgencyCount + " annonce(s) integree(s) depuis les sites directs.</div>",
      "<div class='source-diagnostic-item'><strong>Zimmo</strong>" + zimmoMessage + "</div>",
      "<div class='source-diagnostic-item'><strong>Immovlan</strong>Extraction avancee active: HTML public, donnees structurees JSON-LD et endpoint telephone public. " + immovlanCount + " annonce(s) integree(s).</div>",
      "<div class='source-diagnostic-item'><strong>2ememain</strong>Extraction avancee active via pages publiques et window.__CONFIG__. " + secondHandCount + " annonce(s) integree(s) apres filtres stricts localisation/type/prix.</div>",
      "<div class='source-diagnostic-item'><strong>Facebook Marketplace</strong>Lien de controle ajoute. Extraction automatique non active sans session utilisateur.</div>",
      "</div>",
      renderZimmoImportPanel(config || {}),
      renderDiagnosticSummary(payload.sourceDiagnostics),
      renderPrivateSourceLinks(config),
      others.length ? "<section class='cards'>" + others.map(renderOtherSourceCard).join("") + "</section>" : "<div class='empty'>Aucune annonce non-Immoweb exploitable dans le dernier jeu de donnees publie.</div>"
    ].join("");
    anchor.parentNode.insertBefore(section, anchor);
  }

  function renderOtherSourceCard(listing) {
    const details = [];
    if (listing.locality) {
      details.push("<div><span class='fact-label'>Commune</span> " + escapeHtml(listing.locality) + "</div>");
    }
    if (listing.requestedLocation) {
      details.push("<div><span class='fact-label'>Recherche</span> " + escapeHtml(listing.requestedLocation) + "</div>");
    }
    if (Number(listing.bedrooms || 0) > 0) {
      details.push("<div><span class='fact-label'>Ch.</span> " + escapeHtml(listing.bedrooms) + "</div>");
    }
    if (Number(listing.surfaceM2 || 0) > 0) {
      details.push("<div><span class='fact-label'>Surface</span> " + escapeHtml(listing.surfaceM2) + " m2</div>");
    }
    const contactParts = [];
    if (listing.agentPhone) {
      contactParts.push("<a href='tel:" + escapeHtml(listing.agentPhone) + "'>" + escapeHtml(listing.agentPhone) + "</a>");
    }
    if (listing.agentEmail) {
      contactParts.push("<a href='mailto:" + escapeHtml(listing.agentEmail) + "'>" + escapeHtml(listing.agentEmail) + "</a>");
    }
    if (listing.agentWebsite) {
      contactParts.push("<button type='button' class='external-link-button' data-external-url='" + escapeHtml(listing.agentWebsite) + "'>Site agence</button>");
    }
    return [
      "<article class='listing-card' id='listing-other-" + escapeHtml(listing.id || listing.url || "") + "'>",
      renderPhotoStrip(listing),
      "<div class='listing-body'>",
      renderSourceBadge(listing.source),
      "<div class='listing-title'>" + escapeHtml(listing.title || "Annonce autre source") + "</div>",
      "<div class='facts'><div><span class='fact-label'>Prix</span> <span class='price'>" + escapeHtml(formatPrice(listing.price)) + "</span></div>" + details.join("") + "</div>",
      listing.address ? "<div class='small'>" + escapeHtml(listing.address) + "</div>" : "",
      "<div class='contact'><strong>" + escapeHtml(listing.agentName || listing.source || "Source") + "</strong>" + (contactParts.length ? "<br>" + contactParts.join(" · ") : "") + "</div>",
      "<div class='links'><button type='button' class='external-link-button' data-external-url='" + escapeHtml(listing.url || "#") + "'>Ouvrir l'annonce</button>" + (listing.localImport ? " <button type='button' class='zimmo-local-remove' data-zimmo-id='" + escapeHtml(listing.id) + "'>Retirer</button>" : "") + "</div>",
      "</div>",
      "</article>"
    ].join("");
  }

  async function notifyNewListings(newListings) {
    if (!("Notification" in window) || Notification.permission !== "granted" || newListings.length === 0) {
      return;
    }
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
    const title = newListings.length === 1 ? "1 nouvelle maison" : newListings.length + " nouvelles maisons";
    const body = listingText(newListings[0]);
    if (registration && registration.showNotification) {
      registration.showNotification(title, {
        body: body,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        tag: "veille-immo-new-listings",
        data: { url: "./" }
      });
      return;
    }
    new Notification(title, { body: body, icon: "icons/icon.svg" });
  }

  async function checkForNewListings(manual) {
    try {
      const payload = await fetchResults();
      const listings = Array.isArray(payload.listings) ? payload.listings : [];
      const initialized = localStorage.getItem(INIT_KEY) === "1";
      const seenIds = seenIdsFromStorage();
      const nextSeenIds = new Set(seenIds);
      const newListings = [];

      listings.forEach(function (listing) {
        const id = String(listing.id || "");
        if (!id) {
          return;
        }
        if (initialized && !seenIds.has(id)) {
          newListings.push(listing);
        }
        nextSeenIds.add(id);
      });

      saveSeenIds(nextSeenIds);
      await notifyNewListings(newListings);

      if (manual && newListings.length === 0) {
        alert("Aucune nouvelle annonce detectee.");
      }
    } catch (error) {
      if (manual) {
        alert("Verification impossible pour le moment.");
      }
    }
  }

  async function requestNotifications() {
    if (!("Notification" in window)) {
      alert("Notifications non disponibles dans ce navigateur.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      await checkForNewListings(true);
    }
  }

  async function promptInstall() {
    if (!deferredInstallPrompt) {
      alert("Dans Chrome Android : menu puis Ajouter a l'ecran d'accueil.");
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updateInstallButtons();
  }

  function updateInstallButtons() {
    const hidden = isStandalone() || !deferredInstallPrompt;
    const floatingButton = document.getElementById("pwaInstallFloatingButton");
    const pageButton = document.getElementById("installButton");
    if (floatingButton) {
      floatingButton.hidden = hidden;
    }
    if (pageButton) {
      pageButton.hidden = hidden;
    }
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallButtons();
  });

  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    updateInstallButtons();
  });

  document.addEventListener("click", function (event) {
    const button = event.target.closest(".zimmo-local-remove");
    if (!button) return;
    event.preventDefault();
    removeZimmoImport(button.dataset.zimmoId || "");
  });

  let refreshing = false;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshing) {
        return;
      }
      refreshing = true;
      window.location.reload();
    });
  }

  window.addEventListener("load", async function () {
    injectControls();
    const pageButton = document.getElementById("installButton");
    if (pageButton) {
      pageButton.addEventListener("click", promptInstall);
    }
    try {
      await registerServiceWorker();
    } catch (error) {
    }
    updateInstallButtons();
    fetchResults().then(function (payload) {
      latestPayload = payload;
      const initialPayload = mergeLocalImports(payload);
      annotateSourceBadges(initialPayload);
      syncSourceMapMarkers(initialPayload);
      return fetchConfig()
        .then(function (config) {
          latestConfig = config;
          const merged = mergeLocalImports(payload);
          renderOtherSources(merged, config);
          bindZimmoAssistantEvents();
          annotateSourceBadges(merged);
          syncSourceMapMarkers(merged);
          syncImportedZimmoMapMarkers(readLocalImports());
        })
        .catch(function () {
          latestConfig = null;
          const merged = mergeLocalImports(payload);
          renderOtherSources(merged, null);
          bindZimmoAssistantEvents();
          annotateSourceBadges(merged);
          syncSourceMapMarkers(merged);
          syncImportedZimmoMapMarkers(readLocalImports());
        });
    }).catch(function () {});
    checkForNewListings(false);
  });

  window.VeilleImmoPwa = {
    version: APP_VERSION,
    checkForNewListings: checkForNewListings,
    hardRefreshApplication: hardRefreshApplication
  };
})();
