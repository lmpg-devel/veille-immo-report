(function () {
  "use strict";

const APP_VERSION = "pwa-2026-06-19-13";
  const RESULTS_URL = "results.json";
  const CONFIG_URL = "config/veille-immo.json";
  const STORAGE_KEY = "veille-immo-seen-ids";
  const INIT_KEY = "veille-immo-initialized";
  let deferredInstallPrompt = null;

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
      return;
    }
    if (!window.L || !window.veilleImmoMap) {
      return;
    }
    if (window.veilleImmoExtraSourceMarkers) {
      window.veilleImmoMap.removeLayer(window.veilleImmoExtraSourceMarkers);
    }
    const layer = window.L.layerGroup().addTo(window.veilleImmoMap);
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : [];
    listings.forEach(function (listing) {
      const kind = sourceKind(listing.source);
      if (kind === "immoweb") {
        return;
      }
      const lat = Number(listing.latitude);
      const lon = Number(listing.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return;
      }
      const icon = sourceMarkerIcon(listing.source);
      const marker = window.L.marker([lat, lon], icon ? { icon: icon } : {}).addTo(layer);
      marker.bindPopup([
        "<strong>" + escapeHtml(formatPrice(listing.price)) + "</strong><br>",
        "<span>" + escapeHtml(sourceLabel(listing.source)) + "</span><br>",
        listing.address ? escapeHtml(listing.address) + "<br>" : "",
        listing.geoPrecision ? "<span>" + escapeHtml(listing.geoPrecision) + "</span><br>" : "",
        escapeHtml(listing.agentName || "") + (listing.agentPhone ? " " + escapeHtml(listing.agentPhone) : "") + "<br>",
        "<button type='button' class='external-link-button' data-external-url='" + escapeHtml(listing.url || "#") + "'>Ouvrir l'annonce</button>"
      ].join(""));
    });
    window.veilleImmoExtraSourceMarkers = layer;
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
      : "Connecteur Apify pret: definir APIFY_TOKEN et APIFY_ZIMMO_ACTOR_ID cote pipeline pour integrer les annonces Zimmo.";
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
      "<div class='links'><button type='button' class='external-link-button' data-external-url='" + escapeHtml(listing.url || "#") + "'>Ouvrir l'annonce</button></div>",
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
      annotateSourceBadges(payload);
      syncSourceMapMarkers(payload);
      return fetchConfig()
        .then(function (config) {
          renderOtherSources(payload, config);
          annotateSourceBadges(payload);
          syncSourceMapMarkers(payload);
        })
        .catch(function () {
          renderOtherSources(payload, null);
          annotateSourceBadges(payload);
          syncSourceMapMarkers(payload);
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
