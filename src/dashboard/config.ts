/** Stage 1 presentation settings, not the future adapter capability contract. */
export interface DashboardConfig {
	title: string;
	sourceLabel: string;
	logo: { viewBox: string; path: string };
	themeStorageKey: string;
	features: {
		sections: string[];
		judge: boolean;
	};
}
