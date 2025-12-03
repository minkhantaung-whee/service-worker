import { showToast } from "./utils/toast";

const CLIENT_LOG_PREFIX = "[SW-CLIENT]";

const log = (...args) => {
	console.log(CLIENT_LOG_PREFIX, ...args);
};

const monitorWorker = (worker, label) => {
	if (!worker) return;
	log(`${label} state:`, worker.state);
	worker.addEventListener("statechange", () => {
		log(`${label} state:`, worker.state);
		if (worker.state === "installed") {
			const isUpdate = Boolean(navigator.serviceWorker.controller);
			showToast(isUpdate ? "Update ready. Reload to activate." : "Service worker installed.");
		}
		if (worker.state === "activated") {
			showToast("Service worker activated.");
		}
	});
};

const listenForMessages = () => {
	navigator.serviceWorker.addEventListener("message", (event) => {
		const { type, message, payload } = event.data || {};
		if (!type) return;

		log(`Message from SW:`, type, payload ?? message ?? "");

		if (type === "TOAST" && message) {
			showToast(message, payload);
		}
	});
};

const makeActiveWorkerNotifier = () => {
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		log("Controller changed. Current controller:", navigator.serviceWorker.controller);
		showToast("Service worker now controlling this page.");
	});
};

export const initServiceWorker = async () => {
	if (!("serviceWorker" in navigator)) {
		log("Service worker not supported in this browser.");
		return null;
	}

	listenForMessages();
	makeActiveWorkerNotifier();

	try {
		const registration = await navigator.serviceWorker.register("/sw.js", {
			scope: "/",
			updateViaCache: "none",
		});

		log("Registration successful:", registration.scope);
		showToast("Service worker registration completed.");

		if (registration.installing) monitorWorker(registration.installing, "installing");
		if (registration.waiting) monitorWorker(registration.waiting, "waiting");
		if (registration.active) monitorWorker(registration.active, "active");

		registration.addEventListener("updatefound", () => {
			log("Update found.");
			showToast("Downloading new service worker...");
			monitorWorker(registration.installing, "installing");
		});

		navigator.serviceWorker.ready
			.then((readyReg) => {
				log("Service worker ready:", readyReg.scope);
				readyReg.active?.postMessage({ type: "CLIENT_READY", timestamp: Date.now() });
			})
			.catch((error) => {
				console.error(CLIENT_LOG_PREFIX, "Ready promise rejected:", error);
			});

		return registration;
	} catch (error) {
		console.error(CLIENT_LOG_PREFIX, "Registration failed:", error);
		showToast("Service worker registration failed. Check console for details.");
		return null;
	}
};
