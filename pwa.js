(function () {
  "use strict";

  const APP_VERSION = "pwa-2026-06-21-14";
  const RESULTS_URL = "results.json";
  const CONFIG_URL = "config/veille-immo.json";
  const LOCATION_BOUNDARIES_URL = "data/location-boundaries.geojson";
  const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
  const STORAGE_KEY = "veille-immo-seen-ids";
  const INIT_KEY = "veille-immo-initialized";
  const PRICE_FILTER_KEY = "veille-immo-price-max";
  const PRICE_FILTER_CONFIG_KEY = "veille-immo-price-config-max";
  const SHOW_OPTION_KEY = "veille-immo-show-option";
  const LOCATION_FILTER_KEY = "veille-immo-selected-locations";
  const DEFAULT_MAX_PRICE = 350000;
  const USER_PRICE_LIMIT_MAX = 350000;
  let deferredInstallPrompt = null;
  let latestPayload = null;
  let latestConfig = null;
  let currentPriceMax = null;
  let currentPriceConfigMax = null;
  let showOptionListings = false;
  let selectedLocationKeys = null;
  let latestLocationBoundaries = null;
  let locationBoundaryLayer = null;
  let locationBoundariesByKey = {};
  let routePreviewLayer = null;
  let routePreviewEntries = {};
  let renderedMapMarkers = [];
  const ROUTE_REFERENCES = [
    { key: "bourse", label: "Bourse de Bruxelles", lat: 50.8478282, lon: 4.3491201 },
    { key: "decoster", label: "110 rue Pierre Decoster, Forest", lat: 50.8230517, lon: 4.3297564 }
  ];

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
      ".price-filter-panel{background:#fff;border:1px solid #d8dee3;border-radius:7px;margin:16px 0 22px;padding:14px;display:grid;grid-template-columns:minmax(190px,1fr) minmax(220px,2fr) auto;gap:12px;align-items:center}",
      ".price-filter-title{font-weight:700;color:#182026}",
      ".price-filter-count{font-size:13px;color:#5c6670;margin-top:4px}",
      ".price-filter-range{width:100%;accent-color:#0b5c86}",
      ".price-filter-inputs{display:flex;align-items:center;gap:8px;justify-content:flex-end}",
      ".price-filter-inputs input{width:122px;border:1px solid #c8d1d8;border-radius:6px;padding:8px 9px;font:600 14px Arial,sans-serif;color:#182026}",
      ".price-filter-inputs button{border:1px solid #c8d1d8;background:#fff;border-radius:6px;padding:8px 10px;font:600 13px Arial,sans-serif;color:#17202a}",
      ".price-filter-inputs button:disabled{opacity:.65;cursor:wait}",
      ".filter-toggle{display:inline-flex;align-items:center;gap:8px;font:600 13px Arial,sans-serif;color:#253540;white-space:nowrap}",
      ".filter-source-counts{grid-column:1/-1;font-size:13px;color:#41515d;border-top:1px solid #e5eaee;padding-top:10px}",
      ".filter-refresh-status{grid-column:1/-1;font-size:13px;color:#0b5c86;font-weight:700;min-height:18px}",
      ".location-filter-panel{background:#fff;border:1px solid #d8dee3;border-radius:7px;margin:-8px 0 24px;padding:12px 14px}",
      ".location-filter-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}",
      ".location-filter-title{font-weight:700;color:#182026}",
      ".location-filter-count{font-size:13px;color:#5c6670;margin-left:8px}",
      ".location-filter-actions{display:flex;gap:8px;flex-wrap:wrap}",
      ".location-filter-actions button,.location-chip{border:1px solid #c8d1d8;background:#fff;border-radius:999px;padding:7px 10px;font:600 13px Arial,sans-serif;color:#17202a;cursor:pointer}",
      ".location-chip-list{display:flex;flex-wrap:wrap;gap:8px}",
      ".location-chip.is-active{background:#0b5c86;border-color:#0b5c86;color:#fff}",
      ".location-chip:focus-visible,.location-filter-actions button:focus-visible{outline:3px solid rgba(11,92,134,.28);outline-offset:2px}",
      ".location-boundary-path{cursor:pointer;transition:fill-opacity .12s ease,stroke-opacity .12s ease;outline:none}",
      ".location-boundary-path:focus,.leaflet-interactive:focus,.leaflet-container path:focus{outline:none}",
      ".listing-card.is-under-option{border-color:#d97706;box-shadow:inset 0 0 0 1px rgba(217,119,6,.28)}",
      ".option-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;background:#d97706;color:#fff;font:700 11px/1 Arial,sans-serif;text-transform:uppercase;letter-spacing:.02em}",
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
      ".map-popup{min-width:245px;max-width:320px}",
      ".map-popup-source{display:inline-flex;border-radius:999px;padding:3px 7px;background:#eef3f6;color:#253540;font:700 11px Arial,sans-serif;text-transform:uppercase;margin-bottom:6px}",
      ".map-popup-title{font:700 14px/1.3 Arial,sans-serif;color:#17202a;margin-bottom:5px}",
      ".map-popup-price{font:700 14px Arial,sans-serif;color:#0b513c;margin-bottom:6px}",
      ".map-popup-details,.map-popup-address,.map-popup-contact{font:12px/1.35 Arial,sans-serif;color:#3d4852;margin-top:5px}",
      ".map-popup-routes{border-top:1px solid #e3e8ec;margin-top:9px;padding-top:8px;font:12px/1.35 Arial,sans-serif;color:#33424d}",
      ".map-popup-route-title{font-weight:700;color:#17202a;margin-bottom:5px}",
      ".map-popup-route-row{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;margin-top:5px}",
      ".map-popup-route-row label{display:flex;align-items:center;gap:5px}",
      ".map-popup-route-row input{margin:0}",
      ".map-popup-route-note{font-size:11px;color:#66737d;margin-top:5px}",
      ".map-popup-route-legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;font-size:11px;color:#4b5563}",
      ".transit-swatch{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:3px;vertical-align:-1px}",
      ".route-preview-hide-popups .leaflet-popup,.route-preview-hide-popups .leaflet-popup-pane{opacity:0;pointer-events:none}",
      ".map-popup-actions{margin-top:8px}",
      ".map-popup-actions button{border:0;background:#fff;color:#0b5c86;font:600 12px Arial,sans-serif;padding:0}",
      ".listing-contact-details{margin-top:10px;background:#f4f7f8;border-radius:6px;padding:8px 10px;color:#33424d}",
      ".listing-contact-details summary{cursor:pointer;font-weight:700;color:#0b5c86}",
      "@media(max-width:760px){.price-filter-panel{grid-template-columns:1fr}.price-filter-inputs{justify-content:flex-start}.price-filter-inputs input{width:140px}.filter-source-counts{grid-column:auto}}",
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
    return normalizeResultsPayload(await response.json());
  }

  function listingDedupeKey(listing) {
    return listingUrlKey(listing && listing.url) || String(listing && listing.id || "").trim().toLowerCase();
  }

  function dedupeListings(listings) {
    const seen = new Set();
    return (Array.isArray(listings) ? listings : []).filter(function (listing) {
      const key = listingDedupeKey(listing);
      if (!key) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function normalizeResultsPayload(payload) {
    const raw = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const listings = dedupeListings(raw);
    return Object.assign({}, payload || {}, {
      listings: listings,
      count: listings.length,
      duplicateCount: Math.max(0, raw.length - listings.length)
    });
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

  async function fetchLocationBoundaries() {
    const response = await fetch(LOCATION_BOUNDARIES_URL + "?t=" + Date.now(), {
      cache: "no-store",
      headers: { "Accept": "application/geo+json, application/json" }
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.features)) {
      return { type: "FeatureCollection", features: [] };
    }
    return data;
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

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString("fr-BE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function clampPrice(value, min, max) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) {
      return max;
    }
    return Math.min(max, Math.max(min, Math.round(number / 1000) * 1000));
  }

  function configuredPriceMax(config) {
    return Number(config && config.maxPrice ? config.maxPrice : DEFAULT_MAX_PRICE);
  }

  function priceBounds(payload, config) {
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const prices = listings.map(function (listing) {
      return Number(listing.price || 0);
    }).filter(function (price) {
      return Number.isFinite(price) && price > 0;
    });
    const max = USER_PRICE_LIMIT_MAX;
    const min = Math.max(0, Math.floor((prices.length ? Math.min.apply(null, prices) : 0) / 5000) * 5000);
    return { min: min, max: max };
  }

  function storedPriceMax(bounds, config) {
    const configMax = configuredPriceMax(config);
    try {
      const storedRaw = localStorage.getItem(PRICE_FILTER_KEY);
      const storedConfigMax = Number(localStorage.getItem(PRICE_FILTER_CONFIG_KEY) || 0);
      if (!storedRaw || storedConfigMax !== configMax) {
        const migrated = clampPrice(configMax, bounds.min, bounds.max);
        saveStoredPriceMax(migrated, config);
        return migrated;
      }
      const stored = Number(storedRaw || 0);
      return clampPrice(stored || configMax, bounds.min, bounds.max);
    } catch (error) {
      return clampPrice(configMax, bounds.min, bounds.max);
    }
  }

  function saveStoredPriceMax(value, config) {
    try {
      localStorage.setItem(PRICE_FILTER_KEY, String(value));
      localStorage.setItem(PRICE_FILTER_CONFIG_KEY, String(configuredPriceMax(config || latestConfig)));
    } catch (error) {
    }
  }

  function storedShowOption() {
    try {
      return localStorage.getItem(SHOW_OPTION_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function listingUrlKey(url) {
    const raw = String(url || "").trim();
    if (!raw) {
      return "";
    }
    try {
      const parsed = new URL(raw, window.location.href);
      return (parsed.origin + parsed.pathname).toLowerCase();
    } catch (error) {
      return raw.split(/[?#]/)[0].toLowerCase();
    }
  }

  function listingCardKeys(listing) {
    const keys = [];
    if (listing.id) {
      keys.push("listing-" + listing.id);
      keys.push("listing-other-" + listing.id);
      keys.push(String(listing.id));
    }
    if (listing.url) {
      keys.push("listing-other-" + listing.url);
      keys.push(String(listing.url));
    }
    return keys;
  }

  function listingIsWithinPrice(listing, maxPrice) {
    const price = Number(listing && listing.price || 0);
    return Number.isFinite(price) && price > 0 && price <= maxPrice;
  }

  function listingOptionText(listing) {
    return [
      listing && listing.availability,
      listing && listing.optionStatus,
      listing && listing.status,
      listing && listing.saleStatus,
      listing && listing.transactionStatus,
      listing && listing.title
    ].filter(Boolean).join(" ");
  }

  function listingIsUnderOption(listing) {
    if (!listing) {
      return false;
    }
    if (listing.isUnderOption === true || listing.underOption === true || listing.option === true) {
      return true;
    }
    const text = listingOptionText(listing);
    return /\b(sous[-\s]?option|optionn(?:e|é|ee|ée)|onder\s+optie|under\s+option|sale\s+agreed|reserved|r(?:e|é)serv(?:e|é|ee|ée)|compromis)\b/i.test(text);
  }

  function listingPassesOptionFilter(listing) {
    return showOptionListings || !listingIsUnderOption(listing);
  }

  function locationKey(value) {
    return slugForPath(value);
  }

  function listingLocationCandidates(listing) {
    return [
      listing && listing.requestedLocation,
      listing && listing.locality,
      listing && listing.postalCode,
      listing && listing.address,
      listing && listing.title
    ].filter(Boolean).map(locationKey).filter(Boolean);
  }

  function locationAliases(location) {
    const aliases = [
      location && location.name,
      location && location.postalCode,
      location && location.immowebSlug,
      location && location.zimmoSlug,
      location && location.immovlanSlug
    ];
    if (Array.isArray(location && location.aliases)) {
      location.aliases.forEach(function (alias) {
        aliases.push(alias);
      });
    }
    return aliases.filter(Boolean).map(locationKey).filter(Boolean);
  }

  function configLocations(config) {
    return Array.isArray(config && config.locations) ? config.locations : [];
  }

  function defaultLocationKeys(config) {
    return configLocations(config).map(function (location) {
      return locationKey(location.name || location.postalCode || "");
    }).filter(Boolean);
  }

  function selectedLocationsFromStorage(config) {
    const validKeys = new Set(defaultLocationKeys(config));
    try {
      const stored = JSON.parse(localStorage.getItem(LOCATION_FILTER_KEY) || "null");
      if (Array.isArray(stored)) {
        return new Set(stored.filter(function (key) { return validKeys.has(key); }));
      }
    } catch (error) {
    }
    return new Set(validKeys);
  }

  function saveSelectedLocations() {
    try {
      localStorage.setItem(LOCATION_FILTER_KEY, JSON.stringify(Array.from(selectedLocationKeys || [])));
    } catch (error) {
    }
  }

  function boundaryFeatureByKey(key) {
    const features = latestLocationBoundaries && Array.isArray(latestLocationBoundaries.features)
      ? latestLocationBoundaries.features
      : [];
    for (let index = 0; index < features.length; index += 1) {
      if (locationBoundaryKey(features[index]) === key) {
        return features[index];
      }
    }
    return null;
  }

  function pointInRing(lon, lat, ring) {
    let inside = false;
    if (!Array.isArray(ring) || ring.length < 4) {
      return false;
    }
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = Number(ring[i][0]);
      const yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]);
      const yj = Number(ring[j][1]);
      const intersects = ((yi > lat) !== (yj > lat))
        && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInPolygonCoordinates(lon, lat, polygon) {
    if (!Array.isArray(polygon) || !polygon.length || !pointInRing(lon, lat, polygon[0])) {
      return false;
    }
    for (let index = 1; index < polygon.length; index += 1) {
      if (pointInRing(lon, lat, polygon[index])) {
        return false;
      }
    }
    return true;
  }

  function pointInFeature(lon, lat, feature) {
    const geometry = feature && feature.geometry;
    if (!geometry) {
      return false;
    }
    if (geometry.type === "Polygon") {
      return pointInPolygonCoordinates(lon, lat, geometry.coordinates);
    }
    if (geometry.type === "MultiPolygon") {
      return geometry.coordinates.some(function (polygon) {
        return pointInPolygonCoordinates(lon, lat, polygon);
      });
    }
    return false;
  }

  function listingPassesSelectedBoundary(listing) {
    const lat = Number(listing && listing.latitude);
    const lon = Number(listing && listing.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    let checkedAnyBoundary = false;
    const keys = Array.from(selectedLocationKeys || []);
    return keys.some(function (key) {
      const feature = boundaryFeatureByKey(key);
      if (!feature) {
        return false;
      }
      checkedAnyBoundary = true;
      return pointInFeature(lon, lat, feature);
    }) || (checkedAnyBoundary ? false : null);
  }

  function listingPassesLocationFilter(listing) {
    const locations = configLocations(latestConfig);
    if (!locations.length || !selectedLocationKeys) {
      return true;
    }
    if (selectedLocationKeys.size === 0) {
      return false;
    }
    const boundaryMatch = listingPassesSelectedBoundary(listing);
    if (boundaryMatch !== null) {
      return boundaryMatch;
    }
    const candidates = listingLocationCandidates(listing);
    return locations.some(function (location) {
      const key = locationKey(location.name || location.postalCode || "");
      if (!key || !selectedLocationKeys.has(key)) {
        return false;
      }
      return locationAliases(location).some(function (alias) {
        return candidates.some(function (candidate) {
          return candidate === alias || candidate.indexOf(alias) !== -1;
        });
      });
    });
  }

  function listingPassesFilters(listing, maxPrice) {
    return listingIsWithinPrice(listing, maxPrice)
      && listingPassesOptionFilter(listing)
      && listingPassesLocationFilter(listing);
  }

  function listingByUrl(payload) {
    return (Array.isArray(payload && payload.listings) ? payload.listings : []).reduce(function (acc, listing) {
      const key = listingUrlKey(listing.url);
      if (key) {
        acc[key] = listing;
      }
      return acc;
    }, {});
  }

  function listingByCardKey(payload) {
    return (Array.isArray(payload && payload.listings) ? payload.listings : []).reduce(function (acc, listing) {
      listingCardKeys(listing).forEach(function (key) {
        if (key) {
          acc[key] = listing;
        }
      });
      return acc;
    }, {});
  }

  function markerListing(marker, byUrl) {
    const key = listingUrlKey(marker && marker.url);
    return key && byUrl[key] ? byUrl[key] : marker;
  }

  function injectPriceFilter(payload, config) {
    latestPayload = payload;
    latestConfig = config || latestConfig;
    const bounds = priceBounds(payload, latestConfig);
    const configMax = configuredPriceMax(latestConfig);
    if (currentPriceMax == null || currentPriceConfigMax !== configMax) {
      currentPriceMax = storedPriceMax(bounds, latestConfig);
      currentPriceConfigMax = configMax;
    } else {
      currentPriceMax = clampPrice(currentPriceMax, bounds.min, bounds.max);
    }
    showOptionListings = storedShowOption();

    let panel = document.getElementById("priceFilterPanel");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "priceFilterPanel";
      panel.className = "price-filter-panel";
      panel.innerHTML = [
        "<div><div class='price-filter-title'>Prix max</div><div id='priceFilterCount' class='price-filter-count' aria-live='polite'></div></div>",
        "<input id='priceFilterRange' class='price-filter-range' type='range' step='5000' aria-label='Prix maximum'>",
        "<div class='price-filter-inputs'><input id='priceFilterInput' type='number' inputmode='numeric' step='1000' aria-label='Prix maximum' placeholder='Prix max'><button id='priceFilterReset' type='button'>Réinit.</button><button id='reportRebuildButton' type='button'>Recalculer</button></div>",
        "<label class='filter-toggle'><input id='optionFilterToggle' type='checkbox'> Inclure sous option</label>",
        "<div id='sourceFilterCount' class='filter-source-counts' aria-live='polite'></div>",
        "<div id='reportRebuildStatus' class='filter-refresh-status' aria-live='polite'></div>"
      ].join("");
      const note = document.querySelector(".note");
      const main = document.querySelector("main");
      if (note && note.parentNode) {
        note.parentNode.insertBefore(panel, note.nextSibling);
      } else if (main) {
        main.insertBefore(panel, main.firstChild);
      } else {
        document.body.insertBefore(panel, document.body.firstChild);
      }
    }

    const range = document.getElementById("priceFilterRange");
    const input = document.getElementById("priceFilterInput");
    const reset = document.getElementById("priceFilterReset");
    const rebuild = document.getElementById("reportRebuildButton");
    const optionToggle = document.getElementById("optionFilterToggle");
    if (!range || !input || !reset || !rebuild || !optionToggle) {
      return;
    }

    range.min = String(bounds.min);
    range.max = String(bounds.max);
    range.value = String(currentPriceMax);
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    input.value = String(currentPriceMax);
    optionToggle.checked = showOptionListings;

    function setPrice(value) {
      currentPriceMax = clampPrice(value, bounds.min, bounds.max);
      currentPriceConfigMax = configuredPriceMax(latestConfig);
      range.value = String(currentPriceMax);
      input.value = String(currentPriceMax);
      saveStoredPriceMax(currentPriceMax, latestConfig);
      applyPriceFilter();
    }

    if (!range.dataset.priceFilterBound) {
      range.dataset.priceFilterBound = "1";
      range.addEventListener("input", function () {
        setPrice(range.value);
      });
    }
    if (!input.dataset.priceFilterBound) {
      input.dataset.priceFilterBound = "1";
      input.addEventListener("change", function () {
        setPrice(input.value);
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          setPrice(input.value);
          input.blur();
        }
      });
    }
    if (!reset.dataset.priceFilterBound) {
      reset.dataset.priceFilterBound = "1";
      reset.addEventListener("click", function () {
        setPrice(configuredPriceMax(latestConfig));
      });
    }
    if (!rebuild.dataset.priceFilterBound) {
      rebuild.dataset.priceFilterBound = "1";
      rebuild.addEventListener("click", function () {
        refreshReportData(true);
      });
    }
    if (!optionToggle.dataset.priceFilterBound) {
      optionToggle.dataset.priceFilterBound = "1";
      optionToggle.addEventListener("change", function () {
        showOptionListings = optionToggle.checked;
        try {
          localStorage.setItem(SHOW_OPTION_KEY, showOptionListings ? "1" : "0");
        } catch (error) {
        }
        applyPriceFilter();
      });
    }
  }

  function applyPriceFilter() {
    const payload = latestPayload || {};
    const listings = Array.isArray(payload.listings) ? payload.listings : [];
    const bounds = priceBounds(payload, latestConfig);
    const maxPrice = clampPrice(currentPriceMax || configuredPriceMax(latestConfig), bounds.min, bounds.max);
    const byCardKey = listingByCardKey(payload);
    const byUrl = listingByUrl(payload);
    const visibleKeys = new Set();
    const visibleSources = emptySourceCounts();
    let optionHiddenCount = 0;
    let visibleCount = 0;

    listings.forEach(function (listing) {
      if (!listingPassesFilters(listing, maxPrice)) {
        if (!showOptionListings && listingIsUnderOption(listing) && listingIsWithinPrice(listing, maxPrice) && listingPassesLocationFilter(listing)) {
          optionHiddenCount += 1;
        }
        return;
      }
      visibleCount += 1;
      incrementSourceCount(visibleSources, listing.source);
      listingCardKeys(listing).forEach(function (key) {
        visibleKeys.add(key);
      });
    });

    document.querySelectorAll(".listing-card").forEach(function (card) {
      const id = String(card.id || "");
      const bare = id.replace(/^listing-other-/, "").replace(/^listing-/, "");
      const listing = byCardKey[id] || byCardKey[bare] || byCardKey["listing-" + bare] || byCardKey["listing-other-" + bare] || null;
      const visible = visibleKeys.has(id) || visibleKeys.has(bare);
      card.hidden = !visible;
      if (listing) {
        card.classList.toggle("is-under-option", listingIsUnderOption(listing));
      }
    });

    if (renderedMapMarkers.length) {
      renderedMapMarkers.forEach(function (entry) {
        const visible = listingPassesFilters(entry.listing, maxPrice);
        if (entry.marker && typeof entry.marker.getElement === "function") {
          const icon = entry.marker.getElement();
          if (icon) {
            icon.style.display = visible ? "" : "none";
            icon.setAttribute("aria-hidden", visible ? "false" : "true");
          }
        }
      });
    } else {
      const markerSource = Array.isArray(window.listingMarkers) ? window.listingMarkers : [];
      const markerIcons = document.querySelectorAll(".leaflet-marker-icon.source-map-marker");
      markerIcons.forEach(function (icon, index) {
        const listing = markerListing(markerSource[index], byUrl);
        const visible = listingPassesFilters(listing, maxPrice);
        icon.style.display = visible ? "" : "none";
        icon.setAttribute("aria-hidden", visible ? "false" : "true");
      });
    }

    const count = document.getElementById("priceFilterCount");
    if (count) {
      count.textContent = visibleCount + " / " + listings.length + " annonces sous " + formatPrice(maxPrice);
    }
    const sourceCount = document.getElementById("sourceFilterCount");
    if (sourceCount) {
      sourceCount.textContent = "Visibles: " + sourceCountSummary(visibleSources) + (optionHiddenCount ? " · sous option masquees: " + optionHiddenCount : "");
    }
    updateLocationFilterUi();
    updatePrivateSourceLinks();
    window.veilleImmoPriceFilterState = {
      maxPrice: maxPrice,
      showOptionListings: showOptionListings,
      selectedLocations: Array.from(selectedLocationKeys || []),
      visibleCount: visibleCount,
      totalCount: listings.length,
      sourceCounts: visibleSources,
      optionHiddenCount: optionHiddenCount
    };
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

  function emptySourceCounts() {
    return { immoweb: 0, immovlan: 0, zimmo: 0, agency: 0, p2p: 0 };
  }

  function incrementSourceCount(counts, source) {
    const kind = sourceKind(source);
    counts[kind] = (counts[kind] || 0) + 1;
  }

  function sourceCountSummary(counts) {
    return [
      "Immoweb " + (counts.immoweb || 0),
      "Immovlan " + (counts.immovlan || 0),
      "Zimmo " + (counts.zimmo || 0),
      "Agences " + (counts.agency || 0),
      "Particulier " + (counts.p2p || 0)
    ].join(" · ");
  }

  function renderOptionBadge(listing) {
    return listingIsUnderOption(listing) ? "<span class='option-badge'>Sous option</span>" : "";
  }

  function renderSourceBadge(source, listing) {
    const kind = sourceKind(source);
    return "<div class='source-badge-row'><span class='source-badge source-badge-" + kind + "'>" + escapeHtml(sourceLabel(source)) + "</span>" + renderOptionBadge(listing) + "</div>";
  }

  function sourceMarkerIcon(source) {
    if (!window.L) {
      return null;
    }
    const kind = sourceKind(source);
    return window.L.divIcon({
      className: "source-map-icon-wrap source-map-marker",
      html: "<span class='source-map-pin source-map-pin-" + kind + "'></span>",
      iconSize: [24, 24],
      iconAnchor: [12, 24],
      popupAnchor: [0, -22]
    });
  }

  function listingDetailsHtml(listing) {
    const details = [];
    if (listing && listing.locality) {
      details.push("<span><strong>Commune</strong> " + escapeHtml(listing.locality) + "</span>");
    }
    if (listing && listing.requestedLocation) {
      details.push("<span><strong>Recherche</strong> " + escapeHtml(listing.requestedLocation) + "</span>");
    }
    const bedrooms = Number(listing && listing.bedrooms || 0);
    const surface = Number(listing && listing.surfaceM2 || 0);
    details.push("<span><strong>Ch.</strong> " + (bedrooms > 0 ? escapeHtml(listing.bedrooms) : "non publie") + "</span>");
    details.push("<span><strong>Surface</strong> " + (surface > 0 ? escapeHtml(listing.surfaceM2) + " m2" : "non publiee") + "</span>");
    return details.length ? "<div class='map-popup-details'>" + details.join(" · ") + "</div>" : "";
  }

  function listingContactHtml(listing) {
    const pieces = [];
    const name = listing && (listing.agentName || listing.contact || listing.agent);
    const phone = listing && (listing.agentPhone || listing.phone);
    const email = listing && listing.agentEmail;
    if (name) {
      pieces.push(escapeHtml(name));
    }
    if (phone) {
      pieces.push("<a href='tel:" + escapeHtml(phone) + "'>" + escapeHtml(phone) + "</a>");
    }
    if (email) {
      pieces.push("<a href='mailto:" + escapeHtml(email) + "'>" + escapeHtml(email) + "</a>");
    }
    return "<div class='map-popup-contact'><strong>Contact</strong> " + (pieces.length ? pieces.join(" · ") : "non publie") + "</div>";
  }

  function haversineKm(aLat, aLon, bLat, bLon) {
    const earthKm = 6371;
    const toRad = Math.PI / 180;
    const dLat = (bLat - aLat) * toRad;
    const dLon = (bLon - aLon) * toRad;
    const lat1 = aLat * toRad;
    const lat2 = bLat * toRad;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function routeDurationText(minutes) {
    const value = Math.max(1, Math.round(minutes));
    if (value < 60) {
      return value + " min";
    }
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? hours + " h " + rest + " min" : hours + " h";
  }

  function osmBikeRouteUrl(origin, dest) {
    return "https://www.openstreetmap.org/directions?engine=fossgis_osrm_bike&route="
      + encodeURIComponent(origin.lat + "," + origin.lon + ";" + dest.lat + "," + dest.lon);
  }

  function transitRouteUrl(origin, dest) {
    return "https://www.openstreetmap.org/directions?route="
      + encodeURIComponent(origin.lat + "," + origin.lon + ";" + dest.lat + "," + dest.lon);
  }

  function transitOperatorKind(tags) {
    const text = [
      tags && tags.operator,
      tags && tags.network,
      tags && tags.route,
      tags && tags.name,
      tags && tags.ref
    ].join(" ").toLowerCase();
    if (/sncb|nmbs|train|rail/.test(text)) {
      return "train";
    }
    if (/stib|mivb|subway|metro|tram/.test(text)) {
      return "stib";
    }
    if (/de\s*lijn|delijn/.test(text)) {
      return "delijn";
    }
    if (/\btec\b|otw/.test(text)) {
      return "tec";
    }
    return "other";
  }

  function transitOperatorLabel(kind) {
    return {
      train: "Train SNCB",
      stib: "STIB",
      delijn: "De Lijn",
      tec: "TEC",
      other: "Autre TC"
    }[kind] || "Autre TC";
  }

  function transitOperatorColor(kind) {
    return {
      train: "#111827",
      stib: "#2563eb",
      delijn: "#f59e0b",
      tec: "#dc2626",
      other: "#6b7280"
    }[kind] || "#6b7280";
  }

  function transitLegendHtml() {
    return [
      "<div class='map-popup-route-legend'>",
      "<span><i class='transit-swatch' style='background:#111827'></i>Train</span>",
      "<span><i class='transit-swatch' style='background:#2563eb'></i>STIB</span>",
      "<span><i class='transit-swatch' style='background:#f59e0b'></i>De Lijn</span>",
      "<span><i class='transit-swatch' style='background:#dc2626'></i>TEC</span>",
      "</div>"
    ].join("");
  }

  function routePopupHtml(listing) {
    const lat = Number(listing && listing.latitude);
    const lon = Number(listing && listing.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return "";
    }
    const dest = { lat: lat, lon: lon };
    const rows = [];
    ROUTE_REFERENCES.forEach(function (origin) {
      const directKm = haversineKm(origin.lat, origin.lon, dest.lat, dest.lon);
      const bikeKm = directKm * 1.25;
      const bikeMinutes = (bikeKm / 25) * 60;
      const transitMinutes = 10 + (directKm / 18) * 60;
      const commonData = " data-origin-lat='" + escapeHtml(origin.lat) + "' data-origin-lon='" + escapeHtml(origin.lon) + "' data-dest-lat='" + escapeHtml(dest.lat) + "' data-dest-lon='" + escapeHtml(dest.lon) + "'";
      rows.push(
        "<div class='map-popup-route-row'>"
        + "<label><input type='checkbox' class='route-preview-toggle' data-route-mode='bike' data-route-id='bike-" + escapeHtml(origin.key) + "'" + commonData + "> Vélo " + escapeHtml(origin.label) + " · ~" + escapeHtml(routeDurationText(bikeMinutes)) + "</label>"
        + "<button type='button' class='external-link-button' data-external-url='" + escapeHtml(osmBikeRouteUrl(origin, dest)) + "'>OSM</button>"
        + "</div>"
      );
      rows.push(
        "<div class='map-popup-route-row'>"
        + "<label><input type='checkbox' class='route-preview-toggle' data-route-mode='transit' data-route-id='transit-" + escapeHtml(origin.key) + "'" + commonData + "> TC OSM " + escapeHtml(origin.label) + " · ~" + escapeHtml(routeDurationText(transitMinutes)) + "</label>"
        + "<button type='button' class='external-link-button' data-external-url='" + escapeHtml(transitRouteUrl(origin, dest)) + "'>Carte</button>"
        + "</div>"
      );
    });
    return [
      "<div class='map-popup-routes'>",
      "<div class='map-popup-route-title'>Trajets indicatifs</div>",
      rows.join(""),
      transitLegendHtml(),
      "<div class='map-popup-route-note'>Velo: estimation locale a 25 km/h. TC: lignes OSM sans horaires, estimation moyenne indicative.</div>",
      "</div>"
    ].join("");
  }

  function mapPopupHtml(listing) {
    const title = listing && listing.title ? listing.title : "Annonce";
    const source = listing && listing.source ? listing.source : "Source inconnue";
    const url = listing && listing.url ? listing.url : "#";
    return [
      "<div class='map-popup'>",
      "<div class='map-popup-source'>" + escapeHtml(sourceLabel(source)) + "</div>",
      "<div class='map-popup-title'>" + escapeHtml(title) + "</div>",
      "<div class='map-popup-price'>" + escapeHtml(formatPrice(listing && listing.price)) + "</div>",
      listingDetailsHtml(listing),
      listing && listing.address ? "<div class='map-popup-address'>" + escapeHtml(listing.address) + "</div>" : "",
      listingContactHtml(listing),
      routePopupHtml(listing),
      "<div class='map-popup-actions'><button type='button' class='external-link-button' data-external-url='" + escapeHtml(url) + "'>Ouvrir l'annonce</button></div>",
      "</div>"
    ].join("");
  }

  function refreshStaticMapPopups(payload) {
    renderedMapMarkers = [];
    if (!window.veilleImmoListingLayer || typeof window.veilleImmoListingLayer.eachLayer !== "function") {
      return;
    }
    const markerSource = Array.isArray(window.listingMarkers) ? window.listingMarkers : [];
    const byUrl = listingByUrl(payload);
    let index = 0;
    window.veilleImmoListingLayer.eachLayer(function (layer) {
      const listing = markerListing(markerSource[index], byUrl);
      if (layer && typeof layer.bindPopup === "function") {
        layer.bindPopup(mapPopupHtml(listing));
        renderedMapMarkers.push({ marker: layer, listing: listing });
      }
      index += 1;
    });
    window.veilleImmoRenderedMarkerLayers = renderedMapMarkers.map(function (entry) { return entry.marker; });
    window.veilleImmoRenderedMarkerListings = renderedMapMarkers.map(function (entry) { return entry.listing; });
  }

  function geocodedListings(payload) {
    return (Array.isArray(payload && payload.listings) ? payload.listings : []).filter(function (listing) {
      const lat = Number(listing.latitude);
      const lon = Number(listing.longitude);
      return Number.isFinite(lat) && Number.isFinite(lon);
    });
  }

  function syncMissingMapMarkers(payload) {
    if (!window.L || !window.veilleImmoMap) {
      return;
    }
    if (window.veilleImmoExtraSourceMarkers) {
      window.veilleImmoMap.removeLayer(window.veilleImmoExtraSourceMarkers);
    }
    const markerSource = Array.isArray(window.listingMarkers) ? window.listingMarkers : [];
    const existing = new Set(markerSource.map(function (marker) {
      return listingUrlKey(marker && marker.url);
    }).filter(Boolean));
    const missing = geocodedListings(payload).filter(function (listing) {
      const key = listingUrlKey(listing.url);
      return key && !existing.has(key);
    });
    if (!missing.length) {
      window.veilleImmoExtraSourceMarkers = null;
      return;
    }
    const layer = window.L.layerGroup().addTo(window.veilleImmoMap);
    missing.forEach(function (listing) {
      const icon = sourceMarkerIcon(listing.source);
      const marker = window.L.marker([Number(listing.latitude), Number(listing.longitude)], icon ? { icon: icon } : {}).addTo(layer);
      marker.bindPopup(mapPopupHtml(listing));
      renderedMapMarkers.push({ marker: marker, listing: listing });
    });
    window.veilleImmoExtraSourceMarkers = layer;
    window.veilleImmoRenderedMarkerLayers = renderedMapMarkers.map(function (entry) { return entry.marker; });
    window.veilleImmoRenderedMarkerListings = renderedMapMarkers.map(function (entry) { return entry.listing; });
  }

  function updateReportHeader(payload, config) {
    const meta = document.querySelector(".meta");
    if (!meta) {
      return;
    }
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const dateText = formatDate(payload && payload.generatedAt);
    const counts = sourceCountSummary(listings.reduce(function (acc, listing) {
      incrementSourceCount(acc, listing.source);
      return acc;
    }, emptySourceCounts()));
    meta.textContent = "Maisons a vendre jusqu'a " + formatPrice(configuredPriceMax(config || latestConfig)) + (dateText ? " - donnees du " + dateText : "") + " - " + listings.length + " annonce(s), " + counts + ".";
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
        card.classList.toggle("is-under-option", listingIsUnderOption(listing));
        body.insertAdjacentHTML("afterbegin", renderSourceBadge(listing.source, listing));
      }
    });
  }

  function syncSourceMapMarkers(payload) {
    if (typeof window.veilleImmoRenderMapFromPayload === "function") {
      window.veilleImmoRenderMapFromPayload(payload);
      return;
    }
    if (!window.L || !window.veilleImmoMap) {
      return;
    }
    if (window.veilleImmoExtraSourceMarkers) {
      window.veilleImmoMap.removeLayer(window.veilleImmoExtraSourceMarkers);
    }
    if (window.veilleImmoListingLayer && typeof window.veilleImmoMap.removeLayer === "function") {
      window.veilleImmoMap.removeLayer(window.veilleImmoListingLayer);
    }
    renderedMapMarkers = [];
    const layer = window.L.layerGroup().addTo(window.veilleImmoMap);
    const listings = geocodedListings(payload);
    listings.forEach(function (listing) {
      const lat = Number(listing.latitude);
      const lon = Number(listing.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return;
      }
      const icon = sourceMarkerIcon(listing.source);
      const marker = window.L.marker([lat, lon], icon ? { icon: icon } : {}).addTo(layer);
      marker.bindPopup(mapPopupHtml(listing));
      renderedMapMarkers.push({ marker: marker, listing: listing });
    });
    window.veilleImmoExtraSourceMarkers = layer;
    window.veilleImmoMapDataDriven = true;
    window.veilleImmoRenderedMarkerLayers = renderedMapMarkers.map(function (entry) { return entry.marker; });
    window.veilleImmoRenderedMarkerListings = renderedMapMarkers.map(function (entry) { return entry.listing; });
  }

  function locationBoundaryStyle(active, hovered) {
    return {
      pane: "locationBoundaryPane",
      color: hovered ? "#093f5d" : (active ? "#0b5c86" : "#6c7a83"),
      weight: hovered ? 3 : (active ? 2 : 1),
      opacity: hovered ? 0.95 : (active ? 0.72 : 0.28),
      fillColor: "#0b5c86",
      fillOpacity: hovered ? (active ? 0.3 : 0.12) : (active ? 0.22 : 0.03),
      className: "location-boundary-path"
    };
  }

  function ensureLocationBoundaryPane() {
    if (!window.L || !window.veilleImmoMap) {
      return;
    }
    if (!window.veilleImmoMap.getPane("locationBoundaryPane")) {
      window.veilleImmoMap.createPane("locationBoundaryPane");
    }
    const pane = window.veilleImmoMap.getPane("locationBoundaryPane");
    if (pane) {
      pane.style.zIndex = "350";
      pane.style.pointerEvents = "auto";
    }
  }

  function locationBoundaryKey(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    return locationKey(props.key || props.name || props.postalCode || "");
  }

  function configuredLocationKeySet(config) {
    const keys = new Set();
    configLocations(config).forEach(function (location) {
      const key = locationKey(location.name || location.postalCode || "");
      if (key) {
        keys.add(key);
      }
    });
    return keys;
  }

  function setSelectedLocations(keys) {
    selectedLocationKeys = new Set(keys);
    saveSelectedLocations();
    updateLocationFilterUi();
    applyPriceFilter();
  }

  function toggleSelectedLocation(key) {
    if (!selectedLocationKeys) {
      selectedLocationKeys = selectedLocationsFromStorage(latestConfig);
    }
    if (selectedLocationKeys.has(key)) {
      selectedLocationKeys.delete(key);
    } else {
      selectedLocationKeys.add(key);
    }
    saveSelectedLocations();
    updateLocationFilterUi();
    applyPriceFilter();
  }

  function renderLocationChips(locations) {
    const list = document.getElementById("locationChipList");
    if (!list) {
      return;
    }
    list.innerHTML = locations.map(function (location) {
      const key = locationKey(location.name || location.postalCode || "");
      return "<button type='button' class='location-chip' data-location-key='" + escapeHtml(key) + "' aria-pressed='true'>" + escapeHtml(location.name || location.postalCode || "") + "</button>";
    }).join("");
  }

  function injectLocationFilter(config) {
    latestConfig = config || latestConfig;
    const locations = configLocations(latestConfig);
    if (!locations.length) {
      return;
    }
    if (!selectedLocationKeys) {
      selectedLocationKeys = selectedLocationsFromStorage(latestConfig);
    }

    let panel = document.getElementById("locationFilterPanel");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "locationFilterPanel";
      panel.className = "location-filter-panel";
      panel.innerHTML = [
        "<div class='location-filter-head'>",
        "<div><span class='location-filter-title'>Communes incluses</span><span id='locationFilterCount' class='location-filter-count'></span></div>",
        "<div class='location-filter-actions'><button id='locationSelectAll' type='button'>Tout cocher</button><button id='locationSelectNone' type='button'>Tout décocher</button></div>",
        "</div>",
        "<div id='locationChipList' class='location-chip-list'></div>"
      ].join("");
      const map = document.getElementById("map");
      const anchor = map ? map.closest("section") : null;
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      } else {
        const pricePanel = document.getElementById("priceFilterPanel");
        if (pricePanel && pricePanel.parentNode) {
          pricePanel.parentNode.insertBefore(panel, pricePanel.nextSibling);
        }
      }
    }

    renderLocationChips(locations);
    if (!panel.dataset.locationFilterBound) {
      panel.dataset.locationFilterBound = "1";
      panel.addEventListener("click", function (event) {
        const chip = event.target.closest("[data-location-key]");
        if (chip) {
          toggleSelectedLocation(chip.dataset.locationKey);
          return;
        }
        if (event.target.id === "locationSelectAll") {
          setSelectedLocations(defaultLocationKeys(latestConfig));
        }
        if (event.target.id === "locationSelectNone") {
          setSelectedLocations([]);
        }
      });
    }
    syncLocationMapBoundaries(latestConfig);
    updateLocationFilterUi();
  }

  function updateLocationFilterUi() {
    const locations = configLocations(latestConfig);
    if (!locations.length || !selectedLocationKeys) {
      return;
    }
    const selectedCount = selectedLocationKeys.size;
    const count = document.getElementById("locationFilterCount");
    if (count) {
      count.textContent = selectedCount + " / " + locations.length;
    }
    document.querySelectorAll("[data-location-key]").forEach(function (node) {
      const active = selectedLocationKeys.has(node.dataset.locationKey);
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-pressed", active ? "true" : "false");
    });
    Object.keys(locationBoundariesByKey).forEach(function (key) {
      const boundary = locationBoundariesByKey[key];
      if (boundary && typeof boundary.setStyle === "function") {
        boundary.setStyle(locationBoundaryStyle(selectedLocationKeys.has(key), false));
      }
    });
  }

  function syncLocationMapBoundaries(config) {
    if (!window.L || !window.veilleImmoMap) {
      return;
    }
    const locations = configLocations(config);
    if (!locations.length) {
      return;
    }
    if (locationBoundaryLayer) {
      window.veilleImmoMap.removeLayer(locationBoundaryLayer);
    }
    locationBoundariesByKey = {};
    ensureLocationBoundaryPane();
    const allowedKeys = configuredLocationKeySet(config);
    const boundaryFeatures = latestLocationBoundaries && Array.isArray(latestLocationBoundaries.features)
      ? latestLocationBoundaries.features.filter(function (feature) {
        return allowedKeys.has(locationBoundaryKey(feature));
      })
      : [];
    if (!boundaryFeatures.length) {
      window.veilleImmoLocationBoundaryLayer = null;
      window.veilleImmoLocationBoundariesByKey = {};
      return;
    }
    locationBoundaryLayer = window.L.geoJSON({
      type: "FeatureCollection",
      features: boundaryFeatures
    }, {
      pane: "locationBoundaryPane",
      style: function (feature) {
        const key = locationBoundaryKey(feature);
        return locationBoundaryStyle(!selectedLocationKeys || selectedLocationKeys.has(key), false);
      },
      onEachFeature: function (feature, layer) {
        const key = locationBoundaryKey(feature);
        const props = feature && feature.properties ? feature.properties : {};
        if (!key) {
          return;
        }
        locationBoundariesByKey[key] = layer;
        layer.bindTooltip(props.name || key, { direction: "top", sticky: true });
        layer.on("mouseover", function () {
          layer.setStyle(locationBoundaryStyle(!selectedLocationKeys || selectedLocationKeys.has(key), true));
          if (typeof layer.bringToFront === "function") {
            layer.bringToFront();
          }
        });
        layer.on("mouseout", function () {
          layer.setStyle(locationBoundaryStyle(!selectedLocationKeys || selectedLocationKeys.has(key), false));
          if (locationBoundaryLayer && typeof locationBoundaryLayer.bringToBack === "function") {
            locationBoundaryLayer.bringToBack();
          }
        });
        layer.on("click", function (event) {
          if (window.L && window.L.DomEvent && event && event.originalEvent) {
            window.L.DomEvent.stopPropagation(event.originalEvent);
          }
          if (layer.closeTooltip) {
            layer.closeTooltip();
          }
          toggleSelectedLocation(key);
        });
      }
    }).addTo(window.veilleImmoMap);
    if (typeof locationBoundaryLayer.bringToBack === "function") {
      locationBoundaryLayer.bringToBack();
    }
    window.veilleImmoLocationBoundaryLayer = locationBoundaryLayer;
    window.veilleImmoLocationBoundariesByKey = locationBoundariesByKey;
    window.veilleImmoLocationBoundaryKeys = Object.keys(locationBoundariesByKey);
  }

  function ensureRoutePreviewLayer() {
    if (!window.L || !window.veilleImmoMap) {
      return null;
    }
    if (!routePreviewLayer) {
      routePreviewLayer = window.L.layerGroup().addTo(window.veilleImmoMap);
      window.veilleImmoRoutePreviewLayer = routePreviewLayer;
    }
    return routePreviewLayer;
  }

  function routePreviewStyle(mode, kind) {
    if (mode === "bike") {
      return { color: "#0f8f63", weight: 5, opacity: 0.88 };
    }
    if (mode === "transit") {
      return { color: transitOperatorColor(kind || "other"), weight: kind === "train" ? 5 : 4, opacity: 0.9 };
    }
    return { color: "#d97706", weight: 4, opacity: 0.86, dashArray: "8 7" };
  }

  function routePreviewHitStyle() {
    return { color: "#000", weight: 22, opacity: 0, interactive: true };
  }

  function routePreviewKey(input) {
    return [
      input.dataset.routeMode || "route",
      input.dataset.routeId || "",
      input.dataset.destLat || "",
      input.dataset.destLon || ""
    ].join("|");
  }

  function clearRoutePreviews() {
    if (routePreviewLayer && typeof routePreviewLayer.clearLayers === "function") {
      routePreviewLayer.clearLayers();
    }
    routePreviewEntries = {};
    if (window.veilleImmoMap && window.veilleImmoMap.getContainer) {
      window.veilleImmoMap.getContainer().classList.remove("route-preview-hide-popups");
    }
    document.querySelectorAll(".route-preview-toggle:checked").forEach(function (input) {
      input.checked = false;
    });
    window.veilleImmoRoutePreviewState = { count: 0, keys: [] };
  }

  function removeRoutePreview(key) {
    const layer = ensureRoutePreviewLayer();
    if (layer && routePreviewEntries[key]) {
      layer.removeLayer(routePreviewEntries[key]);
      delete routePreviewEntries[key];
    }
    document.querySelectorAll(".route-preview-toggle").forEach(function (input) {
      if (routePreviewKey(input) === key) {
        input.checked = false;
      }
    });
    if (!Object.keys(routePreviewEntries).length && window.veilleImmoMap && window.veilleImmoMap.getContainer) {
      window.veilleImmoMap.getContainer().classList.remove("route-preview-hide-popups");
    }
    window.veilleImmoRoutePreviewState = { count: Object.keys(routePreviewEntries).length, keys: Object.keys(routePreviewEntries), lastAction: "route-click" };
  }

  async function fetchBikeRouteLine(origin, dest) {
    const url = "https://routing.openstreetmap.de/routed-bike/route/v1/bike/"
      + origin.lon + "," + origin.lat + ";" + dest.lon + "," + dest.lat
      + "?overview=full&geometries=geojson&steps=false";
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    const data = await response.json();
    const coordinates = data && data.routes && data.routes[0] && data.routes[0].geometry && data.routes[0].geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new Error("Route OSM vide");
    }
    return coordinates.map(function (point) {
      return [point[1], point[0]];
    });
  }

  function transitBbox(origin, dest) {
    const south = Math.min(origin.lat, dest.lat) - 0.025;
    const north = Math.max(origin.lat, dest.lat) + 0.025;
    const west = Math.min(origin.lon, dest.lon) - 0.025;
    const east = Math.max(origin.lon, dest.lon) + 0.025;
    return [south, west, north, east].map(function (value) {
      return Number(value).toFixed(6);
    }).join(",");
  }

  function transitOverpassQuery(origin, dest) {
    const bbox = transitBbox(origin, dest);
    return [
      "[out:json][timeout:25];",
      "(",
      "relation[\"type\"=\"route\"][\"route\"~\"^(train|subway|tram|bus)$\"][\"operator\"~\"SNCB|NMBS|STIB|MIVB|De Lijn|TEC|OTW\",i](" + bbox + ");",
      ");",
      "out tags geom;"
    ].join("");
  }

  async function fetchTransitRouteSegments(origin, dest) {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: "data=" + encodeURIComponent(transitOverpassQuery(origin, dest))
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    const data = await response.json();
    const segments = [];
    (Array.isArray(data && data.elements) ? data.elements : []).forEach(function (element) {
      const kind = transitOperatorKind(element.tags || {});
      (Array.isArray(element.members) ? element.members : []).forEach(function (member) {
        const geometry = Array.isArray(member.geometry) ? member.geometry : [];
        if (geometry.length < 2) {
          return;
        }
        const points = geometry.map(function (point) {
          return [Number(point.lat), Number(point.lon)];
        }).filter(function (point) {
          return Number.isFinite(point[0]) && Number.isFinite(point[1]);
        });
        if (points.length >= 2) {
          segments.push({ kind: kind, label: transitOperatorLabel(kind), points: points });
        }
      });
    });
    if (!segments.length) {
      throw new Error("Aucune ligne TC OSM");
    }
    return segments.slice(0, 90);
  }

  function addRoutePolyline(group, points, style, key) {
    const line = window.L.polyline(points, style).addTo(group);
    const hitLine = window.L.polyline(points, routePreviewHitStyle()).addTo(group);
    function clearThisRoute() {
      removeRoutePreview(key);
    }
    line.on("click", clearThisRoute);
    hitLine.on("click", clearThisRoute);
    return line;
  }

  function fitRoutePreview(points) {
    if (!window.veilleImmoMap || !window.L || !Array.isArray(points) || points.length < 2) {
      return;
    }
    const bounds = window.L.latLngBounds(points);
    window.veilleImmoMap.fitBounds(bounds, { padding: [22, 22], maxZoom: 14 });
  }

  async function drawRoutePreview(input) {
    if (!input) {
      return;
    }
    const layer = ensureRoutePreviewLayer();
    if (!layer) {
      input.checked = false;
      return;
    }
    const key = routePreviewKey(input);
    if (!input.checked) {
      if (routePreviewEntries[key]) {
        layer.removeLayer(routePreviewEntries[key]);
        delete routePreviewEntries[key];
      }
      if (!Object.keys(routePreviewEntries).length && window.veilleImmoMap && window.veilleImmoMap.getContainer) {
        window.veilleImmoMap.getContainer().classList.remove("route-preview-hide-popups");
      }
      window.veilleImmoRoutePreviewState = { count: Object.keys(routePreviewEntries).length, keys: Object.keys(routePreviewEntries) };
      return;
    }
    const mode = input.dataset.routeMode || "bike";
    const origin = { lat: Number(input.dataset.originLat), lon: Number(input.dataset.originLon) };
    const dest = { lat: Number(input.dataset.destLat), lon: Number(input.dataset.destLon) };
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon) || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) {
      input.checked = false;
      return;
    }
    if (window.veilleImmoMap && window.veilleImmoMap.getContainer) {
      window.veilleImmoMap.getContainer().classList.add("route-preview-hide-popups");
    }
    const directPoints = [[origin.lat, origin.lon], [dest.lat, dest.lon]];
    let source = "direct";
    if (routePreviewEntries[key]) {
      layer.removeLayer(routePreviewEntries[key]);
    }
    const group = window.L.layerGroup().addTo(layer);
    addRoutePolyline(group, directPoints, routePreviewStyle(mode, "other"), key);
    routePreviewEntries[key] = group;
    fitRoutePreview(directPoints);
    window.veilleImmoRoutePreviewState = { count: Object.keys(routePreviewEntries).length, keys: Object.keys(routePreviewEntries), lastSource: "direct-loading", lastMode: mode };

    if (mode === "bike") {
      try {
        const points = await fetchBikeRouteLine(origin, dest);
        if (routePreviewEntries[key] === group && typeof group.clearLayers === "function") {
          group.clearLayers();
          addRoutePolyline(group, points, routePreviewStyle(mode), key);
          fitRoutePreview(points);
          source = "osm-bike";
        }
      } catch (error) {
        source = "direct-fallback";
      }
    } else if (mode === "transit") {
      try {
        const segments = await fetchTransitRouteSegments(origin, dest);
        if (routePreviewEntries[key] === group && typeof group.clearLayers === "function") {
          const allPoints = [];
          group.clearLayers();
          segments.forEach(function (segment) {
            addRoutePolyline(group, segment.points, routePreviewStyle(mode, segment.kind), key);
            segment.points.forEach(function (point) { allPoints.push(point); });
          });
          fitRoutePreview(allPoints.length ? allPoints : directPoints);
          source = "osm-transit";
          window.veilleImmoTransitPreviewState = {
            segments: segments.length,
            operators: segments.reduce(function (acc, segment) {
              acc[segment.kind] = (acc[segment.kind] || 0) + 1;
              return acc;
            }, {})
          };
        }
      } catch (error) {
        source = "direct-fallback";
      }
    }
    if (routePreviewEntries[key] !== group) {
      return;
    }
    if (window.veilleImmoMap && window.veilleImmoMap.getContainer) {
      window.veilleImmoMap.getContainer().classList.add("route-preview-hide-popups");
    }
    window.veilleImmoRoutePreviewState = { count: Object.keys(routePreviewEntries).length, keys: Object.keys(routePreviewEntries), lastSource: source, lastMode: mode };
  }

  function installRoutePreviewHandlers() {
    if (document.documentElement.dataset.routePreviewHandlers !== "1") {
      document.documentElement.dataset.routePreviewHandlers = "1";
      document.addEventListener("change", function (event) {
        const input = event.target && event.target.closest ? event.target.closest(".route-preview-toggle") : null;
        if (!input) {
          return;
        }
        event.stopPropagation();
        drawRoutePreview(input);
      }, true);
    }
    if (window.veilleImmoMap && typeof window.veilleImmoMap.on === "function" && !window.veilleImmoRoutePopupCloseBound) {
      window.veilleImmoRoutePopupCloseBound = true;
      window.veilleImmoMap.on("popupclose", function () {
        clearRoutePreviews();
      });
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
    const sources = dedupePhotoUrls(listing);
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

  function photoUrlKey(url) {
    const raw = String(url || "").trim();
    if (!raw) {
      return "";
    }
    try {
      const parsed = new URL(raw, window.location.href);
      const imageMatch = parsed.pathname.match(/\/images\/([^/]+)\//i);
      if (imageMatch) {
        return "image:" + imageMatch[1].toLowerCase();
      }
      return (parsed.origin + parsed.pathname)
        .replace(/\/(?:thumbnail-webp\/[^/?#]+|gallery-like-image\/[^?#]+)$/i, "")
        .toLowerCase();
    } catch (error) {
      return raw.replace(/[?#].*$/, "").toLowerCase();
    }
  }

  function dedupePhotoUrls(listing) {
    const rawPhotos = Array.isArray(listing.photoUrls) ? listing.photoUrls.filter(Boolean) : [];
    const allPhotos = rawPhotos.length ? rawPhotos : (listing.photoUrl ? [listing.photoUrl] : []);
    const hasImmovlanImages = allPhotos.some(function (url) {
      return /api-image\.immovlan\.be\/v1\/property\/[^/]+\/images\//i.test(String(url || ""));
    });
    const filtered = hasImmovlanImages
      ? allPhotos.filter(function (url) {
        return !/api-image\.immovlan\.be\/v1\/property\/[^/]+\/(?:thumbnail-webp|gallery-like-image)\//i.test(String(url || ""));
      })
      : allPhotos;
    const seen = new Set();
    return filtered.filter(function (url) {
      const key = photoUrlKey(url);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
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

  function locationByKey(config, key) {
    return configLocations(config).find(function (location) {
      return locationKey(location.name || location.postalCode || "") === key;
    }) || null;
  }

  function updatePrivateSourceLinks() {
    if (!latestConfig) {
      return;
    }
    const maxPrice = Number(currentPriceMax || configuredPriceMax(latestConfig));
    document.querySelectorAll("[data-private-source][data-private-location]").forEach(function (button) {
      const location = locationByKey(latestConfig, button.dataset.privateLocation);
      if (!location) {
        return;
      }
      if (button.dataset.privateSource === "2ememain") {
        button.dataset.externalUrl = secondHandSearchUrl(location, maxPrice);
      } else if (button.dataset.privateSource === "facebook") {
        button.dataset.externalUrl = facebookMarketplaceSearchUrl(location, maxPrice);
      } else if (button.dataset.privateSource === "web") {
        button.dataset.externalUrl = privateWebSearchUrl(location, maxPrice);
      }
    });
  }

  function isPrivateListing(listing) {
    return sourceKind(listing && listing.source) === "p2p";
  }

  function hasUsablePrivateListing(listing) {
    if (!isPrivateListing(listing)) {
      return true;
    }
    const sellerName = String(listing.agentName || "").trim();
    const sellerProfile = String(listing.agentWebsite || "").trim();
    const hasSpecificSeller = sellerName && !/^particulier(?:\s+2ememain)?$/i.test(sellerName);
    const hasSpecificProfile = sellerProfile && !/^https:\/\/www\.2ememain\.be\/?$/i.test(sellerProfile);
    const hasContact = Boolean(String(listing.agentPhone || listing.agentEmail || "").trim() || hasSpecificSeller || hasSpecificProfile);
    const hasDetails = Number(listing.surfaceM2 || 0) > 0 || Number(listing.bedrooms || 0) > 0;
    return dedupePhotoUrls(listing).length > 0 && hasDetails && hasContact;
  }

  function renderPrivateSourceLinks(config) {
    const locations = Array.isArray(config && config.locations) ? config.locations : [];
    const maxPrice = Number(currentPriceMax || configuredPriceMax(config));
    if (!locations.length) {
      return "";
    }
    const rows = locations.map(function (location) {
      const key = locationKey(location.name || location.postalCode || "");
      return [
        "<tr>",
        "<td>" + escapeHtml(location.name || "") + "</td>",
        "<td><button type='button' class='external-link-button' data-private-source='2ememain' data-private-location='" + escapeHtml(key) + "' data-external-url='" + escapeHtml(secondHandSearchUrl(location, maxPrice)) + "'>2ememain</button></td>",
        "<td><button type='button' class='external-link-button' data-private-source='facebook' data-private-location='" + escapeHtml(key) + "' data-external-url='" + escapeHtml(facebookMarketplaceSearchUrl(location, maxPrice)) + "'>Facebook</button></td>",
        "<td><button type='button' class='external-link-button' data-private-source='web' data-private-location='" + escapeHtml(key) + "' data-external-url='" + escapeHtml(privateWebSearchUrl(location, maxPrice)) + "'>Web privé</button></td>",
        "</tr>"
      ].join("");
    }).join("");
    return [
      "<section id='privateSourceLinks'>",
      "<h3>Liens de controle particulier a particulier</h3>",
      "<div class='other-source-note'>Ces liens restent en bas de section. Les annonces particulier a particulier ne sont affichees en cartes que si elles ont des photos, des details de surface ou chambres et un contact ou profil vendeur exploitable.</div>",
      "<table><thead><tr><th>Commune</th><th>2ememain</th><th>Facebook Marketplace</th><th>Recherche web</th></tr></thead><tbody>",
      rows,
      "</tbody></table>",
      "</section>"
    ].join("");
  }

  function legacyListingHeading() {
    return Array.from(document.querySelectorAll("h2")).find(function (heading) {
      return /annonces trouvees automatiquement/i.test(heading.textContent || "");
    }) || null;
  }

  function listingInsertionAnchor() {
    return document.getElementById("allListingsSection") || legacyListingHeading();
  }

  function removeLegacyListingSection() {
    const heading = legacyListingHeading();
    if (!heading) {
      return;
    }
    const next = heading.nextElementSibling;
    if (next && next.classList && next.classList.contains("cards")) {
      next.remove();
    }
    heading.remove();
  }

  function renderOtherSources(payload, config) {
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
    const others = listings.filter(function (listing) {
      return String(listing.source || "").toLowerCase() !== "immoweb";
    });
    const properOthers = others.filter(function (listing) {
      return !isPrivateListing(listing) || hasUsablePrivateListing(listing);
    });
    const usableSecondHandCount = properOthers.filter(function (listing) {
      return String(listing.source || "").toLowerCase().indexOf("2ememain") !== -1;
    }).length;
    const existing = document.getElementById("otherSourcesSection");
    if (existing) {
      existing.remove();
    }

    const listingsSection = document.getElementById("allListingsSection");
    const anchor = listingsSection || listingInsertionAnchor();
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
      "<div class='source-diagnostic-item'><strong>2ememain</strong>Extraction avancee active via pages publiques et window.__CONFIG__. " + usableSecondHandCount + " annonce(s) exploitable(s) en cartes sur " + secondHandCount + " candidate(s) publiee(s).</div>",
      "<div class='source-diagnostic-item'><strong>Facebook Marketplace</strong>Lien de controle ajoute. Extraction automatique non active sans session utilisateur.</div>",
      "</div>",
      renderDiagnosticSummary(payload.sourceDiagnostics)
    ].join("");
    if (listingsSection) {
      listingsSection.parentNode.insertBefore(section, listingsSection.nextSibling);
    } else {
      anchor.parentNode.insertBefore(section, anchor);
    }
  }

  function renderUnifiedListings(payload, config) {
    const listings = (Array.isArray(payload && payload.listings) ? payload.listings : []).filter(function (listing) {
      return hasUsablePrivateListing(listing);
    });
    const existing = document.getElementById("allListingsSection");
    if (existing) {
      existing.remove();
    }
    const anchor = listingInsertionAnchor();
    const parent = anchor && anchor.parentNode ? anchor.parentNode : document.querySelector("main") || document.body;
    const section = document.createElement("section");
    section.id = "allListingsSection";
    section.innerHTML = [
      "<h2>Annonces exploitables</h2>",
      listings.length ? "<section class='cards' id='dataListingCards'>" + listings.map(renderOtherSourceCard).join("") + "</section>" : "<div class='empty'>Aucune annonce exploitable dans le dernier jeu de donnees publie.</div>",
      renderPrivateSourceLinks(config)
    ].join("");
    if (anchor && anchor.parentNode) {
      parent.insertBefore(section, anchor);
    } else {
      parent.appendChild(section);
    }
    removeLegacyListingSection();
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
      "<article class='listing-card" + (listingIsUnderOption(listing) ? " is-under-option" : "") + "' id='listing-other-" + escapeHtml(listing.id || listing.url || "") + "'>",
      renderPhotoStrip(listing),
      "<div class='listing-body'>",
      renderSourceBadge(listing.source, listing),
      "<div class='listing-title'>" + escapeHtml(listing.title || "Annonce autre source") + "</div>",
      "<div class='facts'><div><span class='fact-label'>Prix</span> <span class='price'>" + escapeHtml(formatPrice(listing.price)) + "</span></div>" + details.join("") + "</div>",
      "<div class='links'><button type='button' class='external-link-button' data-external-url='" + escapeHtml(listing.url || "#") + "'>Ouvrir l'annonce</button></div>",
      listing.address ? "<div class='small'>" + escapeHtml(listing.address) + "</div>" : "",
      "<details class='contact listing-contact-details'><summary>Contact / agence</summary><strong>" + escapeHtml(listing.agentName || listing.source || "Source") + "</strong>" + (contactParts.length ? "<br>" + contactParts.join(" · ") : "") + "</details>",
      "</div>",
      "</article>"
    ].join("");
  }

  function setRebuildFeedback(message, busy) {
    const button = document.getElementById("reportRebuildButton");
    const status = document.getElementById("reportRebuildStatus");
    if (button) {
      button.disabled = Boolean(busy);
      button.textContent = busy ? "Recalcul..." : "Recalculer";
      button.setAttribute("aria-busy", busy ? "true" : "false");
    }
    if (status) {
      status.textContent = message || "";
    }
    if (message) {
      showStatus(message);
    }
  }

  async function refreshReportData(manual) {
    try {
      if (manual) {
        setRebuildFeedback("Clic confirme. Recalcul en cours...", true);
      }
      const payload = await fetchResults();
      let config = latestConfig;
      try {
        config = await fetchConfig();
      } catch (error) {
      }
      try {
        latestLocationBoundaries = await fetchLocationBoundaries();
      } catch (error) {
        latestLocationBoundaries = latestLocationBoundaries || { type: "FeatureCollection", features: [] };
      }
      latestPayload = payload;
      latestConfig = config || latestConfig;
      updateReportHeader(payload, latestConfig);
      annotateSourceBadges(payload);
      syncSourceMapMarkers(payload);
      installRoutePreviewHandlers();
      injectPriceFilter(payload, latestConfig);
      if (latestConfig) {
        injectLocationFilter(latestConfig);
      }
      renderUnifiedListings(payload, latestConfig);
      renderOtherSources(payload, latestConfig);
      annotateSourceBadges(payload);
      syncSourceMapMarkers(payload);
      installRoutePreviewHandlers();
      applyPriceFilter();
      if (manual) {
        setRebuildFeedback("Recalcul termine: carte et liste mises a jour.", false);
      }
      return payload;
    } catch (error) {
      if (manual) {
        setRebuildFeedback("Recalcul impossible pour le moment.", false);
      }
      throw error;
    }
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
    installRoutePreviewHandlers();
    const pageButton = document.getElementById("installButton");
    if (pageButton) {
      pageButton.addEventListener("click", promptInstall);
    }
    try {
      await registerServiceWorker();
    } catch (error) {
    }
    updateInstallButtons();
    refreshReportData(false).catch(function () {});
    checkForNewListings(false);
  });

  window.VeilleImmoPwa = {
    version: APP_VERSION,
    checkForNewListings: checkForNewListings,
    refreshReportData: refreshReportData,
    hardRefreshApplication: hardRefreshApplication
  };
})();
