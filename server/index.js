import express from "express";
import cors from "cors";
import webpush from "web-push";

const PORT = Number(process.env.PORT || 3001);

const configureVapidKeys = () => {
	const publicKey = process.env.VAPID_PUBLIC_KEY;
	const privateKey = process.env.VAPID_PRIVATE_KEY;

	if (publicKey && privateKey) {
		return { publicKey, privateKey };
	}

	const generated = webpush.generateVAPIDKeys();
	console.log("[server] Generated ephemeral VAPID keys. Set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to persist.");
	console.log({ publicKey: generated.publicKey });
	return generated;
};

const vapidKeys = configureVapidKeys();

webpush.setVapidDetails("mailto:example@example.com", vapidKeys.publicKey, vapidKeys.privateKey);

const app = express();
app.use(cors());
app.use(express.json());

const subscriptions = new Set();
const messages = [];

app.get("/health", (_req, res) => {
	res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/vapid-public-key", (_req, res) => {
	res.send(vapidKeys.publicKey);
});

app.post("/subscribe", (req, res) => {
	const subscription = req.body;
	if (!subscription || !subscription.endpoint) {
		res.status(400).json({ error: "Invalid subscription payload." });
		return;
	}

	subscriptions.add(subscription);
	res.status(201).json({ ok: true });
});

app.post("/push", async (req, res) => {
	if (!subscriptions.size) {
		res.status(400).json({ error: "No push subscriptions stored." });
		return;
	}

	const { message = "Hello from the server!" } = req.body || {};
	const payload = JSON.stringify({
		title: "Service Worker Tester",
		body: message,
		data: { sentAt: Date.now() },
	});

	const activeSubscriptions = Array.from(subscriptions);
	const results = await Promise.allSettled(
		activeSubscriptions.map((subscription) => webpush.sendNotification(subscription, payload))
	);

	let delivered = 0;
	results.forEach((result, index) => {
		if (result.status === "fulfilled") {
			delivered += 1;
			return;
		}

		const statusCode = result.reason?.statusCode;
		if (statusCode === 410 || statusCode === 404) {
			subscriptions.delete(activeSubscriptions[index]);
		}
		console.error("[server] Push delivery failed", result.reason);
	});

	res.json({ ok: true, delivered, failed: results.length - delivered });
});

app.post("/api/messages", (req, res) => {
	const { text, queuedAt } = req.body || {};
	if (!text) {
		res.status(400).json({ error: "Missing text field." });
		return;
	}

	const entry = {
		id: Date.now(),
		text,
		queuedAt: queuedAt ?? Date.now(),
		receivedAt: Date.now(),
	};

	messages.push(entry);
	res.json({ ok: true, entry });
});

app.get("/api/messages", (_req, res) => {
	res.json({ ok: true, messages });
});

app.post("/api/ping", (_req, res) => {
	res.json({ ok: true, at: Date.now() });
});

app.use((err, _req, res, _next) => {
	console.error("[server] Unhandled error", err);
	res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
	console.log(`[server] SW helper server listening on http://localhost:${PORT}`);
});
