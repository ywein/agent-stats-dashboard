import { adapterContractTests } from "../../src/adapter-contract/testing/index.mjs";
import { createFixtureAdapter, capabilities } from "../../examples/fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAdapterCompatible } from "../../src/adapter-contract/index.ts";

adapterContractTests("standalone fixture", () => ({ ...createFixtureAdapter(),
	source: { sourceId: "fixture:test", clientType: "fixture", label: "Fixture", capabilities }, config: {} }));

test("incompatible and malformed adapters produce actionable errors", () => {
	assert.throws(() => assertAdapterCompatible({ descriptor: { id: "future", contractVersion: 2 } }), /future.*API 2.*supports API 1.*upgrade/);
	assert.throws(() => assertAdapterCompatible(null), /unspecified.*compatible/);
	assert.throws(() => assertAdapterCompatible({ descriptor: { contractVersion: 1 } }), /descriptor.*connect/);
});
