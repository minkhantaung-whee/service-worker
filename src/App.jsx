import { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "./utils/toast";

const LOG_LIMIT = 200;
const STRATEGIES = [
  { value: "network-first", label: "Network first" },
  { value: "cache-first", label: "Cache first" },
  { value: "stale-while-revalidate", label: "Stale while revalidate" },
  { value: "cache-only", label: "Cache only" },
  { value: "network-only", label: "Network only" },
];

const timestamp = () => new Date().toLocaleTimeString();
const supportsBackgroundFetch = (registration) =>
  Boolean(registration && "backgroundFetch" in registration);

export default function App() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [registration, setRegistration] = useState(null);
  const [swState, setSwState] = useState("unknown");
  const [swVersion, setSwVersion] = useState("unknown");
  const [fetchStrategy, setFetchStrategy] = useState("network-first");
  const [cacheKeys, setCacheKeys] = useState([]);
  const [logEntries, setLogEntries] = useState([]);
  const [cacheUrl, setCacheUrl] = useState(() => window.location.origin);
  const [testFetchUrl, setTestFetchUrl] = useState("/manifest.json");
  const [pendingMessage, setPendingMessage] = useState(
    "Queued message from UI."
  );
  const [pushPayload, setPushPayload] = useState("Hello from the tester.");
  const [pushSubscription, setPushSubscription] = useState(null);
  const [backgroundFetchSupported, setBackgroundFetchSupported] =
    useState(false);

  const pushSupported = useMemo(() => "PushManager" in window, []);
  const syncSupported = useMemo(() => "SyncManager" in window, []);
  const notificationSupported = useMemo(() => "Notification" in window, []);

  const appendLog = useCallback((text, source = "app") => {
    if (!text) return;
    setLogEntries((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: timestamp(),
        source,
        text,
      };
      return [entry, ...prev].slice(0, LOG_LIMIT);
    });
    console.log(`[${source.toUpperCase()}]`, text);
  }, []);

  const sendToServiceWorker = useCallback(
    async (type, payload = {}) => {
      if (!("serviceWorker" in navigator)) {
        appendLog("Service worker API not available in this browser.", "error");
        showToast("Service workers are not supported here.");
        return;
      }

      try {
        const ready = await navigator.serviceWorker.ready;
        const target = navigator.serviceWorker.controller || ready.active;
        if (!target) {
          appendLog(`Skipped ${type}; no active worker yet.`, "warn");
          return;
        }
        target.postMessage({
          type,
          payload,
          from: "app",
          timestamp: Date.now(),
        });
        appendLog(`Sent ${type} to service worker.`, "app");
      } catch (error) {
        appendLog(`Message ${type} failed: ${error.message}`, "error");
      }
    },
    [appendLog]
  );

  const refreshCacheKeys = useCallback(async () => {
    if (!("caches" in window)) {
      appendLog("Cache API not available in this window.", "warn");
      return;
    }
    const keys = await caches.keys();
    setCacheKeys(keys);
    appendLog(`Cache keys: ${keys.join(", ") || "none"}.`, "app");
    sendToServiceWorker("REQUEST_CACHE_KEYS");
  }, [appendLog, sendToServiceWorker]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      appendLog("Service worker API not available.", "error");
      return undefined;
    }

    let active = true;

    navigator.serviceWorker.ready
      .then((readyReg) => {
        if (!active) return;
        setRegistration(readyReg);
        setSwState(readyReg.active?.state || "activated");
        setBackgroundFetchSupported(supportsBackgroundFetch(readyReg));
        appendLog("Service worker registration resolved.", "sw");
        refreshCacheKeys();
        sendToServiceWorker("CLIENT_READY");
        sendToServiceWorker("REQUEST_STATE");
        sendToServiceWorker("REQUEST_VERSION");
      })
      .catch((error) =>
        appendLog(
          `navigator.serviceWorker.ready rejected: ${error.message}`,
          "error"
        )
      );

    return () => {
      active = false;
    };
  }, [appendLog, refreshCacheKeys, sendToServiceWorker]);

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      appendLog("Browser reported online.", "app");
      showToast("Back online");
      sendToServiceWorker("PING");
    };
    const goOffline = () => {
      setIsOnline(false);
      appendLog("Browser reported offline.", "warn");
      showToast("You are offline");
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [appendLog, sendToServiceWorker]);

  useEffect(() => {
    if (!registration) return undefined;

    const trackWorker = (worker) => {
      if (!worker) return undefined;
      const handleState = () => {
        setSwState(worker.state);
        appendLog(`Service worker state changed to ${worker.state}.`, "sw");
      };
      handleState();
      worker.addEventListener("statechange", handleState);
      return () => worker.removeEventListener("statechange", handleState);
    };

    const cleanups = [
      trackWorker(registration.installing),
      trackWorker(registration.waiting),
      trackWorker(registration.active),
    ].filter(Boolean);
    const handleUpdateFound = () => {
      appendLog("Detected new service worker (updatefound).", "sw");
      const cleanup = trackWorker(registration.installing);
      if (cleanup) cleanups.push(cleanup);
    };
    registration.addEventListener("updatefound", handleUpdateFound);

    return () => {
      registration.removeEventListener("updatefound", handleUpdateFound);
      cleanups.forEach((fn) => fn());
    };
  }, [appendLog, registration]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;

    const handleMessage = (event) => {
      const data = event.data || {};
      const { type, message, payload } = data;
      if (message) appendLog(message, "sw");

      switch (type) {
        case "SW_STATE":
          if (payload?.state) setSwState(payload.state);
          if (payload?.version) setSwVersion(payload.version);
          if (payload?.strategy) setFetchStrategy(payload.strategy);
          break;
        case "SW_VERSION":
          if (payload?.version) setSwVersion(payload.version);
          break;
        case "FETCH_STRATEGY":
          if (payload?.strategy) setFetchStrategy(payload.strategy);
          break;
        case "CACHE_KEYS":
          if (Array.isArray(payload)) setCacheKeys(payload);
          break;
        case "CACHE_COMPLETED":
          showToast(payload?.message || "Caching complete");
          break;
        case "OUTBOX_FLUSHED":
          if (payload?.message) showToast(payload.message);
          break;
        case "PUSH_PAYLOAD":
          if (payload?.body) showToast(payload.body, { duration: 5000 });
          break;
        case "LOG":
          if (message) appendLog(message, "sw");
          break;
        case "TOAST":
          if (message) showToast(message, payload);
          break;
        default:
          break;
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [appendLog]);

  useEffect(() => {
    if (!registration || !pushSupported) return undefined;

    registration.pushManager
      .getSubscription()
      .then((existing) => {
        if (existing) {
          setPushSubscription(existing);
          appendLog("Restored existing push subscription.", "app");
        }
      })
      .catch((error) =>
        appendLog(`Reading push subscription failed: ${error.message}`, "warn")
      );

    return undefined;
  }, [appendLog, pushSupported, registration]);

  const requestNotificationPermission = async () => {
    if (!notificationSupported) {
      showToast("Notifications are not supported here.");
      return;
    }
    const result = await Notification.requestPermission();
    appendLog(`Notification permission: ${result}`, "app");
    showToast(`Notification permission: ${result}`);
  };

  const fetchVapidKey = async () => {
    const response = await fetch("/vapid-public-key");
    if (!response.ok) {
      throw new Error(`Failed to fetch VAPID key (${response.status})`);
    }
    return response.text();
  };

  const urlBase64ToUint8Array = (base64String) => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const raw = window.atob(base64);
    const result = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      result[i] = raw.charCodeAt(i);
    }
    return result;
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
      const vapidKey = await fetchVapidKey();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      await fetch("/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });

      setPushSubscription(subscription);
      appendLog("Push subscription stored on server.", "app");
      showToast("Subscribed for push notifications.");
    } catch (error) {
      appendLog(`Push subscription failed: ${error.message}`, "error");
      showToast("Failed to subscribe for push. See console.");
    }
  };

  const triggerPush = async () => {
    if (!pushSubscription) {
      showToast("Subscribe for push before sending a message.");
      return;
    }

    try {
      const response = await fetch("/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: pushPayload }),
      });
      if (!response.ok) {
        throw new Error(`Push send failed (${response.status})`);
      }
      appendLog("Push notification request sent to server.", "app");
      showToast("Push notification queued.");
    } catch (error) {
      appendLog(`Push send failed: ${error.message}`, "error");
      showToast("Failed to send push message.");
    }
  };

  const cacheProvidedUrl = async () => {
    const url = cacheUrl.trim();
    if (!url) {
      showToast("Enter a URL to cache.");
      return;
    }
    sendToServiceWorker("CACHE_URLS", { urls: [url] });
    refreshCacheKeys();
  };

  const clearAllCaches = async () => {
    sendToServiceWorker("CLEAR_CACHES");
    setCacheKeys([]);
  };

  const queueSyncRequest = async () => {
    if (!syncSupported) {
      showToast("Background Sync is not available in this browser.");
      return;
    }
    const text = pendingMessage.trim() || `Queued at ${timestamp()}`;
    sendToServiceWorker("QUEUE_SYNC", { text });
    showToast("Background sync queued.");
    setPendingMessage("");
  };

  const manualFetch = async () => {
    const url = testFetchUrl.trim();
    if (!url) {
      showToast("Enter a URL to fetch.");
      return;
    }
    try {
      const response = await fetch(url, { cache: "no-store" });
      appendLog(
        `Manual fetch ${response.ok ? "succeeded" : "failed"} (${
          response.status
        }) for ${url}.`,
        "app"
      );
      showToast(`Fetch complete (${response.status}).`);
    } catch (error) {
      appendLog(`Manual fetch error: ${error.message}`, "error");
      showToast("Manual fetch failed.");
    }
  };

  const startBackgroundFetch = async () => {
    if (!registration) {
      showToast("Service worker registration not ready yet.");
      return;
    }
    if (!backgroundFetchSupported) {
      showToast("Background Fetch is not supported here.");
      return;
    }
    const id = `bg-fetch-${Date.now()}`;
    const url = (testFetchUrl || "/").trim();
    try {
      await registration.backgroundFetch.fetch(id, [url], {
        title: "Background fetch demo",
      });
      appendLog(`Background fetch ${id} started for ${url}.`, "app");
      showToast("Background fetch started.");
    } catch (error) {
      appendLog(`Background fetch failed: ${error.message}`, "error");
      showToast("Could not start background fetch.");
    }
  };

  const requestSkipWaiting = async () => {
    sendToServiceWorker("SKIP_WAITING");
  };

  const checkForUpdate = async () => {
    if (!registration) {
      showToast("Service worker registration not ready yet.");
      return;
    }
    appendLog("Checking for a new service worker...");
    await registration.update();
  };

  const unregisterAll = async () => {
    if (!("serviceWorker" in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.unregister()));
    appendLog("All service workers unregistered by request.", "warn");
    showToast("Service worker unregistered. Reload to detach.");
    setSwState("unregistered");
  };

  const handleStrategyChange = (event) => {
    const value = event.target.value;
    setFetchStrategy(value);
    sendToServiceWorker("SET_FETCH_STRATEGY", { strategy: value });
  };

  const clearLog = () => setLogEntries([]);

  const statusRows = [
    ["Online", isOnline ? "Yes" : "No"],
    ["SW state", swState],
    ["SW version", swVersion],
    ["Fetch strategy", fetchStrategy],
    ["Background sync", syncSupported ? "Available" : "Not available"],
    [
      "Background fetch",
      backgroundFetchSupported ? "Available" : "Not available",
    ],
    ["Push", pushSupported ? "Available" : "Not available"],
  ];

  const logOutput = logEntries
    .map(
      (entry) => `${entry.time} [${entry.source.toUpperCase()}] ${entry.text}`
    )
    .join("\n");

  return (
    <main className="app">
      <div>
        <h1>Service Worker Test Bench</h1>
        <p className="lede">
          Simple controls to trigger fetch, cache, sync, and push events while
          you watch the service worker lifecycle.
        </p>
      </div>

      <section className="section">
        <h2>Status</h2>
        <table className="status-table">
          <tbody>
            {statusRows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="button-group">
          <button
            type="button"
            onClick={() => sendToServiceWorker("REQUEST_STATE")}
          >
            Lifecycle Snapshot
          </button>
          <button type="button" onClick={() => sendToServiceWorker("PING")}>
            Ping Worker
          </button>
          <button type="button" onClick={checkForUpdate}>
            Check For Update
          </button>
          <button type="button" onClick={requestSkipWaiting}>
            Skip Waiting
          </button>
          <button type="button" onClick={unregisterAll}>
            Unregister
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Fetch Strategy</h2>
        <div className="strategy-list">
          {STRATEGIES.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="fetch-strategy"
                value={option.value}
                checked={fetchStrategy === option.value}
                onChange={handleStrategyChange}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <div className="input-row">
          <label className="labeled-input">
            <span>Test URL</span>
            <input
              value={testFetchUrl}
              onChange={(event) => setTestFetchUrl(event.target.value)}
              placeholder="/manifest.json"
            />
          </label>
          <button type="button" onClick={manualFetch}>
            Fetch Now
          </button>
          <button
            type="button"
            onClick={startBackgroundFetch}
            disabled={!backgroundFetchSupported}
          >
            Background Fetch
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Cache Control</h2>
        <div className="input-row">
          <label className="labeled-input">
            <span>URL to cache</span>
            <input
              value={cacheUrl}
              onChange={(event) => setCacheUrl(event.target.value)}
              placeholder="https://example.com/asset.jpg"
            />
          </label>
          <button type="button" onClick={cacheProvidedUrl}>
            Cache URL
          </button>
          <button type="button" onClick={refreshCacheKeys}>
            Refresh List
          </button>
          <button type="button" onClick={clearAllCaches}>
            Clear Caches
          </button>
        </div>
        <div className="cache-keys">
          {cacheKeys.length === 0 ? (
            <span>No cache entries found.</span>
          ) : (
            cacheKeys.map((key) => <span key={key}>{key}</span>)
          )}
        </div>
      </section>

      <section className="section">
        <h2>Background Sync</h2>
        <textarea
          value={pendingMessage}
          onChange={(event) => setPendingMessage(event.target.value)}
          aria-label="Background sync payload"
        />
        <div className="button-group">
          <button
            type="button"
            onClick={queueSyncRequest}
            disabled={!syncSupported}
          >
            Queue Background Sync
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Push Notifications</h2>
        <div className="button-group">
          <button
            type="button"
            onClick={requestNotificationPermission}
            disabled={!notificationSupported}
          >
            Request Permission
          </button>
          <button
            type="button"
            onClick={subscribeToPush}
            disabled={!pushSupported}
          >
            Subscribe
          </button>
          <button
            type="button"
            onClick={triggerPush}
            disabled={!pushSubscription}
          >
            Send Push
          </button>
        </div>
        <label className="labeled-input">
          <span>Push message</span>
          <input
            value={pushPayload}
            onChange={(event) => setPushPayload(event.target.value)}
          />
        </label>
        <textarea
          readOnly
          value={
            pushSubscription
              ? JSON.stringify(pushSubscription.toJSON(), null, 2)
              : "No subscription"
          }
          aria-label="Push subscription"
          className="subscription-box"
        />
      </section>

      <section className="section">
        <div className="log-header">
          <h2>Event Log</h2>
          <button type="button" onClick={clearLog}>
            Clear Log
          </button>
        </div>
        <pre className="log-output">
          {logOutput || "Interact with the controls to see events here."}
        </pre>
      </section>
    </main>
  );
}
