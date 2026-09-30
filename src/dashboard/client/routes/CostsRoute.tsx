import "./costs.css";
import { useMemo, useState } from "react";
import { getCostDashboardStats } from "../api";
import { Chart, type ChartSeries, Legend, ShareBar, useHiddenSeries } from "../charts";
import { buildModelColorLookup, modelKey, OTHER_COLOR, SERIES_COLORS } from "../data/colors";
import { formatCost, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, pivotSeries } from "../data/series";
import { buildCostSummary, type CostComponents, type CostModelRow, type CostSummaryView } from "../data/view-models";
import type { CostDashboardStats, TimeRange } from "../types";
import {
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Skeleton,
	Stat,
	StatGrid,
	Swatch,
	Table,
	TableSkeleton,
} from "../ui";

export interface CostsRouteProps {
	active: boolean;
	range: TimeRange;
}

type SplitMode = "basis" | "model" | "component";

const SPLIT_OPTIONS = [
	{ value: "basis" as const, label: "By pricing basis" },
	{ value: "model" as const, label: "By model" },
	{ value: "component" as const, label: "By component" },
];

/** Models stacked individually in the daily chart; the rest fold into "Other". */
const MODEL_LIMIT = 6;

/** The cost series is bucketed by UTC day on the server. */
const DAY_MS = 86_400_000;

const COMPONENTS = [
	{ key: "costInput", label: "Input", color: "#5b8cff" },
	{ key: "costOutput", label: "Output", color: "var(--chart-secondary)" },
	{ key: "costCacheRead", label: "Cache read", color: "var(--chart-primary)" },
	{ key: "costCacheWrite", label: "Cache write", color: "#f5b54a" },
] as const satisfies readonly { key: keyof CostComponents; label: string; color: string }[];

const UTC_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const UTC_DAY_LONG = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

