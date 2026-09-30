import type { DashboardConfig } from "./dashboard/config.ts";

export const dashboardConfig: DashboardConfig = {
	title: "Agent stats",
	sourceLabel: "Coding agents",
	logo: { viewBox: "0 0 64 64", path: "M8 12h48v40H8V12zm8 8v24h32V20H16zm5 5 10 7-10 7v-6l3-1-3-1v-6zm13 12h9v4h-9v-4z" },
	themeStorageKey: "agent-stats-theme",
	features: { sections: ["overview", "models", "providers", "costs", "requests", "errors", "traces", "tools", "frustration", "projects"], judge: false },
};
