import type { DashboardConfig } from "../config";

let config: DashboardConfig;

export function dashboardConfig(): DashboardConfig {
	if (!config) throw new Error("Dashboard configuration has not loaded");
	return config;
}

/** Load before importing App: navigation and theme read configuration at startup. */
export async function loadConfig(): Promise<void> {
	const response = await fetch("/api/config");
	if (!response.ok) throw new Error(`Dashboard configuration: HTTP ${response.status}`);
	config = await response.json();
	document.title = config.title;
	try {
		const stored = localStorage.getItem(config.themeStorageKey);
		const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		const theme = stored === "light" || stored === "dark" ? stored : system;
		document.documentElement.dataset.theme = theme;
		document.documentElement.style.colorScheme = theme;
	} catch { /* Storage can be unavailable in private browser contexts. */ }
}
