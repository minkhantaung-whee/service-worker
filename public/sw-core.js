"use strict";

const STATIC_CACHE = "mock-market-static-v1";
const API_CACHE = "mock-market-api-v1";
const OFFLINE_URL = "/offline.html";
const CHECKOUT_ENDPOINT = "https://fakestoreapi.com/carts";
const CHECKOUT_SYNC_TAG = "mock-market-checkout-sync";
const DB_NAME = "mock-market-db";
const DB_VERSION = 1;
const CHECKOUT_STORE = "checkout-queue";

const FALLBACK_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><rect width='100%' height='100%' fill='%23e2e8f0'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%23475569' font-size='28' font-family='Arial, sans-serif'>Offline</text></svg>";

const FALLBACK_PRODUCTS = [
  {
    id: "offline-1",
    title: "Offline Essentials Pack",
    price: 39.99,
    description:
      "Cached sample product available while your device is offline. Syncs when you reconnect.",
    image: FALLBACK_IMAGE,
  },
  {
    id: "offline-2",
    title: "Cached Comfort Hoodie",
    price: 59.99,
    description:
      "Cozy stand-in item fetched from the service worker cache so you can keep browsing.",
    image: FALLBACK_IMAGE,
  },
];

const CACHE_STRATEGY_LABELS = {
  "stale-while-revalidate": "Stale-While-Revalidate",
  "cache-first": "Cache First",
  "network-first": "Network First",
  "cache-only": "Cache Only",
  "network-only": "Network Only",
};

const DEFAULT_CACHE_STRATEGY = "stale-while-revalidate";
const ALLOWED_CACHE_STRATEGIES = new Set(
  Object.keys(CACHE_STRATEGY_LABELS)
);

let currentCacheStrategy = DEFAULT_CACHE_STRATEGY;

function createFallbackProductsResponse() {
  return new Response(JSON.stringify(FALLBACK_PRODUCTS), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function onInstall(event) {
  event.waitUntil(precacheStaticAssets());
  self.skipWaiting();
}

async function precacheStaticAssets() {
  const cache = await caches.open(STATIC_CACHE);
  await cache.addAll([OFFLINE_URL, "/sw-core.js"]);
}

function onActivate(event) {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => ![STATIC_CACHE, API_CACHE].includes(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
      await broadcast("SW_TOAST", {
        message: "Service worker ready for offline shopping.",
        level: "success",
      });
      await broadcastCacheStrategy();
    })()
  );
}

function onFetch(event) {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(handleNavigationRequest(request));
      return;
    }

    if ([OFFLINE_URL, "/sw.js", "/sw-core.js"].includes(url.pathname)) {
      return;
    }

    event.respondWith(cacheFirstStrategy(request, { cacheName: STATIC_CACHE }));
    return;
  }

  if (url.hostname === "fakestoreapi.com") {
    event.respondWith(handleApiRequest(request));
    return;
  }

  event.respondWith(networkOnlyStrategy(request));
}

function onMessage(event) {
  const { type, payload } = event.data || {};

  if (type === "CHECKOUT_SUBMIT") {
    event.waitUntil(handleCheckoutSubmit(payload?.order));
    return;
  }

  if (type === "PROCESS_CHECKOUT_QUEUE") {
    event.waitUntil(processCheckoutQueue());
    return;
  }

  if (type === "SET_CACHE_STRATEGY") {
    event.waitUntil(setCacheStrategy(payload?.strategy));
    return;
  }

  if (type === "GET_CACHE_STRATEGY") {
    event.waitUntil(broadcastCacheStrategy());
    return;
  }

  if (type === "PREFETCH_PRODUCTS") {
    event.waitUntil(prefetchProducts(payload?.url));
  }
}

function onSync(event) {
  if (event.tag === CHECKOUT_SYNC_TAG) {
    event.waitUntil(processCheckoutQueue());
  }
}

function onBackgroundFetchSuccess(event) {
  event.waitUntil(handleBackgroundFetchSuccess(event));
}

