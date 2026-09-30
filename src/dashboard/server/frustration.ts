import { group, sum, timestamp } from "../../core/aggregation/index.ts";
import { recordKey, type ModelRequest, type UserMessage } from "../../core/model/index.ts";
import { computeUserMessageMetrics, judgeProse } from "../../core/aggregation/user-metrics.ts";
import type { FrustrationDashboardStats, FrustrationJobStatus } from "../shared-types.ts";
import { rangeWindow, type DashboardQueries } from "./queries.ts";

export const job: FrustrationJobStatus = { state: "idle", total: 0, done: 0, failed: 0, cost: 0, judge: null, error: null, startedAt: null, finishedAt: null, concurrency: 0 };
export const noJudge = { available: false as const, reason: "This standalone dashboard has no judge configured." };
export function frustration(q: DashboardQueries, range: string | null): FrustrationDashboardStats {
	const { cutoff } = rangeWindow(range);
	const requests = new Map(q.requests.filter(r => r.prompt).map(r => [recordKey(r.prompt!), r]));
	const users = q.records.map(r => r.record).filter((r): r is UserMessage => r.kind === "user-message" && r.origin === null && (cutoff === null || (timestamp(r) !== null && timestamp(r)! >= cutoff)));
	const rows = users.flatMap(r => {
		const prose = judgeProse(r.content?.map(b => b.type === "text" ? b.text : "").join("") ?? "");
		if (!prose) return [];
		const m = computeUserMessageMetrics(prose), atAssistant = m.negation + m.repetition + m.blame > 0;
		return [{ user: r, request: requests.get(recordKey(r.identity)), annoyed: Number(m.yelling + m.profanity + m.anguish + m.negation + m.repetition + m.blame > 0), atAssistant: Number(atAssistant), angry: Number(atAssistant && m.profanity + m.yelling > 0) }];
	});
	const counts = (g: typeof rows) => ({ messages: g.length, judged: 0, annoyed: sum(g, r => r.annoyed), atAssistant: sum(g, r => r.atAssistant), angry: sum(g, r => r.angry) });
	return { overall: counts(rows), byModel: group(rows, r => r.request?.model.model ?? "unknown").map(g => {
		const model = g[0]!.request?.model.model ?? "unknown";
		return { ...counts(g), key: model, label: model, modelClass: "unknown", family: null, revision: null, models: [model], firstSeen: Math.min(...g.map(r => r.user.at ?? 0)) };
	}), judgeAvailable: false, job };
}
