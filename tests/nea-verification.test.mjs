import test from "node:test";
import assert from "node:assert/strict";

import {
  verifyExecutionResult,
  NEA_VERIFICATION_DECISIONS
} from "../tools/nea/core/verification.mjs";

function result(overrides = {}) {
  return {
    requestId: "request-1",
    engineId: "engine-1",
    status: "SUCCEEDED",
    startedAt: "2026-11-21T00:00:00.000Z",
    finishedAt: "2026-11-21T00:00:01.000Z",
    output: { value: true },
    findings: [],
    errors: [],
    evidence: [{ type: "test-record", reference: "record-1" }],
    metadata: {},
    ...overrides
  };
}

function batchResult(overrides = {}) {
  return result({
    engineId: "root",
    output: {
      executionOrder: ["engine-a", "engine-b"],
      executed: ["engine-a", "engine-b"],
      results: [
        { engineId: "engine-a", status: "SUCCEEDED", evidence: [] },
        { engineId: "engine-b", status: "SUCCEEDED", evidence: [] }
      ]
    },
    ...overrides
  });
}

test("exports supported verification decisions", () => {
  assert.deepEqual(NEA_VERIFICATION_DECISIONS, [
    "VERIFIED", "REJECTED", "INDETERMINATE"
  ]);
});

test("verifies a valid single-engine result with evidence", () => {
  const report = verifyExecutionResult({ result: result() });
  assert.equal(report.decision, "VERIFIED");
  assert.equal(report.evidence.count, 1);
});

test("does not mutate the original execution result", () => {
  const original = result();
  const before = structuredClone(original);
  verifyExecutionResult({ result: original });
  assert.deepEqual(original, before);
});

test("returns an immutable verification report", () => {
  const report = verifyExecutionResult({ result: result() });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.checks), true);
  assert.equal(Object.isFrozen(report.checks[0]), true);
});

test("rejects an invalid result contract", () => {
  const report = verifyExecutionResult({
    result: { requestId: "incomplete" }
  });
  assert.equal(report.decision, "REJECTED");
  assert.ok(report.issues.some(
    issue => issue.code === "INVALID_RESULT_CONTRACT"
  ));
});

test("rejects a request identifier mismatch", () => {
  const report = verifyExecutionResult({
    result: result(),
    expectedRequestId: "different"
  });
  assert.equal(report.decision, "REJECTED");
  assert.ok(report.issues.some(
    issue => issue.code === "REQUEST_ID_MISMATCH"
  ));
});

test("rejects an engine identifier mismatch", () => {
  const report = verifyExecutionResult({
    result: result(),
    expectedEngineId: "different"
  });
  assert.equal(report.decision, "REJECTED");
});

test("verifies a consistent batch result", () => {
  const report = verifyExecutionResult({
    result: batchResult(),
    expectedExecutionOrder: ["engine-a", "engine-b"]
  });
  assert.equal(report.decision, "VERIFIED");
});

test("rejects batch execution-order mismatch", () => {
  const value = batchResult();
  value.output.results.reverse();

  const report = verifyExecutionResult({ result: value });
  assert.equal(report.decision, "REJECTED");
  assert.ok(report.issues.some(
    issue => issue.code === "EXECUTION_ORDER_MISMATCH"
  ));
});

test("rejects duplicate engine identifiers", () => {
  const value = batchResult();
  value.output.executionOrder = ["engine-a", "engine-a"];
  value.output.results = [
    { engineId: "engine-a", status: "SUCCEEDED" },
    { engineId: "engine-a", status: "SUCCEEDED" }
  ];

  const report = verifyExecutionResult({ result: value });
  assert.equal(report.decision, "REJECTED");
  assert.ok(report.issues.some(
    issue => issue.code === "DUPLICATE_OR_INVALID_ENGINE_ID"
  ));
});

test("rejects an inconsistent executed list", () => {
  const value = batchResult();
  value.output.executed = ["engine-a"];

  const report = verifyExecutionResult({ result: value });
  assert.equal(report.decision, "REJECTED");
  assert.ok(report.issues.some(
    issue => issue.code === "EXECUTED_LIST_MISMATCH"
  ));
});

test("rejects contradictory aggregate status", () => {
  const value = batchResult();
  value.output.results[1].status = "FAILED";

  const report = verifyExecutionResult({ result: value });
  assert.equal(report.decision, "REJECTED");
  assert.ok(report.issues.some(
    issue => issue.code === "AGGREGATE_STATUS_MISMATCH"
  ));
});

test("rejects a failed execution", () => {
  const report = verifyExecutionResult({
    result: result({ status: "FAILED" })
  });
  assert.equal(report.decision, "REJECTED");
});

test("returns indeterminate when evidence is missing", () => {
  const report = verifyExecutionResult({
    result: result({ evidence: [] })
  });
  assert.equal(report.decision, "INDETERMINATE");
  assert.equal(report.evidence.state, "MISSING");
});

test("counts evidence from nested engine results", () => {
  const value = batchResult({ evidence: [] });
  value.output.results[0].evidence = [{ reference: "a" }];
  value.output.results[1].evidence = [{ reference: "b" }];

  const report = verifyExecutionResult({ result: value });
  assert.equal(report.evidence.count, 2);
  assert.equal(report.decision, "VERIFIED");
});

test("accepts a valid single-engine result without batch fields", () => {
  const report = verifyExecutionResult({ result: result() });
  assert.equal(report.decision, "VERIFIED");
  assert.equal(
    report.checks.some(check => check.id === "batch-envelope"),
    false
  );
});

test("throws for malformed verification input", () => {
  assert.throws(
    () => verifyExecutionResult(null),
    TypeError
  );
  assert.throws(
    () => verifyExecutionResult({}),
    TypeError
  );
});