function onBackgroundFetchFail(event) {
  event.waitUntil(
    broadcast("SW_BACKGROUND_FETCH_STATUS", {
      status: "Background fetch failed.",
      message: "Background fetch failed. Items will remain cached.",
      level: "error",
    })
  );
}

function onBackgroundFetchAbort(event) {
  event.waitUntil(
    broadcast("SW_BACKGROUND_FETCH_STATUS", {
      status: "Background fetch aborted.",
      message: "Background fetch was aborted by the browser.",
      level: "warning",
    })
  );
}

async function handleNavigationRequest(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(STATIC_CACHE);
    const offlinePage = await cache.match(OFFLINE_URL);
    return offlinePage || Response.error();
  }
}

async function handleApiRequest(request) {
  if (isProductsRequest(request)) {
    return handleProductsRequest(request);
  }

  try {
    return await networkFirstStrategy(request, { cacheName: API_CACHE });
  } catch (error) {
    const cached = await cacheOnlyStrategy(request, { cacheName: API_CACHE });
    if (cached) {
      return cached;
    }
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

async function handleProductsRequest(request) {
  try {
    const { response, source, extraBroadcasts = [] } =
      await executeProductStrategy(request);

    extraBroadcasts.forEach((pending) => {
      Promise.resolve(pending)
        .then(async (result) => {
          if (result && result.response) {
            await broadcastProductsFromResponse(result.response, {
              source: result.source || "network",
              strategy: currentCacheStrategy,
              timestamp: new Date().toISOString(),
            });
          }
        })
        .catch(() => {});
    });

    if (response) {
      await broadcastProductsFromResponse(response, {
        source: source || "network",
        strategy: currentCacheStrategy,
        timestamp: new Date().toISOString(),
      });
      return response;
    }
  } catch (error) {
    // Fall through to cached or offline fallback handling.
  }

  const cached = await cacheOnlyStrategy(request, { cacheName: API_CACHE });
  if (cached) {
    await broadcast("SW_TOAST", {
      message: "Showing cached products while offline.",
      level: "warning",
    });
    await broadcastProductsFromResponse(cached, {
      source: "cache",
      strategy: currentCacheStrategy,
      timestamp: new Date().toISOString(),
      reason: "offline-fallback",
    });
    return cached;
  }

  await broadcast("SW_TOAST", {
    message: "Loaded offline fallback products.",
    level: "warning",
  });
  await broadcast("SW_PRODUCTS", {
    items: FALLBACK_PRODUCTS,
    meta: {
      source: "fallback",
      strategy: currentCacheStrategy,
      timestamp: new Date().toISOString(),
    },
  });
  return createFallbackProductsResponse();
}

async function executeProductStrategy(request) {
  switch (currentCacheStrategy) {
    case "cache-first":
      return runCacheFirstForProducts(request);
    case "network-first":
      return runNetworkFirstForProducts(request);
    case "cache-only":
      return runCacheOnlyForProducts(request);
    case "network-only":
      return runNetworkOnlyForProducts(request);
    case "stale-while-revalidate":
    default:
      return runStaleWhileRevalidateForProducts(request);
  }
}

async function broadcastProductsFromResponse(response, meta = {}) {
  if (!response) {
    return;
  }

  try {
    const data = await response.clone().json();
    if (Array.isArray(data)) {
      await broadcast("SW_PRODUCTS", {
        items: data,
        meta: {
          strategy: meta.strategy || currentCacheStrategy,
          source: meta.source || "unknown",
          timestamp: meta.timestamp || new Date().toISOString(),
          reason: meta.reason,
        },
      });
    }
  } catch (error) {
    // Ignore JSON parsing failures.
  }
}

async function runCacheFirstForProducts(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return { response: cached, source: "cache", extraBroadcasts: [] };
  }

  const networkResponse = await fetch(request);
  if (networkResponse && networkResponse.ok) {
    await cache.put(request, networkResponse.clone());
  }
  return { response: networkResponse, source: "network", extraBroadcasts: [] };
}

async function runNetworkFirstForProducts(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return { response: networkResponse, source: "network", extraBroadcasts: [] };
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return { response: cached, source: "cache", extraBroadcasts: [] };
    }
    throw error;
  }
}

