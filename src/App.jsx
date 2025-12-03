import React, { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "./utils/toast";

const LOG_LIMIT = 250;
const fallbackBgFetchUrl = "/manifest.json";

const featureCheck = {
  sync: () => "SyncManager" in window,
  push: () => "PushManager" in window,
  notifications: () => "Notification" in window,
};

const baseTime = () => new Date().toLocaleTimeString();

const badgeVariant = {
  ok: "status-badge status-badge--ok",
  warn: "status-badge status-badge--warn",
  off: "status-badge status-badge--off",
};

const backgroundFetchSupportedIn = (registration) =>
  Boolean(registration && "backgroundFetch" in registration);

export default function App() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [registration, setRegistration] = useState(null);
  const [swState, setSwState] = useState("registering");
  const [cacheKeys, setCacheKeys] = useState([]);
  const [logEntries, setLogEntries] = useState([]);
  const [pendingMessage, setPendingMessage] = useState(
    "This message will sync when online."
  );
  const [bgFetchUrl, setBgFetchUrl] = useState(fallbackBgFetchUrl);
  const [cacheUrl, setCacheUrl] = useState(() => window.location.origin);
  const [pushSubscription, setPushSubscription] = useState(null);
  const [pushPayload, setPushPayload] = useState("Hello from the foreground!");
  const [backgroundFetchSupported, setBackgroundFetchSupported] =
    useState(false);

  const pushSupported = useMemo(() => featureCheck.push(), []);
  const syncSupported = useMemo(() => featureCheck.sync(), []);
  const notificationSupported = useMemo(() => featureCheck.notifications(), []);

  const appendLog = useCallback((text, source = "app") => {
    if (!text) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      time: baseTime(),
      source,
      text,
    };
    setLogEntries((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
    console.log(`[${source.toUpperCase()}]`, text);
  }, []);

  const sendToServiceWorker = useCallback(
    async (type, payload = {}) => {
      if (!("serviceWorker" in navigator)) {
        showToast("Service workers are not supported in this browser.");
        return;
      }

      try {
        const readyReg = await navigator.serviceWorker.ready;
        const target = navigator.serviceWorker.controller || readyReg.active;
        if (!target) {
          showToast("Service worker is not active yet. Try again shortly.");
          appendLog(`Skipped sending ${type}; no active worker.`, "app");
          return;
        }

        target.postMessage({
          type,
          payload,
          from: "app",
          timestamp: Date.now(),
        });
        appendLog(`Sent ${type} message to service worker.`, "app");
      } catch (error) {
        appendLog(`Failed to reach service worker: ${error.message}`, "error");
        showToast(
          "Could not communicate with the service worker. See console for details."
        );
      }
    },
    [appendLog]
  );

  const refreshCacheKeys = useCallback(async () => {
    if (!("caches" in window)) {
      appendLog("Cache API not available in this environment.", "warn");
      return;
    }
    const keys = await caches.keys();
    setCacheKeys(keys);
    appendLog(`Found ${keys.length} caches via window.caches.`, "app");
    sendToServiceWorker("REQUEST_CACHE_KEYS");
  }, [appendLog, sendToServiceWorker]);

  const makeBackgroundFetchCheck = useCallback(
    (reg) => setBackgroundFetchSupported(backgroundFetchSupportedIn(reg)),
    []
  );

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      appendLog("Service worker not supported.", "error");
      return () => {};
    }

    let mounted = true;

    navigator.serviceWorker.ready
      .then((readyReg) => {
        if (!mounted) return;
        setRegistration(readyReg);
        setSwState(readyReg.active?.state || "activated");
        makeBackgroundFetchCheck(readyReg);
        refreshCacheKeys();
        sendToServiceWorker("PING");
      })
      .catch((error) =>
        appendLog(`SW ready promise rejected: ${error.message}`, "error")
      );

    return () => {
      mounted = false;
    };
  }, [
    appendLog,
    makeBackgroundFetchCheck,
    refreshCacheKeys,
    sendToServiceWorker,
  ]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      showToast("You are back online.");
      appendLog("Browser reported online.", "app");
      sendToServiceWorker("PING");
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast("You are offline. Cached resources only.");
      appendLog("Browser reported offline.", "warn");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [appendLog, sendToServiceWorker]);

  useEffect(() => {
    if (!registration || !pushSupported) return;

    registration.pushManager
      .getSubscription()
      .then((existing) => {
        if (existing) {
          setPushSubscription(existing);
          appendLog("Restored existing push subscription.", "app");
        }
      })
      .catch((error) =>
        appendLog(`Failed to read push subscription: ${error.message}`, "warn")
      );
  }, [appendLog, pushSupported, registration]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return () => {};

    const handleMessage = (event) => {
      const data = event.data || {};
      const { type, message, payload } = data;
      if (message) appendLog(message, "sw");

      if (type === "CACHE_KEYS") {
        setCacheKeys(payload || []);
      }

      if (type === "SW_STATE" && payload?.state) {
        setSwState(payload.state);
      }

      if (type === "PUSH_PAYLOAD" && payload?.body) {
        showToast(payload.body, { duration: 5000 });
      }

      if (type === "OUTBOX_FLUSHED" && payload?.message) {
        showToast(payload.message);
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);

    return () =>
      navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [appendLog]);

  const requestNotificationPermission = async () => {
    if (!notificationSupported) {
      showToast("Notifications are not supported here.");
      return;
    }

    const result = await Notification.requestPermission();
    appendLog(`Notification permission result: ${result}`, "app");
    showToast(`Notification permission: ${result}`);
  };

  const fetchVapidKey = async () => {
    const response = await fetch("/vapid-public-key");
    if (!response.ok)
      throw new Error(`Failed to fetch VAPID key (${response.status})`);
    return response.text();
  };

  const urlBase64ToUint8Array = (base64String) => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  const subscribeToPush = async () => {
    if (!pushSupported) {
      showToast("Push is not supported in this browser.");
      return;
    }
    if (!registration) {
      showToast("Service worker registration not ready yet.");
      return;
    }

    try {
      const key = await fetchVapidKey();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });

      await fetch("/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });

      setPushSubscription(subscription);
      appendLog("Push subscription stored on server.", "app");
      showToast("Push subscription created.");
    } catch (error) {
      appendLog(`Push subscription failed: ${error.message}`, "error");
      showToast("Failed to subscribe for push. Check console.");
    }
  };

  const triggerPush = async () => {
    if (!pushSubscription) {
      showToast("Subscribe to push first.");
      return;
    }

    try {
      const response = await fetch("/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: pushPayload }),
      });
      if (!response.ok)
        throw new Error(`Push send failed (${response.status})`);
      appendLog("Push notification triggered from server.", "app");
      showToast("Push notification sent.");
    } catch (error) {
      appendLog(`Push send failed: ${error.message}`, "error");
      showToast("Failed to send push.");
    }
  };

  const cacheProvidedUrl = async () => {
    const url = cacheUrl.trim();
    if (!url) {
      showToast("Provide a URL to cache.");
      return;
    }
    await sendToServiceWorker("CACHE_URLS", { urls: [url] });
    refreshCacheKeys();
  };

  const clearAllCaches = async () => {
    await sendToServiceWorker("CLEAR_CACHES");
    refreshCacheKeys();
  };

  const queueSyncRequest = async () => {
    if (!syncSupported) {
      showToast("Background Sync not supported.");
      return;
    }

    const text = pendingMessage.trim();
    await sendToServiceWorker("QUEUE_SYNC", {
      text: text || `Queued from UI at ${baseTime()}`,
    });
    showToast("Sync queued. It will flush when connectivity returns.");
    setPendingMessage("");
  };

  const startBackgroundFetch = async () => {
    if (!registration) {
      showToast("Service worker registration not ready yet.");
      return;
    }
    if (!backgroundFetchSupported) {
      showToast("Background Fetch not supported in this browser.");
      return;
    }

    const id = `bg-fetch-${Date.now()}`;
    const url = (bgFetchUrl || fallbackBgFetchUrl).trim();

    try {
      await registration.backgroundFetch.fetch(id, [url], {
        title: "Background Fetch Demo",
        icons: [
          {
            src: "/vite.svg",
            sizes: "144x144",
            type: "image/svg+xml",
          },
        ],
        downloadTotal: 0,
      });
      appendLog(`Background fetch "${id}" started for ${url}.`, "app");
      showToast("Background fetch started.");
    } catch (error) {
      appendLog(`Background fetch failed: ${error.message}`, "error");
      showToast("Unable to start background fetch.");
    }
  };

  const requestSkipWaiting = async () => {
    await sendToServiceWorker("SKIP_WAITING");
  };

  const checkForUpdate = async () => {
    if (!registration) {
      showToast("No registration yet.");
      return;
    }
    appendLog("Checking for an updated service worker...", "app");
    await registration.update();
  };

  const unregisterAll = async () => {
    if (!("serviceWorker" in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.unregister()));
    appendLog("All service workers unregistered by user.", "warn");
    showToast("Service worker unregistered. Reload to remove control.");
    setSwState("unregistered");
  };

  const clearLog = () => setLogEntries([]);

  const statusBadges = [
    {
      label: "Online",
      value: isOnline ? "Online" : "Offline",
      className: isOnline ? badgeVariant.ok : badgeVariant.warn,
    },
    {
      label: "Service Worker",
      value: swState,
      className:
        swState === "activated"
          ? badgeVariant.ok
          : swState === "waiting"
          ? badgeVariant.warn
          : badgeVariant.off,
    },
    {
      label: "Background Sync",
      value: syncSupported ? "Supported" : "Missing",
      className: syncSupported ? badgeVariant.ok : badgeVariant.off,
    },
    {
      label: "Background Fetch",
      value: backgroundFetchSupported ? "Supported" : "Missing",
      className: backgroundFetchSupported ? badgeVariant.ok : badgeVariant.off,
    },
    {
      label: "Push",
      value: pushSupported ? "Supported" : "Missing",
      className: pushSupported ? badgeVariant.ok : badgeVariant.off,
    },
  ];

  return (
    <main className="app-shell">
      <header className="card app-header">
        <h1>Service Worker Tester</h1>
        <p>
          Inspect and exercise lifecycle, caching, sync, push, and background
          fetch events. Check the event log and your browser console for
          detailed traces.
        </p>
      </header>

      <section className="card">
        <h2>Status</h2>
        <div className="status-grid">
          {statusBadges.map(({ label, value, className }) => (
            <div key={label} className="status-chip">
              <span className="status-label">{label}</span>
              <span className={className}>{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Service Worker Controls</h2>
        <div className="button-grid">
          <button type="button" onClick={checkForUpdate}>
            Check for Update
          </button>
          <button type="button" onClick={requestSkipWaiting}>
            Skip Waiting & Activate
          </button>
          <button type="button" onClick={refreshCacheKeys}>
            Refresh Cache List
          </button>
          <button type="button" onClick={clearAllCaches}>
            Clear All Caches
          </button>
          <button type="button" onClick={unregisterAll}>
            Unregister Worker
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Caching Playground</h2>
        <div className="control-row">
          <input
            value={cacheUrl}
            onChange={(event) => setCacheUrl(event.target.value)}
            placeholder="https://example.com/asset.jpg"
            aria-label="URL to cache"
          />
          <button type="button" onClick={cacheProvidedUrl}>
            Cache URL via SW
          </button>
        </div>
        <div className="cache-list">
          {cacheKeys.length === 0 ? (
            <span className="empty-state">No caches detected yet.</span>
          ) : (
            cacheKeys.map((key) => (
              <span key={key} className="cache-pill">
                {key}
              </span>
            ))
          )}
        </div>
      </section>

      <section className="card card-grid">
        <div>
          <h2>Background Sync</h2>
          <p className="section-hint">
            Queue a message. The service worker stores it and flushes the queue
            during the next
            <code>sync</code> event.
          </p>
          <textarea
            value={pendingMessage}
            onChange={(event) => setPendingMessage(event.target.value)}
            placeholder="Type a message to send once connectivity resumes"
            rows={3}
          />
          <div className="button-grid">
            <button
              type="button"
              disabled={!syncSupported}
              onClick={queueSyncRequest}
            >
              Queue Background Sync
            </button>
          </div>
        </div>

        <div>
          <h2>Background Fetch</h2>
          <p className="section-hint">
            Requires Chromium-based browsers with Background Fetch enabled.
            Fetched assets are cached when the event succeeds.
          </p>
          <input
            value={bgFetchUrl}
            onChange={(event) => setBgFetchUrl(event.target.value)}
            placeholder="/manifest.json"
            aria-label="Background fetch URL"
          />
          <div className="button-grid">
            <button
              type="button"
              disabled={!backgroundFetchSupported}
              onClick={startBackgroundFetch}
            >
              Start Background Fetch
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Push Notifications</h2>
        <p className="section-hint">
          The Node server at <code>localhost:3001</code> delivers push messages
          using your active subscription.
        </p>
        <div className="button-grid">
          <button type="button" onClick={requestNotificationPermission}>
            Request Notification Permission
          </button>
          <button
            type="button"
            onClick={subscribeToPush}
            disabled={!pushSupported}
          >
            Subscribe to Push
          </button>
        </div>
        <div className="control-row">
          <input
            value={pushPayload}
            onChange={(event) => setPushPayload(event.target.value)}
            placeholder="Push notification payload"
            aria-label="Push message"
          />
          <button
            type="button"
            onClick={triggerPush}
            disabled={!pushSubscription}
          >
            Send Test Push
          </button>
        </div>
        {pushSubscription ? (
          <pre
            className="subscription-preview"
            aria-label="Push subscription JSON"
          >
            {JSON.stringify(pushSubscription.toJSON(), null, 2)}
          </pre>
        ) : (
          <span className="empty-state">
            No push subscription registered yet.
          </span>
        )}
      </section>

      <section className="card log-card">
        <header className="log-header">
          <h2>Event Log</h2>
          <button type="button" onClick={clearLog}>
            Clear Log
          </button>
        </header>
        <div className="log-list">
          {logEntries.length === 0 ? (
            <span className="empty-state">
              Interact with the app to populate the log.
            </span>
          ) : (
            logEntries.map((entry) => (
              <div key={entry.id} className="log-row">
                <span className="log-time">{entry.time}</span>
                <span className="log-source">{entry.source}</span>
                <span className="log-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <footer className="footer-note">
        <small>
          Tip: open DevTools → Application to inspect Cache Storage, Background
          Sync, Push, Notifications, and Service Workers while using this
          dashboard.
        </small>
      </footer>
    </main>
  );
}
