import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const PRODUCTS_URL = "https://fakestoreapi.com/products?limit=8";
const CHECKOUT_ENDPOINT = "https://fakestoreapi.com/carts";
const CHECKOUT_SYNC_TAG = "mock-market-checkout-sync";

const CACHE_STRATEGIES = [
  { value: "stale-while-revalidate", label: "Stale-While-Revalidate" },
  { value: "cache-first", label: "Cache First" },
  { value: "network-first", label: "Network First" },
  { value: "cache-only", label: "Cache Only" },
  { value: "network-only", label: "Network Only" },
];

const getStrategyLabel = (value) =>
  CACHE_STRATEGIES.find((entry) => entry.value === value)?.label || value;

function describeCatalogStatus(meta, fallbackStrategy) {
  const strategy = meta?.strategy || fallbackStrategy;
  const strategyLabel = getStrategyLabel(strategy);
  let message = "Catalog updated.";
  let tone = "info";

  const timeValue = meta?.timestamp ? new Date(meta.timestamp) : null;
  const timeSuffix =
    timeValue && !Number.isNaN(timeValue.getTime())
      ? ` at ${timeValue.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : "";

  switch (meta?.source) {
    case "cache":
      if (meta?.reason === "offline-fallback") {
        message = `Products served from cache while offline${timeSuffix}.`;
        tone = "warning";
      } else if (strategy === "stale-while-revalidate") {
        message = `Products served from cache while refreshing (${strategyLabel})${timeSuffix}.`;
        tone = "info";
      } else {
        message = `Products loaded from cache (${strategyLabel})${timeSuffix}.`;
      }
      break;
    case "network":
      message = `Products loaded from network (${strategyLabel})${timeSuffix}.`;
      tone = "success";
      break;
    case "network-refresh":
      message = `Products refreshed from network (${strategyLabel})${timeSuffix}.`;
      tone = "success";
      break;
    case "background-fetch":
      message = `Background fetch delivered new products${timeSuffix}.`;
      tone = "success";
      break;
    case "prefetch":
      message = `Products prefetched and cached (${strategyLabel})${timeSuffix}.`;
      tone = "info";
      break;
    case "fallback":
      message = `Offline fallback catalog in use${timeSuffix}.`;
      tone = "warning";
      break;
    default:
      message = `Catalog updated (${strategyLabel})${timeSuffix}.`;
      tone = "info";
      break;
  }

  return { message, tone };
}

function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [toasts, setToasts] = useState([]);
  const [cacheStrategy, setCacheStrategy] = useState("stale-while-revalidate");
  const [catalogStatus, setCatalogStatus] = useState({
    message: "",
    tone: "info",
  });
  const [checkoutStatus, setCheckoutStatus] = useState({
    message: "",
    tone: "info",
  });
  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const [isSyncSupported, setIsSyncSupported] = useState(false);
  const [isBackgroundFetchSupported, setIsBackgroundFetchSupported] =
    useState(false);
  const [lastSync, setLastSync] = useState("");
  const [backgroundFetchStatus, setBackgroundFetchStatus] = useState("");
  const hasProductsRef = useRef(false);
  const pendingOrderRef = useRef(null);
  const backgroundFetchTimeoutRef = useRef();

  const formatter = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      }),
    []
  );

  const addToast = useCallback((message, level = "info") => {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, message, level }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  const submitCheckoutOnline = useCallback(async (order) => {
    const payload = {
      userId: 1,
      date: new Date().toISOString().split("T")[0],
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
      throw new Error(`Checkout failed with status ${response.status}`);
    }

    return response.json();
  }, []);

  const fetchProducts = useCallback(
    async ({ silent } = { silent: false }) => {
      if (!silent) {
        setLoading(true);
        setError("");
        setCatalogStatus({
          message: `Refreshing products (${getStrategyLabel(cacheStrategy)})…`,
          tone: "info",
        });
      }

      try {
        const response = await fetch(PRODUCTS_URL);
        if (!response.ok) {
          throw new Error(`Unexpected status ${response.status}`);
        }

        const data = await response.json();
        setProducts(data);
        hasProductsRef.current = data.length > 0;
        setError("");
      } catch (err) {
        if (!hasProductsRef.current) {
          setError(
            "We could not load products. Try again when you are back online."
          );
        }

        if (!silent) {
          setCatalogStatus({
            message:
              "Unable to reach network. Falling back to cached catalog if available.",
            tone: "warning",
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [cacheStrategy]
  );

  const postMessageToServiceWorker = useCallback(async (type, payload) => {
    if (!navigator.serviceWorker) {
      throw new Error("Service worker is not available in this browser.");
    }

    const registration = await navigator.serviceWorker.ready;
    const message = { type, payload };

    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(message);
      return;
    }

    if (registration.active) {
      registration.active.postMessage(message);
      return;
    }

    throw new Error("No active service worker to receive the message.");
  }, []);

  const checkoutCart = useCallback(async () => {
    const items = Object.values(cart);
    if (!items.length) {
      setCheckoutStatus({
        message: "Your cart is empty.",
        tone: "warning",
      });
      return;
    }

    const order = {
      id: `order-${Date.now()}`,
      createdAt: new Date().toISOString(),
      items: items.map(({ product, quantity }) => ({
        productId: product.id,
        title: product.title,
        price: product.price,
        quantity,
      })),
      total: items.reduce(
        (acc, { product, quantity }) => acc + product.price * quantity,
        0
      ),
    };

    pendingOrderRef.current = order.id;
    setIsCheckoutProcessing(true);
    setCheckoutStatus({
      message: "Submitting order…",
      tone: "info",
    });

    if (!navigator.serviceWorker) {
      try {
        await submitCheckoutOnline(order);
        setCart({});
        setCheckoutStatus({
          message: "Checkout completed successfully.",
          tone: "success",
        });
      } catch (error) {
        setCheckoutStatus({
          message: error.message,
          tone: "error",
        });
        addToast(error.message, "error");
      } finally {
        pendingOrderRef.current = null;
        setIsCheckoutProcessing(false);
      }
      return;
    }

    try {
      await postMessageToServiceWorker("CHECKOUT_SUBMIT", { order });
      setCheckoutStatus({
        message: "Checkout handed to service worker for processing.",
        tone: "info",
      });
    } catch (error) {
      pendingOrderRef.current = null;
      try {
        await submitCheckoutOnline(order);
        setCart({});
        setCheckoutStatus({
          message: "Checkout completed successfully.",
          tone: "success",
        });
      } catch (fallbackError) {
        setCheckoutStatus({
          message: fallbackError.message,
          tone: "error",
        });
        addToast(fallbackError.message, "error");
      } finally {
        setIsCheckoutProcessing(false);
      }
    }
  }, [addToast, cart, postMessageToServiceWorker, submitCheckoutOnline]);

  const registerCheckoutSync = useCallback(async () => {
    if (!navigator.serviceWorker) {
      addToast("Service worker unavailable for background sync.", "error");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration.sync) {
        await registration.sync.register(CHECKOUT_SYNC_TAG);
        addToast("Background sync registered.", "success");
      } else {
        await postMessageToServiceWorker("PROCESS_CHECKOUT_QUEUE");
        addToast("Sync API unsupported. Processing queue now.", "warning");
      }
    } catch (error) {
      addToast(`Failed to register sync: ${error.message}`, "error");
    }
  }, [addToast, postMessageToServiceWorker]);

  const processCheckoutQueue = useCallback(async () => {
    try {
      await postMessageToServiceWorker("PROCESS_CHECKOUT_QUEUE");
      addToast("Triggered checkout queue processing.", "info");
    } catch (error) {
      addToast(error.message, "error");
    }
  }, [addToast, postMessageToServiceWorker]);

  const handleStrategyChange = useCallback(
    async (event) => {
      const { value } = event.target;
      const previous = cacheStrategy;
      setCacheStrategy(value);
      try {
        await postMessageToServiceWorker("SET_CACHE_STRATEGY", {
          strategy: value,
        });
      } catch (error) {
        setCacheStrategy(previous);
        addToast(error.message, "error");
      }
    },
    [addToast, cacheStrategy, postMessageToServiceWorker]
  );

  const startBackgroundFetch = useCallback(async () => {
    if (!navigator.serviceWorker) {
      addToast("Service worker unavailable for background fetch.", "error");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      if (registration.backgroundFetch) {
        const fetchId = `products-refresh-${Date.now()}`;
        await registration.backgroundFetch.fetch(fetchId, [PRODUCTS_URL], {
          title: "Mock Market catalog refresh",
          downloadTotal: 1024,
        });
        setBackgroundFetchStatus("Background fetch started.");
        setCatalogStatus({
          message:
            "Background fetch queued. The catalog will refresh when complete.",
          tone: "info",
        });
        addToast("Background fetch started.", "info");
      } else {
        await postMessageToServiceWorker("PREFETCH_PRODUCTS", {
          url: PRODUCTS_URL,
        });
        setBackgroundFetchStatus(
          "Prefetching products through service worker."
        );
        setCatalogStatus({
          message: "Prefetch started via service worker.",
          tone: "info",
        });
        addToast(
          "Background fetch not supported. Prefetched instead.",
          "warning"
        );
      }
    } catch (error) {
      addToast(`Background fetch failed: ${error.message}`, "error");
    }
  }, [addToast, postMessageToServiceWorker]);

  useEffect(() => {
    fetchProducts({ silent: true });
  }, [fetchProducts]);

  useEffect(() => {
    const updateStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateStatus);
    window.addEventListener("offline", updateStatus);
    return () => {
      window.removeEventListener("online", updateStatus);
      window.removeEventListener("offline", updateStatus);
    };
  }, []);

  useEffect(() => {
    if (!navigator.serviceWorker) {
      return;
    }

    let isMounted = true;
    navigator.serviceWorker.ready
      .then((registration) => {
        if (!isMounted) {
          return;
        }
        setIsSyncSupported(Boolean(registration.sync));
        setIsBackgroundFetchSupported(Boolean(registration.backgroundFetch));
      })
      .catch(() => {
        setIsSyncSupported(false);
        setIsBackgroundFetchSupported(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!navigator.serviceWorker) {
      return;
    }

    const handleMessage = (event) => {
      const { type, payload } = event.data || {};

      if (type === "SW_TOAST" && payload?.message) {
        addToast(payload.message, payload.level);
      }

      if (type === "SW_PRODUCTS" && Array.isArray(payload?.items)) {
        setProducts(payload.items);
        hasProductsRef.current = payload.items.length > 0;
        if (payload.meta) {
          setCatalogStatus(describeCatalogStatus(payload.meta, cacheStrategy));
        } else {
          setCatalogStatus({
            message: `Catalog updated (${getStrategyLabel(cacheStrategy)}).`,
            tone: "info",
          });
        }
      }

      if (type === "SW_CHECKOUT_ACCEPTED") {
        setCart({});
        pendingOrderRef.current = null;
        setIsCheckoutProcessing(false);
        setCheckoutStatus({
          message: payload?.message || "Checkout completed successfully.",
          tone: payload?.level === "warning" ? "warning" : "success",
        });
      }

      if (type === "SW_CHECKOUT_FAILED") {
        pendingOrderRef.current = null;
        setIsCheckoutProcessing(false);
        if (payload?.message) {
          setCheckoutStatus({ message: payload.message, tone: "error" });
          addToast(payload.message, "error");
        } else {
          setCheckoutStatus({
            message: "Checkout failed.",
            tone: "error",
          });
        }
      }

      if (type === "SW_SYNC_COMPLETED") {
        setLastSync(payload?.completedAt || new Date().toISOString());
        if (payload?.message) {
          setCheckoutStatus({
            message: payload.message,
            tone: payload.level === "warning" ? "warning" : "success",
          });
          addToast(payload.message, payload.level || "success");
        }
      }

      if (type === "SW_SYNC_FAILED" && payload?.message) {
        setCheckoutStatus({ message: payload.message, tone: "error" });
        addToast(payload.message, "error");
      }

      if (type === "SW_BACKGROUND_FETCH_STATUS") {
        const statusText = payload?.status || "";
        if (statusText) {
          setBackgroundFetchStatus(statusText);
          clearTimeout(backgroundFetchTimeoutRef.current);
          backgroundFetchTimeoutRef.current = setTimeout(() => {
            setBackgroundFetchStatus("");
          }, 5000);
        }

        if (payload?.message) {
          const level = payload.level || "info";
          setCatalogStatus({
            message: payload.message,
            tone:
              level === "error"
                ? "error"
                : level === "warning"
                ? "warning"
                : "info",
          });
          addToast(payload.message, level);
        }
      }

      if (type === "SW_CACHE_STRATEGY" && payload?.strategy) {
        setCacheStrategy(payload.strategy);
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, [addToast, cacheStrategy]);

  useEffect(() => {
    if (!navigator.serviceWorker) {
      return;
    }

    navigator.serviceWorker.ready
      .then(() => postMessageToServiceWorker("GET_CACHE_STRATEGY"))
      .catch(() => {
        /* no-op */
      });
  }, [postMessageToServiceWorker]);

  useEffect(() => {
    return () => {
      if (backgroundFetchTimeoutRef.current) {
        clearTimeout(backgroundFetchTimeoutRef.current);
      }
    };
  }, []);

  const addToCart = useCallback(
    (product) => {
      setCart((prev) => {
        const existing = prev[product.id];
        const nextQuantity = existing ? existing.quantity + 1 : 1;
        return {
          ...prev,
          [product.id]: { product, quantity: nextQuantity },
        };
      });
      addToast(`${product.title} added to cart`, "success");
    },
    [addToast]
  );

  const cartSummary = useMemo(() => {
    const items = Object.values(cart);
    const count = items.reduce((acc, { quantity }) => acc + quantity, 0);
    const total = items.reduce(
      (acc, { product, quantity }) => acc + product.price * quantity,
      0
    );
    return { count, total };
  }, [cart]);

  const formattedLastSync = lastSync
    ? new Date(lastSync).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not yet";

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <div>
            <h1>Mock Market</h1>
            <p className="app__tagline">
              Browse a fake store that still works when the network does not.
            </p>
          </div>
        </div>

        <div className="app__controls">
          <div className="app__status">
            <span className={`status-dot${isOnline ? "" : " offline"}`} />
            <span>{isOnline ? "Online" : "Offline"}</span>
          </div>
          <button
            type="button"
            className="app__refresh"
            disabled={loading}
            onClick={() => fetchProducts()}
          >
            {loading ? "Refreshing…" : "Refresh Products"}
          </button>
        </div>

        <div className="app__cart">
          <h2>Cart</h2>
          <p>
            {cartSummary.count} {cartSummary.count === 1 ? "item" : "items"}
          </p>
          <p>{formatter.format(cartSummary.total)}</p>
        </div>
      </header>

      <main className="app__content">
        <section className="catalog">
          {error && <div className="app__error">{error}</div>}

          {loading && !products.length ? (
            <div className="app__loading">Loading catalog…</div>
          ) : (
            <section className="product-grid">
              {products.map((product) => (
                <article key={product.id} className="product-card">
                  <div className="product-card__cover">
                    <img
                      className="product-card__image"
                      src={product.image}
                      alt={product.title}
                      loading="lazy"
                    />
                  </div>
                  <h3 className="product-card__title">{product.title}</h3>
                  <p className="product-card__desc">{product.description}</p>
                  <div className="product-card__meta">
                    <span className="product-card__price">
                      {formatter.format(product.price)}
                    </span>
                    <button
                      type="button"
                      className="product-card__button"
                      onClick={() => addToCart(product)}
                    >
                      Add to cart
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )}
        </section>

        <aside className="app__sidebar">
          <section className="service-panel">
            <h2 className="service-panel__title">Service Worker</h2>

            <div className="service-panel__group">
              <p className="service-panel__heading">Background Sync</p>
              <div className="service-panel__buttons">
                <button
                  type="button"
                  className="service-panel__button"
                  disabled={!isSyncSupported}
                  onClick={registerCheckoutSync}
                >
                  Register Sync
                </button>
                <button
                  type="button"
                  className="service-panel__button"
                  onClick={processCheckoutQueue}
                >
                  Process Queue
                </button>
              </div>
              <p className="service-panel__hint">
                Last sync · {formattedLastSync}
              </p>
            </div>

            <div className="service-panel__group">
              <p className="service-panel__heading">Background Fetch</p>
              <div className="service-panel__buttons">
                <button
                  type="button"
                  className="service-panel__button"
                  onClick={startBackgroundFetch}
                >
                  Start Background Fetch
                </button>
                <button
                  type="button"
                  className="service-panel__button"
                  onClick={() => fetchProducts()}
                >
                  Refresh Now
                </button>
              </div>
              {backgroundFetchStatus && (
                <p className="service-panel__hint">{backgroundFetchStatus}</p>
              )}
              {!isBackgroundFetchSupported && (
                <p className="service-panel__hint">
                  Background fetch API not available. We fall back to prefetch.
                </p>
              )}
            </div>

            <div className="service-panel__group">
              <p className="service-panel__heading">Cache Strategy</p>
              <select
                className="service-panel__select"
                value={cacheStrategy}
                onChange={handleStrategyChange}
              >
                {CACHE_STRATEGIES.map((strategy) => (
                  <option key={strategy.value} value={strategy.value}>
                    {strategy.label}
                  </option>
                ))}
              </select>
              <p className="service-panel__hint">
                Choose how product requests read from the network and cache.
              </p>
              {catalogStatus.message && (
                <p
                  className={`service-panel__status service-panel__status--${catalogStatus.tone}`}
                >
                  {catalogStatus.message}
                </p>
              )}
            </div>
          </section>

          <section className="checkout">
            <h2 className="checkout__title">Checkout</h2>

            {cartSummary.count ? (
              <>
                <div className="checkout__summary">
                  <span>{cartSummary.count} items</span>
                  <span>{formatter.format(cartSummary.total)}</span>
                </div>
                <ul className="checkout__items">
                  {Object.values(cart).map(({ product, quantity }) => (
                    <li key={product.id} className="checkout-item">
                      <div>
                        <p className="checkout-item__name">{product.title}</p>
                        <p className="checkout-item__meta">
                          {quantity} × {formatter.format(product.price)}
                        </p>
                      </div>
                      <span>{formatter.format(product.price * quantity)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="checkout__empty">Your cart is empty.</p>
            )}

            {checkoutStatus.message && (
              <p
                className={`checkout__status checkout__status--${checkoutStatus.tone}`}
              >
                {checkoutStatus.message}
              </p>
            )}

            <button
              type="button"
              className="checkout__button"
              onClick={checkoutCart}
              disabled={!cartSummary.count || isCheckoutProcessing}
            >
              {isCheckoutProcessing ? "Processing…" : "Checkout"}
            </button>
          </section>
        </aside>
      </main>

      <div
        className={`toast-stack${toasts.length ? " toast-stack--visible" : ""}`}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast${toast.level ? ` toast--${toast.level}` : ""}`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