async function runCacheOnlyForProducts(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  return {
    response: cached || null,
    source: cached ? "cache" : null,
    extraBroadcasts: [],
  };
}

async function runNetworkOnlyForProducts(request) {
  const networkResponse = await fetch(request);
  return { response: networkResponse, source: "network", extraBroadcasts: [] };
}

async function runStaleWhileRevalidateForProducts(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  const networkFetch = async () => {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  };

  if (cached) {
    const networkPromise = networkFetch()
      .then((networkResponse) => {
        if (!networkResponse) {
          return null;
        }
        return {
          response: networkResponse,
          source: "network-refresh",
        };
      })
      .catch(() => null);

    return {
      response: cached,
      source: "cache",
      extraBroadcasts: [networkPromise],
    };
  }

  const networkResponse = await networkFetch();
  return { response: networkResponse, source: "network", extraBroadcasts: [] };
}

function isProductsRequest(request) {
  const url = new URL(request.url);
  return url.hostname === "fakestoreapi.com" && url.pathname.startsWith("/products");
}

async function cacheFirstStrategy(request, { cacheName = STATIC_CACHE } = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (cached) {
      return cached;
    }
    return Response.error();
  }
}

async function networkFirstStrategy(request, { cacheName = STATIC_CACHE } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function staleWhileRevalidateStrategy(
  request,
  { cacheName = STATIC_CACHE, onCacheHit, onNetworkResponse, onFetchError } = {}
) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        await cache.put(request, networkResponse.clone());
      }
      if (typeof onNetworkResponse === "function") {
        try {
          await onNetworkResponse(networkResponse.clone());
        } catch (callbackError) {
          // Ignore callback errors.
        }
      }
      return networkResponse;
    })
    .catch(async (error) => {
      if (typeof onFetchError === "function") {
        try {
          await onFetchError(error);
        } catch (callbackError) {
          // Ignore callback errors.
        }
      }
      throw error;
    });

  if (cached) {
    if (typeof onCacheHit === "function") {
      try {
        await onCacheHit(cached.clone());
      } catch (callbackError) {
        // Ignore callback errors.
      }
    }
    networkPromise.catch(() => {});
    return cached;
  }

  return networkPromise;
}

async function networkOnlyStrategy(request) {
  return fetch(request);
}

async function cacheOnlyStrategy(request, { cacheName = STATIC_CACHE } = {}) {
  const cache = await caches.open(cacheName);
  return cache.match(request);
}

async function handleCheckoutSubmit(order) {
  if (!order) {
    return;
  }

  try {
    await submitOrder(order);
    await broadcast("SW_CHECKOUT_ACCEPTED", {
      message: "Checkout completed online.",
      level: "success",
      orderId: order.id,
    });
  } catch (error) {
    await queueCheckout(order);
    if (self.registration.sync) {
      try {
        await self.registration.sync.register(CHECKOUT_SYNC_TAG);
      } catch (registerError) {
        // Ignore registration errors; manual processing is still available.
      }
    }
    await broadcast("SW_CHECKOUT_ACCEPTED", {
      message: "Checkout saved for background sync.",
      level: "warning",
      orderId: order.id,
      queued: true,
    });
  }
}