export function CostsRoute({ active, range }: CostsRouteProps) {
	const query = useQuery(["costs", range], () => getCostDashboardStats(range), { enabled: active });
	const meta = rangeMeta(range);
	const [split, setSplit] = useState<SplitMode>("basis");
	const [hidden, toggleSeries] = useHiddenSeries();
	const view = useMemo(() => (query.data ? buildCostsView(query.data, range) : null), [query.data, range]);
	const isEmpty = (data: CostDashboardStats) => data.costSeries.length === 0;
	const empty = <EmptyState title="No usage in this range" hint="Pick a wider range in the top bar." />;

	return (
		<div className="page">
			<PageHeader
				title="Costs"
				description={`Cost for ${meta.windowLabel}: recorded totals are preferred, with estimates only when unavailable. Unpriced requests are excluded. Category costs are recorded values and may not reconcile with totals.`}
			/>

			<QueryView
				query={query}
				skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}
				isEmpty={isEmpty}
				empty={empty}
			>
				{() => view && <CostStats view={view} stale={query.stale} />}
			</QueryView>

			<div className="grid grid-main-side">
				<Card
					index={1}
					title="Daily cost"
					description={
						split === "basis" ? "Recorded spend and estimated-only API-equivalent cost, per UTC day" : split === "model" ? "Recorded totals plus estimated-only costs, stacked by model" : "Recorded costs, stacked by billing component"
					}
					actions={
						<Segmented
							size="sm"
							options={SPLIT_OPTIONS}
							value={split}
							onChange={setSplit}
							aria-label="Split by"
						/>
					}
					stale={query.stale}
				>
					<QueryView query={query} skeleton={<ChartSkeleton height={280} />} isEmpty={isEmpty} empty={empty}>
						{() => {
							if (!view) return null;
							if (view.summary.requests === view.summary.unpricedRequests) return <EmptyState title="Cost unavailable" hint="No recorded totals or suitable pricing estimates for these requests." />;
							if (split === "component" && !view.breakdownKnown) return <EmptyState title="Recorded breakdown unavailable" hint="Some requests have a total without category costs. Separate estimates are available in request details when pricing allows." />;
							const series = split === "basis" ? view.basisSeries : split === "model" ? view.modelSeries : view.componentSeries;
							return (
								<div className="stack" style={{ gap: 12 }}>
									<Chart
										slots={view.buckets.length}
										tickLabel={i => UTC_DAY.format(view.buckets[i])}
										tooltipTitle={i => UTC_DAY_LONG.format(view.buckets[i])}
										series={series}
										hidden={hidden}
										height={280}
										format={v => formatCost(v, Number.isInteger(v) ? 0 : 2)}
										formatTooltip={v => formatCost(v)}
										emptyLabel="No nonzero spend in this range"
										tooltipExtra={i =>
											view.unpricedPerDay[i] > 0 ? (
												<div className="chart-tooltip-row chart-tooltip-total">
													<span className="chart-tooltip-label">Unpriced requests</span>
													<span className="chart-tooltip-value">
														{formatInteger(view.unpricedPerDay[i])}
													</span>
												</div>
											) : null
										}
									/>
									<Legend
										items={series.map(s => ({
											key: s.key,
											label: s.label,
											color: s.color,
											value: formatCost(split === "basis" && s.values.every(value => value === null) ? null : sum(s.values)),
										}))}
										hidden={hidden}
										onToggle={toggleSeries}
									/>
								</div>
							);
						}}
					</QueryView>
				</Card>

				<Card index={2} title="Where it went" description="Recorded costs by billing component" stale={query.stale}>
					<QueryView query={query} skeleton={<ChartSkeleton height={280} />} isEmpty={isEmpty} empty={empty}>
						{() => view && (view.breakdownKnown ? <ComponentBreakdown summary={view.summary} /> : <EmptyState title="Recorded breakdown unavailable" hint="Unknown categories are not zero. See request details for separate estimates." />)}
					</QueryView>
				</Card>
			</div>

			<Card
				index={3}
				title="By model"
				description="Recorded / estimated totals; category splits are shown only with complete recorded coverage"
				stale={query.stale}
				flush
			>
				<QueryView query={query} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={empty}>
					{() =>
						view && (
							<Table
								rows={view.summary.models}
								rowKey={row => row.key}
								columns={buildCostColumns(view)}
								initialSort={{ key: "cost", dir: "desc" }}
								limit={20}
							/>
						)
					}
				</QueryView>
			</Card>
		</div>
	);
}

interface CostsView {
	breakdownKnown: boolean;
	summary: CostSummaryView;
	/** Chart color of each individually plotted model; the rest share "Other" gray. */
	swatches: Map<string, string>;
	buckets: number[];
	dailyTotals: number[];
	unpricedPerDay: number[];
	modelSeries: ChartSeries[];
	componentSeries: ChartSeries[];
	basisSeries: ChartSeries[];
	maxModelCost: number;
}

