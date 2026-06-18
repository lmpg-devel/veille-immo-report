(function () {
  "use strict";

  const APP_VERSION = "pwa-1.0";
  const RESULTS_URL = "results.json";
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

  function listingText(listing) {
    const price = listing.price ? new Intl.NumberFormat("fr-BE").format(listing.price) + " EUR" : "Prix inconnu";
    const locality = listing.locality || "Commune inconnue";
    return price + " - " + locality;
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
    checkForNewListings(false);
  });

  window.VeilleImmoPwa = {
    version: APP_VERSION,
    checkForNewListings: checkForNewListings
  };
})();