async function processCheckoutQueue() {
  const queued = await getQueuedCheckouts();
  if (!queued.length) {
    await broadcast("SW_SYNC_COMPLETED", {
      message: "Checkout queue empty.",
      level: "info",
      processed: 0,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  let processed = 0;

  for (const order of queued) {
    try {
      await submitOrder(order);
      await removeQueuedCheckout(order.id);
      processed += 1;
    } catch (error) {
      await broadcast("SW_SYNC_FAILED", {
        message: `Checkout ${order.id} failed to sync: ${error.message}`,
      });
      throw error;
    }
  }

  await broadcast("SW_SYNC_COMPLETED", {
    message: `${processed} checkout${processed === 1 ? "" : "s"} synced.`,
    level: "success",
    processed,
    completedAt: new Date().toISOString(),
  });
}

async function submitOrder(order) {
  const date = new Date(order.createdAt || Date.now())
    .toISOString()
    .split("T")[0];

  const payload = {
    userId: 1,
    date,
    products: order.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
  };

  const response = await fetch(CHECKOUT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Status ${response.status}`);
  }

  return response.json();
}

async function prefetchProducts(url) {
  if (!url) {
    return;
  }

  try {
    const request = new Request(url, { mode: "cors" });
    const response = await networkFirstStrategy(request, { cacheName: API_CACHE });
    if (!response || !response.ok) {
      throw new Error("Prefetch returned an invalid response.");
    }

    await broadcastProductsFromResponse(response, {
      source: "prefetch",
      strategy: currentCacheStrategy,
      timestamp: new Date().toISOString(),
    });

    await broadcast("SW_BACKGROUND_FETCH_STATUS", {
      status: "Prefetch complete.",
      message: "Products prefetched and cached.",
      level: "success",
    });
  } catch (error) {
    await broadcast("SW_BACKGROUND_FETCH_STATUS", {
      status: "Prefetch failed.",
      message: `Prefetch failed: ${error.message}`,
      level: "error",
    });
  }
}

async function handleBackgroundFetchSuccess(event) {
  const records = await event.downloads();
  const cache = await caches.open(API_CACHE);
  const aggregatedProducts = [];

  for (const record of records) {
    const response = await record.responseReady;
    await cache.put(record.request, response.clone());

    if (isProductsRequest(record.request)) {
      try {
        const data = await response.clone().json();
        if (Array.isArray(data)) {
          aggregatedProducts.push(...data);
        }
      } catch (error) {
        // Ignore JSON parsing errors.
      }
    }
  }

  if (aggregatedProducts.length) {
    await broadcast("SW_PRODUCTS", {
      items: aggregatedProducts,
      meta: {
        source: "background-fetch",
        strategy: currentCacheStrategy,
        timestamp: new Date().toISOString(),
      },
    });
  }

  await broadcast("SW_BACKGROUND_FETCH_STATUS", {
    status: "Background fetch completed.",
    message: "Background fetch completed.",
    level: "success",
  });

  if (event.updateUI) {
    await event.updateUI({ title: "Catalog updated" });
  }
}

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHECKOUT_STORE)) {
        db.createObjectStore(CHECKOUT_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueCheckout(order) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKOUT_STORE, "readwrite");
    const store = tx.objectStore(CHECKOUT_STORE);
    store.put({ ...order, queuedAt: new Date().toISOString() });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function getQueuedCheckouts() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKOUT_STORE, "readonly");
    const store = tx.objectStore(CHECKOUT_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result || []);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function removeQueuedCheckout(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKOUT_STORE, "readwrite");
    tx.objectStore(CHECKOUT_STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function setCacheStrategy(strategy) {
  if (!strategy || !ALLOWED_CACHE_STRATEGIES.has(strategy)) {
    await broadcast("SW_TOAST", {
      message: "Unsupported cache strategy requested.",
      level: "error",
    });
    await broadcastCacheStrategy();
    return;
  }

  if (strategy === currentCacheStrategy) {
    await broadcastCacheStrategy();
    return;
  }

  currentCacheStrategy = strategy;

  await broadcastCacheStrategy();
  await broadcast("SW_TOAST", {
    message: `Cache strategy set to ${CACHE_STRATEGY_LABELS[strategy] || strategy}.`,
    level: "info",
  });
}

async function broadcastCacheStrategy() {
  await broadcast("SW_CACHE_STRATEGY", { strategy: currentCacheStrategy });
}

async function broadcast(type, payload) {
  try {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of clients) {
      client.postMessage({ type, payload });
    }
  } catch (error) {
    // No available clients to receive the broadcast.
  }
}
