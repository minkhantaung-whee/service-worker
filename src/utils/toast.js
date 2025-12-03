const TOAST_CONTAINER_ID = "sw-toast-container";

const ensureContainer = () => {
	let container = document.getElementById(TOAST_CONTAINER_ID);
	if (container) return container;

	container = document.createElement("div");
	container.id = TOAST_CONTAINER_ID;
	container.style.position = "fixed";
	container.style.right = "16px";
	container.style.bottom = "16px";
	container.style.display = "flex";
	container.style.flexDirection = "column";
	container.style.gap = "8px";
	container.style.zIndex = "9999";
	document.body.appendChild(container);

	const style = document.createElement("style");
	style.textContent = `
		.sw-toast {
			min-width: 240px;
			max-width: min(320px, 80vw);
			background: rgba(36, 36, 36, 0.92);
			color: #fff;
			border-radius: 8px;
			padding: 12px 16px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
			font-family: system-ui, sans-serif;
			font-size: 14px;
			line-height: 1.4;
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 12px;
			opacity: 0;
			transform: translateY(12px);
			transition: opacity 160ms ease, transform 160ms ease;
		}

		.sw-toast.sw-toast-visible {
			opacity: 1;
			transform: translateY(0);
		}

		.sw-toast button {
			background: transparent;
			color: inherit;
			border: none;
			font-size: 14px;
			cursor: pointer;
			padding: 0;
		}
	`;
	document.head.appendChild(style);

	return container;
};

export const showToast = (message, { duration = 3500 } = {}) => {
	if (!message) return;

	const container = ensureContainer();
	const toast = document.createElement("div");
	toast.className = "sw-toast";
	toast.setAttribute("role", "status");
	toast.innerHTML = `<span>${message}</span>`;

	const dismiss = document.createElement("button");
	dismiss.type = "button";
	dismiss.setAttribute("aria-label", "Dismiss notification");
	dismiss.textContent = "✕";
	dismiss.addEventListener("click", () => removeToast(toast));
	toast.appendChild(dismiss);

	container.appendChild(toast);

	requestAnimationFrame(() => {
		toast.classList.add("sw-toast-visible");
	});

	const timeoutId = duration
		? setTimeout(() => removeToast(toast), duration)
		: null;

	toast.dataset.timeoutId = timeoutId;
};

const removeToast = (toast) => {
	if (!toast) return;
	const timeoutId = toast.dataset.timeoutId;
	if (timeoutId) {
		clearTimeout(Number(timeoutId));
	}

	toast.classList.remove("sw-toast-visible");
	toast.addEventListener(
		"transitionend",
		() => {
			toast.remove();
			const container = document.getElementById(TOAST_CONTAINER_ID);
			if (container && container.children.length === 0) {
				container.remove();
			}
		},
		{ once: true }
	);
};

export const toastFromSW = (event) => {
	if (!event || !event.data) return;
	const { message, duration } = event.data;
	showToast(message, { duration });
};
