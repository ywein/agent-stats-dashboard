import assert from "node:assert/strict";
import { test } from "node:test";
import { estimatedBreakdownDifference, preferredTotal, recordKey, sessionKey } from "../../src/core/model/index.ts";
import { piRequest, openCodeRequest, rawPi, rawOpenCode, zeroCostRequest, lifecycleFixtures,
	fork, inheritedRequest, subagent, records, noCost } from "./fixtures.ts";

test("source-native examples preserve unknowns and reported values across JSON", () => {
	const [pi, oc] = JSON.parse(JSON.stringify([piRequest, openCodeRequest]));
	assert.equal(pi.usage.total, rawPi.message.usage.totalTokens);
	assert.equal(pi.timing.durationMs, null);
	assert.equal(oc.cost.recorded.total.amount, rawOpenCode.cost);
	assert.ok(Object.values(oc.cost.recorded.categories).every(value => value === null));
	assert.equal(oc.usage.total, null);
	assert.equal(oc.usage.reasoning, null);
	assert.equal(oc.timing.ttftMs.value, 200);
	assert.equal(estimatedBreakdownDifference(oc.cost), null);
});
test("recorded zero wins without losing a separately labeled estimate or discrepancy", () => {
	assert.deepEqual(preferredTotal(zeroCostRequest.cost), { amount: 0, basis: "recorded" });
	assert.ok(Math.abs(estimatedBreakdownDifference(zeroCostRequest.cost) - 0.00005925) < 1e-15);
	assert.equal(zeroCostRequest.cost.estimated.categories.input.basis.temporalBasis, "current");
	assert.equal(zeroCostRequest.cost.recorded.categories.input, null);
	assert.equal(preferredTotal(noCost), null);
	assert.deepEqual(preferredTotal({ ...zeroCostRequest.cost, recorded: noCost.recorded }),
		{ amount: 0.00005925, basis: "estimated" });
});
test("identity namespaces isolate sources, sessions and separator-bearing IDs", () => {
	assert.notEqual(recordKey(piRequest.identity), recordKey(openCodeRequest.identity));
	assert.notEqual(sessionKey({ sourceId: "a:b", sessionId: "c" }), sessionKey({ sourceId: "a", sessionId: "b:c" }));
	assert.notEqual(recordKey(piRequest.identity), recordKey(inheritedRequest.identity));
});
test("running updates replace the same identity and preserve terminal outcomes", () => {
	const stored = new Map();
	for (const request of lifecycleFixtures) stored.set(recordKey(request.identity), request);
	assert.equal(stored.size, 1);
	assert.deepEqual(lifecycleFixtures.map(r => r.outcome.status), ["running", "succeeded", "failed", "interrupted", "incomplete"]);
	assert.ok(lifecycleFixtures.every(r => r.timing.durationMs === null && r.cost.recorded.total === null));
});
test("fork history has canonical ownership and subagent relationships do not copy spend", () => {
	assert.deepEqual(inheritedRequest.origin, piRequest.identity);
	assert.deepEqual(fork.relationships[0].forkPoint, piRequest.identity);
	assert.deepEqual(subagent.relationships[0].spawnedBy, piRequest.identity);
	const owned = [piRequest, inheritedRequest].filter(r => r.origin === null);
	assert.equal(owned.reduce((sum, r) => sum + r.cost.recorded.total.amount, 0), 0.75);
	assert.equal(new Set(records.map(r => recordKey(r.identity))).size, records.length);
});