function buildCostsView(data: CostDashboardStats, range: TimeRange): CostsView {
	const points = data.costSeries;
	const summary = buildCostSummary(points);
	const colors = buildModelColorLookup(
		summary.models.map(m => ({ model: m.model, provider: m.provider, totalRequests: m.requests })),
	);
	const byKey = new Map(summary.models.map(m => [m.key, m]));
	const buckets = bucketAxis(
		range,
		points.map(p => p.timestamp),
		DAY_MS,
	);
	// Zero slots become gaps so the tooltip lists only what was spent that day.
	const modelSeries = pivotSeries(points, {
		buckets,
		key: p => modelKey(p.model, p.provider),
		label: key => byKey.get(key)?.model ?? key,
		value: p => p.cost,
		limit: MODEL_LIMIT,
		colors,
	}).map(s => ({ ...s, values: s.values.map(v => v || null) }));
	// Colors follow request rank (shared with the Models page); the top models by
	// cost can include ranks that wrap onto the same hue, so recolor repeats.
	const used = new Set<string>();
	for (const s of modelSeries) {
		if (s.key === "__other__") continue;
		if (used.has(s.color)) s.color = SERIES_COLORS.find(c => !used.has(c)) ?? s.color;
		used.add(s.color);
	}
	return {
		breakdownKnown: points.every(p => COMPONENTS.every(c => p[c.key] !== null)),
		summary,
		swatches: new Map(modelSeries.filter(s => s.key !== "__other__").map(s => [s.key, s.color])),
		buckets,
		dailyTotals: densify(points, buckets, p => p.cost),
		unpricedPerDay: densify(points, buckets, p => p.unpricedRequests),
		modelSeries,
		basisSeries: [
			{ key: "recorded", label: "Recorded spend", color: "var(--chart-primary)", values: buckets.map(at => { const known = points.filter(p => p.timestamp === at && p.recordedCost != null); return known.length ? known.reduce((n, p) => n + p.recordedCost!, 0) : null; }) },
			{ key: "estimated", label: "Estimated only (API-equivalent)", color: "var(--chart-secondary)", values: buckets.map(at => { const known = points.filter(p => p.timestamp === at && p.estimatedCost != null); return known.length ? known.reduce((n, p) => n + p.estimatedCost!, 0) : null; }) },
		],
		componentSeries: COMPONENTS.map(c => ({
			key: c.key,
			label: c.label,
			color: c.color,
			values: densify(points, buckets, p => p[c.key] ?? 0).map(v => v || null),
		})),
		maxModelCost: summary.models[0]?.cost ?? 0,
	};
}

function CostStats({ view, stale }: { view: CostsView; stale: boolean }) {
	const { summary } = view;
	const pricedRequests = summary.requests - summary.unpricedRequests;
	const top = summary.topModel;
	return (
		<div data-stale={stale}>
			<StatGrid min={180}>
				<Stat
					label="Cost (recorded / estimated)"
					title="Recorded totals, with estimates for unavailable totals"
					value={formatCost(pricedRequests ? summary.totalCost : null)}
					hint={`${formatInteger(summary.requests)} requests`}
					spark={view.dailyTotals}
					sparkColor="var(--chart-secondary)"
				/>
				<Stat
					label="Average per day"
					title="Estimate ÷ days with any usage"
					value={formatCost(pricedRequests ? summary.avgDailyCost : null)}
					hint={`over ${formatInteger(summary.activeDays)} active day${summary.activeDays === 1 ? "" : "s"}`}
				/>
				<Stat
					label="Top model"
					title={top ? `${top.model} (${top.provider})` : undefined}
					value={top ? top.model : "–"}
					hint={top ? `${formatCost(top.cost)} · ${formatPercent(top.share)} of total` : "No nonzero spend"}
				/>
				<Stat
					label="Per priced request"
					title="Estimate ÷ requests that have a public price"
					value={pricedRequests > 0 ? formatUnitCost(summary.totalCost / pricedRequests) : "–"}
					hint={`${formatInteger(pricedRequests)} priced`}
				/>
				<Stat
					label="Unpriced requests"
					title="Subscription usage with no public-equivalent price; excluded from the estimate"
					value={formatInteger(summary.unpricedRequests)}
					hint={summary.unpricedRequests > 0 ? "excluded from the estimate" : "all usage priced"}
				/>
			</StatGrid>
		</div>
	);
}

