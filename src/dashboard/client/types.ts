/**
 * Client-side type definitions.
 *
 * Stage 1 HTTP response shapes. Shared aggregation and trace types live in
 * `../shared-types`. Request shapes use plain strings and usage objects so
 * the browser does not depend on either client's SDK.
 */

import type {
	AgentTypeStats,
	AggregatedStats,
	CostTimeSeriesPoint,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
} from "../shared-types";
import type { RequestCost, Outcome } from "../../core/model/index.ts";

export * from "../shared-types";

export interface Usage {
	reasoning?: number | null;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	totalTokens: number | null;
	premiumRequests?: number;
	cost: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		total: number | null;
	};
}

export interface MessageStats {
	source?: import("../../core/model/index.ts").Source | null;
	cost?: RequestCost;
	outcome?: Outcome;
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number | null;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: Usage;
	/** Ingest found no tariff to price this request from; its zero is unknown spend. */
	costUnpriced?: boolean;
}

export interface RequestDetails extends MessageStats {
	messages: unknown[];
	output: unknown;
}

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

export interface OverviewStats {
	overall: AggregatedStats;
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
}

export interface ModelDashboardStats {
	byModel: ModelStats[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
}

export interface CostDashboardStats {
	costSeries: CostTimeSeriesPoint[];
}
