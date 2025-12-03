import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./style.css";
import { initServiceWorker } from "./registerSW";

initServiceWorker();

createRoot(document.getElementById("root")).render(<App />);