function ComponentBreakdown({ summary }: { summary: CostSummaryView }) {
	return (
		<div className="stack" style={{ gap: 14 }}>
			<ShareBar
				height={10}
				segments={COMPONENTS.map(c => ({ key: c.key, label: c.label, value: summary[c.key], color: c.color }))}
			/>
			<div className="costs-components">
				{COMPONENTS.map(c => (
					<div key={c.key} className="costs-component-row">
						<span className="row">
							<Swatch color={c.color} />
							{c.label}
						</span>
						<span className="num">{formatCost(summary[c.key])}</span>
						<span className="num dim costs-component-share">
							{summary.totalCost > 0 ? formatPercent(summary[c.key] / summary.totalCost) : "–"}
						</span>
					</div>
				))}
				<div className="costs-component-row costs-component-total">
					<span>Total</span>
					<span className="num">{formatEstimatedCost(summary.totalCost, summary.unpricedRequests)}</span>
					<span className="costs-component-share" />
				</div>
			</div>
			{summary.unpricedRequests > 0 && (
				<p className="micro dim">
					{formatInteger(summary.unpricedRequests)} unpriced subscription request
					{summary.unpricedRequests === 1 ? " is" : "s are"} not included.
				</p>
			)}
		</div>
	);
}

function buildCostColumns(view: CostsView): Column<CostModelRow>[] {
	const componentColumns: Column<CostModelRow>[] = COMPONENTS.map(c => ({
		key: c.key,
		header: c.label,
		align: "right",
		sort: row => row[c.key],
		render: row => <span className="num">{formatCost(view.breakdownKnown ? row[c.key] : null)}</span>,
	}));
	return [
		{
			key: "model",
			header: "Model",
			sort: row => row.model,
			render: row => (
				<LabelCell
					lead={<Swatch color={view.swatches.get(row.key) ?? OTHER_COLOR} />}
					primary={<span className="mono">{row.model}</span>}
					secondary={row.provider}
				/>
			),
		},
		{
			key: "requests",
			header: "Requests",
			align: "right",
			sort: row => row.requests,
			render: row => <span className="num">{formatInteger(row.requests)}</span>,
		},
		{
			key: "cost",
			header: "Cost",
			title: "Recorded totals, with estimates for unavailable totals",
			align: "right",
			sort: row => row.cost,
			render: row => (
				<MeterCell
					value={row.cost}
					max={view.maxModelCost}
					display={formatCost(row.requests > row.unpricedRequests ? row.cost : null)}
					color={view.swatches.get(row.key) ?? OTHER_COLOR}
				/>
			),
		},
		{
			key: "share",
			header: "Share",
			align: "right",
			sort: row => row.share,
			render: row => <span className="num muted">{row.cost > 0 ? formatPercent(row.share) : "–"}</span>,
		},
		{
			key: "split",
			header: "Split",
			title: "Input · output · cache read · cache write",
			width: 150,
			render: row =>
				row.cost > 0 && view.breakdownKnown ? (
					<ShareBar
						segments={COMPONENTS.map(c => ({ key: c.key, label: c.label, value: row[c.key], color: c.color }))}
					/>
				) : (
					<span className="dim">–</span>
				),
		},
		...componentColumns,
		{
			key: "perRequest",
			header: "Per request",
			title: "Estimate ÷ priced requests",
			align: "right",
			sort: row => (row.requests > row.unpricedRequests ? row.cost / (row.requests - row.unpricedRequests) : -1),
			render: row => (
				<span className="num">
					{row.requests > row.unpricedRequests
						? formatUnitCost(row.cost / (row.requests - row.unpricedRequests))
						: "–"}
				</span>
			),
		},
		{
			key: "unpriced",
			header: "Unpriced",
			title: "Requests with no public-equivalent price",
			align: "right",
			sort: row => row.unpricedRequests,
			render: row =>
				row.unpricedRequests > 0 ? (
					<span className="num tone-warn">{formatInteger(row.unpricedRequests)}</span>
				) : (
					<span className="num dim">–</span>
				),
		},
	];
}

/** Per-request cost; amounts below the 4-digit precision read as a bound instead of "$0.0000". */
function formatUnitCost(value: number): string {
	return value > 0 && value < 0.0001 ? "<$0.0001" : formatCost(value);
}

function sum(values: readonly (number | null)[]): number {
	let total = 0;
	for (const v of values) total += v ?? 0;
	return total;
}
