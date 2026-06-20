const CACHE_NAME = "veille-immo-pwa-2026-06-21-02";
const DB_NAME = "veille-immo-pwa";
const DB_VERSION = 1;
const STORE_NAME = "state";
const STATIC_ASSETS = [
  "./",
  "index.html",
  "install.html",
  "manifest.webmanifest",
  "pwa.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isFreshResource(request, url)) {
    event.respondWith(networkFirst(request, "index.html"));
    return;
  }

  event.respondWith(networkFirst(request, null));
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (type === "CLEAR_RUNTIME_CACHE") {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((key) => key.indexOf("veille-immo-pwa-") === 0).map((key) => caches.delete(key))))
    );
  }
});

function isFreshResource(request, url) {
  if (request.mode === "navigate") {
    return true;
  }
  return url.pathname.endsWith("/index.html")
    || url.pathname.endsWith("/install.html")
    || url.pathname.endsWith("/pwa.js")
    || url.pathname.endsWith("/results.json")
    || url.pathname.endsWith("/manifest.webmanifest");
}

async function networkFirst(request, fallbackPath) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, copy);
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    if (fallbackPath) {
      const fallback = await caches.match(fallbackPath);
      if (fallback) {
        return fallback;
      }
    }
    throw error;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("./");
      }
      return undefined;
    })
  );
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "check-listings") {
    event.waitUntil(checkListingsAndNotify());
  }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getValue(key, fallback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result === undefined ? fallback : request.result);
    request.onerror = () => reject(request.error);
  });
}

async function setValue(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function checkListingsAndNotify() {
  const response = await fetch("results.json?t=" + Date.now(), {
    cache: "no-store",
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) {
    return;
  }
  const payload = await response.json();
  const listings = Array.isArray(payload.listings) ? payload.listings : [];
  const initialized = await getValue("initialized", false);
  const seenIds = new Set(await getValue("seenIds", []));
  const nextSeenIds = new Set(seenIds);
  const newListings = [];

  listings.forEach((listing) => {
    const id = String(listing.id || "");
    if (!id) {
      return;
    }
    if (initialized && !seenIds.has(id)) {
      newListings.push(listing);
    }
    nextSeenIds.add(id);
  });

  await setValue("initialized", true);
  await setValue("seenIds", Array.from(nextSeenIds));

  if (!initialized || newListings.length === 0) {
    return;
  }

  const first = newListings[0];
  const price = first.price ? new Intl.NumberFormat("fr-BE").format(first.price) + " EUR" : "Prix inconnu";
  const locality = first.locality || "Commune inconnue";
  const title = newListings.length === 1 ? "1 nouvelle maison" : newListings.length + " nouvelles maisons";

  await self.registration.showNotification(title, {
    body: price + " - " + locality,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: "veille-immo-new-listings",
    data: { url: "./" }
  });
}
