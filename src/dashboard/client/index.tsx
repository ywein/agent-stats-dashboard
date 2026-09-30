import "./styles.css";
import { createRoot } from "react-dom/client";
import { loadConfig } from "./config";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
try {
	await loadConfig();
	const { default: App } = await import("./App");
	root.removeAttribute("role");
	createRoot(root).render(<App />);
} catch (error) {
	root.textContent = `Could not load dashboard. ${error instanceof Error ? error.message : String(error)}. Reload to retry.`;
}
