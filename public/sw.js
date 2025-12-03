const VERSION = "sw-tester-v1";
const STATIC_CACHE = `static-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const CORE_ASSETS = ["/", OFFLINE_URL, "/manifest.json", "/vite.svg"];
const SYNC_DB = "sw-tester-sync";
const OUTBOX_STORE = "outbox";

let lifecycleState = "booting";
let runtimeStrategy = "network-first";

const STRATEGY_VALUES = new Set([
	"network-first",
	"cache-first",
	"stale-while-revalidate",
	"cache-only",
	"network-only",
]);

const currentStatePayload = () => ({
	state: lifecycleState,
	version: VERSION,
	strategy: runtimeStrategy,
});

const notifyStrategy = async (client, message) => {
	const data = {
		type: "FETCH_STRATEGY",
		payload: { strategy: runtimeStrategy },
	};
	if (message) data.message = message;
	if (client) {
		sendToClient(client, data);
		return;
	}
	await broadcast(data);
};

const log = (...args) => {
	console.log("[SW]", ...args);
};

const hasIndexedDB = () => typeof indexedDB !== "undefined";

const sendToClient = (client, data) => {
	if (!client) return;
	client.postMessage({
		source: "service-worker",
		version: VERSION,
		...data,
	});
};

const broadcast = async (data) => {
	const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const client of allClients) {
		sendToClient(client, data);
	}
};

const openOutbox = () =>
	new Promise((resolve, reject) => {
		if (!hasIndexedDB()) {
			reject(new Error("IndexedDB is unavailable in this context."));
			return;
		}
		const request = indexedDB.open(SYNC_DB, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
				db.createObjectStore(OUTBOX_STORE, { keyPath: "id", autoIncrement: true });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const addToOutbox = async (payload) => {
	const db = await openOutbox();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(OUTBOX_STORE, "readwrite");
		tx.objectStore(OUTBOX_STORE).add({ createdAt: Date.now(), payload });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
};

const readOutbox = async () => {
	const db = await openOutbox();
	const records = await new Promise((resolve, reject) => {
		const tx = db.transaction(OUTBOX_STORE, "readonly");
		const request = tx.objectStore(OUTBOX_STORE).getAll();
		request.onsuccess = () => resolve(request.result || []);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return records;
};

const removeFromOutbox = async (id) => {
	const db = await openOutbox();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(OUTBOX_STORE, "readwrite");
		tx.objectStore(OUTBOX_STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
};

const cacheCoreAssets = async () => {
	const cache = await caches.open(STATIC_CACHE);
	await Promise.all(
		CORE_ASSETS.map(async (asset) => {
			try {
				const request = asset === "/" ? new Request(asset, { cache: "reload" }) : asset;
				await cache.add(request);
				log("Cached core asset:", asset);
			} catch (error) {
				log("Failed to precache asset", asset, error);
			}
		})
	);
};

const cleanupOldCaches = async () => {
	const keys = await caches.keys();
	await Promise.all(
		keys
			.filter((key) => ![STATIC_CACHE, RUNTIME_CACHE].includes(key))
			.map(async (key) => {
				log("Deleting old cache", key);
				await caches.delete(key);
			})
	);
};

const maybeEnableNavigationPreload = async () => {
	if (self.registration.navigationPreload) {
		try {
			await self.registration.navigationPreload.enable();
			log("Navigation preload enabled.");
		} catch (error) {
			log("Navigation preload enable failed:", error);
		}
	}
};

const cacheRuntimeResponse = async (request, response) => {
	if (!response || response.status >= 400) return;
	const cache = await caches.open(RUNTIME_CACHE);
	await cache.put(request, response.clone());
};

const offlineFallback = async (request) => {
	if (request.mode === "navigate") {
		const cache = await caches.open(STATIC_CACHE);
		const offlineResponse = await cache.match(OFFLINE_URL);
		if (offlineResponse) return offlineResponse;
	}
	const cached = await caches.match(request);
	if (cached) return cached;
	return new Response("Offline", {
		status: 503,
		statusText: "Service Unavailable",
		headers: { "Content-Type": "text/plain" },
	});
};

const handleNavigationRequest = async (event) => {
	try {
		const preload = await event.preloadResponse;
		if (preload) {
			log("Using preload response for navigation.");
			return preload;
		}
		const networkResponse = await fetch(event.request);
		await cacheRuntimeResponse(event.request, networkResponse);
		return networkResponse.clone();
	} catch (error) {
		log("Navigation request failed, serving offline page.", error);
		return offlineFallback(event.request);
	}
};

const networkFirstStrategy = async (request) => {
	try {
		const response = await fetch(request);
		await cacheRuntimeResponse(request, response);
		return response.clone();
	} catch (error) {
		log("Network-first fallback for", request.url, error);
		const cached = await caches.match(request);
		return cached || offlineFallback(request);
	}
};

const cacheFirstStrategy = async (request) => {
	const cached = await caches.match(request);
	if (cached) return cached;
	try {
		const response = await fetch(request);
		await cacheRuntimeResponse(request, response);
		return response.clone();
	} catch (error) {
		log("Cache-first fallback for", request.url, error);
		return offlineFallback(request);
	}
};

const staleWhileRevalidateStrategy = async (request) => {
	const cache = await caches.open(RUNTIME_CACHE);
	const cached = await cache.match(request);
	const networkPromise = fetch(request)
		.then(async (response) => {
			await cacheRuntimeResponse(request, response);
			return response.clone();
		})
		.catch((error) => {
			log("SWR network error for", request.url, error);
			return null;
		});

	if (cached) {
		networkPromise.catch(() => {});
		return cached;
	}

	const network = await networkPromise;
	return network || offlineFallback(request);
};

const cacheOnlyStrategy = async (request) => {
	const cached = await caches.match(request);
	if (cached) return cached;
	return offlineFallback(request);
};

const networkOnlyStrategy = async (request) => {
	try {
		return await fetch(request);
	} catch (error) {
		log("Network-only failed for", request.url, error);
		return offlineFallback(request);
	}
};

const STRATEGY_HANDLERS = {
	"network-first": networkFirstStrategy,
	"cache-first": cacheFirstStrategy,
	"stale-while-revalidate": staleWhileRevalidateStrategy,
	"cache-only": cacheOnlyStrategy,
	"network-only": networkOnlyStrategy,
};

const respondToMessage = async (event, data) => {
	const { type, payload } = data;
	const source = event.source;

	switch (type) {
		case "CLIENT_READY": {
			lifecycleState = lifecycleState || "activated";
			sendToClient(source, {
				type: "SW_STATE",
				payload: currentStatePayload(),
				message: `Service worker ready (state: ${lifecycleState}).`,
			});
			event.waitUntil(notifyStrategy(source));
			break;
		}
		case "REQUEST_STATE": {
			sendToClient(source, {
				type: "SW_STATE",
				payload: currentStatePayload(),
				message: `Service worker state: ${lifecycleState}.`,
			});
			event.waitUntil(notifyStrategy(source));
			break;
		}
		case "REQUEST_VERSION": {
			sendToClient(source, {
				type: "SW_VERSION",
				payload: { version: VERSION },
				message: `Service worker version: ${VERSION}.`,
			});
			break;
		}
		case "REQUEST_CACHE_KEYS": {
			const keys = await caches.keys();
			sendToClient(source, {
				type: "CACHE_KEYS",
				payload: keys,
				message: `Cache keys: ${keys.join(", ") || "none"}.`,
			});
			break;
		}
		case "CACHE_URLS": {
			const urls = payload?.urls || [];
			event.waitUntil(
				(async () => {
					const cache = await caches.open(RUNTIME_CACHE);
					const results = await Promise.allSettled(
						urls.map(async (url) => {
							const request = new Request(url, { mode: "no-cors" });
							await cache.add(request);
							return url;
						})
					);
					const successes = results.filter((result) => result.status === "fulfilled").length;
					const failures = results.length - successes;
					const message = `Cached ${successes} request(s)${
						failures ? ` (${failures} failed)` : ""
					}.`;
					await broadcast({ type: "CACHE_COMPLETED", payload: { successes, failures }, message });
					await broadcast({ type: "CACHE_KEYS", payload: await caches.keys() });
				})()
			);
			break;
		}
		case "CLEAR_CACHES": {
			event.waitUntil(
				(async () => {
					await cleanupOldCaches();
					await caches.delete(STATIC_CACHE);
					await caches.delete(RUNTIME_CACHE);
					await cacheCoreAssets();
					await broadcast({ type: "CACHE_KEYS", payload: await caches.keys(), message: "Caches cleared." });
				})()
			);
			break;
		}
		case "SKIP_WAITING": {
			event.waitUntil(
				(async () => {
					log("Skip waiting requested by client.");
					await self.skipWaiting();
					await broadcast({ type: "TOAST", message: "Activating update..." });
				})()
			);
			break;
		}
		case "QUEUE_SYNC": {
			const text = payload?.text || "Queued sync payload.";
			event.waitUntil(
				(async () => {
					if (!hasIndexedDB()) {
						await broadcast({ type: "LOG", message: "IndexedDB unavailable. Cannot queue sync payload." });
						return;
					}
					await addToOutbox({ text, queuedAt: Date.now() });
					if (self.registration.sync) {
						await self.registration.sync.register("outbox-sync");
						await broadcast({
							type: "LOG",
							message: "Background sync registered for outbox-sync.",
						});
					} else {
						await broadcast({ type: "LOG", message: "SyncManager unavailable; attempting immediate flush." });
						await flushOutbox();
					}
				})()
			);
			break;
		}
		case "PING": {
			sendToClient(source, { type: "PONG", message: "Service worker alive." });
			break;
		}
		case "SET_FETCH_STRATEGY": {
			const desired = (payload?.strategy || "").toLowerCase();
			if (!STRATEGY_VALUES.has(desired)) {
				sendToClient(source, {
					type: "TOAST",
					message: `Unknown strategy: ${desired || "(empty)"}.`,
				});
				break;
			}
			event.waitUntil(
				(async () => {
					if (runtimeStrategy === desired) {
						await notifyStrategy(source);
						return;
					}
					runtimeStrategy = desired;
					log("Runtime fetch strategy set to", runtimeStrategy);
					await notifyStrategy(null, `Fetch strategy set to ${runtimeStrategy}.`);
				})()
			);
			break;
		}
		default: {
			log("Unknown message from client", data);
			break;
		}
	}
};

const flushOutbox = async () => {
	if (!hasIndexedDB()) {
		await broadcast({ type: "LOG", message: "IndexedDB unavailable. Skipping outbox flush." });
		return;
	}
	const queued = await readOutbox();
	if (!queued.length) {
		await broadcast({ type: "LOG", message: "Outbox empty. Nothing to sync." });
		return;
	}

	let successCount = 0;
	for (const item of queued) {
		try {
			const response = await fetch("/api/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: item.payload.text, queuedAt: item.payload.queuedAt }),
			});
			if (!response.ok) throw new Error(`Server responded ${response.status}`);
			await removeFromOutbox(item.id);
			successCount += 1;
		} catch (error) {
			log("Failed to flush queued item", error);
			await broadcast({ type: "LOG", message: `Failed to flush queued message: ${error.message}` });
			return; // abort remaining so they retry next sync
		}
	}

	await broadcast({
		type: "OUTBOX_FLUSHED",
		payload: { count: successCount },
		message: `Flushed ${successCount} queued message(s).`,
	});
};

self.addEventListener("install", (event) => {
	log("Install event fired.");
	lifecycleState = "installing";
	event.waitUntil(
		(async () => {
			await cacheCoreAssets();
			await self.skipWaiting();
			await broadcast({ type: "LOG", message: "Core assets cached." });
			await notifyStrategy(null, `Fetch strategy set to ${runtimeStrategy}.`);
		})()
	);
});

self.addEventListener("activate", (event) => {
	log("Activate event fired.");
	lifecycleState = "activated";
	event.waitUntil(
		(async () => {
			await cleanupOldCaches();
			await maybeEnableNavigationPreload();
			await self.clients.claim();
			await broadcast({
				type: "SW_STATE",
				payload: currentStatePayload(),
				message: "Service worker activated.",
			});
			await notifyStrategy(null);
		})()
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	log("Fetch event:", request.url, "strategy:", runtimeStrategy);

	const url = new URL(request.url);
	if (request.mode === "navigate") {
		event.respondWith(handleNavigationRequest(event));
		return;
	}

	if (url.origin !== self.location.origin) {
		event.respondWith(fetch(request).catch(() => caches.match(request)));
		return;
	}

	const handler = STRATEGY_HANDLERS[runtimeStrategy] || networkFirstStrategy;
	event.respondWith(handler(request));
});

self.addEventListener("sync", (event) => {
	log("Sync event:", event.tag);
	event.waitUntil(
		(async () => {
			await broadcast({ type: "LOG", message: `Sync fired: ${event.tag}` });
			await flushOutbox();
		})()
	);
});

const parsePushData = (data) => {
	if (!data) return {};
	try {
		return data.json();
	} catch (error) {
		try {
			return { body: data.text() };
		} catch (_) {
			return { body: "Push received" };
		}
	}
};

self.addEventListener("push", (event) => {
	log("Push event received.");
	const payload = parsePushData(event.data);
	const title = payload.title || "Service Worker Tester";
	const body = payload.body || "Push message received.";

	event.waitUntil(
		(async () => {
			await broadcast({ type: "PUSH_PAYLOAD", payload: { body } });
			await self.registration.showNotification(title, {
				body,
				data: payload.data || {},
				requireInteraction: false,
			});
		})()
	);
});

self.addEventListener("pushsubscriptionchange", (event) => {
	log("Push subscription changed.");
	event.waitUntil(broadcast({ type: "LOG", message: "Push subscription changed. Resubscribe from the page." }));
});

self.addEventListener("notificationclick", (event) => {
	log("Notification click", event.notification.tag);
	event.notification.close();
	event.waitUntil(
		(async () => {
			const allClients = await self.clients.matchAll({ type: "window" });
			if (allClients.length) {
				allClients[0].focus();
			} else {
				await self.clients.openWindow("/");
			}
			await broadcast({ type: "LOG", message: "Notification click handled." });
		})()
	);
});

self.addEventListener("notificationclose", () => {
	log("Notification closed by user.");
});

self.addEventListener("message", (event) => {
	log("Message received from client", event.data);
	if (!event.data) return;
	event.waitUntil(respondToMessage(event, event.data));
});

const handleBackgroundFetchCompletion = async (event, outcome) => {
	const registration = event.registration;
	const records = await registration.matchAll();
	const cache = await caches.open(RUNTIME_CACHE);

	await Promise.all(
		records.map(async (record) => {
			const response = await record.responseReady;
			await cache.put(record.request, response.clone());
		})
	);

	await broadcast({
		type: "LOG",
		message: `Background fetch ${registration.id} ${outcome}. Cached ${records.length} request(s).`,
	});
};

self.addEventListener("backgroundfetchsuccess", (event) => {
	log("Background fetch success", event.registration.id);
	event.waitUntil(handleBackgroundFetchCompletion(event, "completed"));
});

self.addEventListener("backgroundfetchfail", (event) => {
	log("Background fetch failed", event.registration.id);
	event.waitUntil(broadcast({ type: "LOG", message: `Background fetch ${event.registration.id} failed.` }));
});

self.addEventListener("backgroundfetchabort", (event) => {
	log("Background fetch aborted", event.registration.id);
	event.waitUntil(broadcast({ type: "LOG", message: `Background fetch ${event.registration.id} aborted.` }));
});

self.addEventListener("periodicsync", (event) => {
	log("Periodic sync", event.tag);
	event.waitUntil(
		(async () => {
			await broadcast({ type: "LOG", message: `Periodic sync fired: ${event.tag}` });
			await flushOutbox();
		})()
	);
});
