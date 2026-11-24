import {
  validateExecutionResult,
  NEA_EXECUTION_STATUSES
} from "./contracts.mjs";

export const NEA_VERIFICATION_DECISIONS = Object.freeze([
  "VERIFIED",
  "REJECTED",
  "INDETERMINATE"
]);

function freezeReport(report) {
  for (const check of report.checks) Object.freeze(check);
  for (const issue of report.issues) Object.freeze(issue);
  Object.freeze(report.checks);
  Object.freeze(report.issues);
  Object.freeze(report.evidence);
  return Object.freeze(report);
}

function makeReport({
  decision,
  checks = [],
  issues = [],
  evidenceCount = 0,
  summary
}) {
  return freezeReport({
    decision,
    checks,
    issues,
    evidence: {
      count: evidenceCount,
      state: evidenceCount > 0
        ? "PRESENT_UNAUTHENTICATED"
        : "MISSING",
      authenticated: false
    },
    summary
  });
}

function countEvidence(result) {
  let count = Array.isArray(result.evidence)
    ? result.evidence.length
    : 0;

  const nested = result.output?.results;
  if (Array.isArray(nested)) {
    for (const item of nested) {
      if (Array.isArray(item?.evidence)) {
        count += item.evidence.length;
      }
    }
  }

  return count;
}

function addCheck(checks, id, passed, details = "") {
  checks.push({
    id,
    passed,
    details
  });
}

function addIssue(issues, code, message, severity = "error") {
  issues.push({
    code,
    message,
    severity
  });
}

export function verifyExecutionResult(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !input.result ||
    typeof input.result !== "object" ||
    Array.isArray(input.result)
  ) {
    throw new TypeError(
      "Verification input must contain a result object"
    );
  }

  const result = input.result;
  const contract = validateExecutionResult(result);

  if (!contract.valid) {
    return makeReport({
      decision: "REJECTED",
      checks: [{
        id: "result-contract",
        passed: false,
        details: "Execution result violates the NEA result contract"
      }],
      issues: contract.errors.map(message => ({
        code: "INVALID_RESULT_CONTRACT",
        message,
        severity: "error"
      })),
      summary: "Execution result contract is invalid"
    });
  }

  const checks = [];
  const issues = [];

  if (input.expectedRequestId !== undefined) {
    const passed = result.requestId === input.expectedRequestId;
    addCheck(checks, "request-id", passed);
    if (!passed) {
      addIssue(issues, "REQUEST_ID_MISMATCH",
        "Result requestId does not match the expected requestId");
    }
  }

  if (input.expectedEngineId !== undefined) {
    const passed = result.engineId === input.expectedEngineId;
    addCheck(checks, "engine-id", passed);
    if (!passed) {
      addIssue(issues, "ENGINE_ID_MISMATCH",
        "Result engineId does not match the expected engineId");
    }
  }

  const output = result.output;
  const batchKeys = ["executionOrder", "executed", "results"];
  const isBatch = output && typeof output === "object" &&
    batchKeys.some(key => Object.hasOwn(output, key));

  if (isBatch) {
    const shapeValid = batchKeys.every(key =>
      Array.isArray(output[key])
    );

    addCheck(checks, "batch-envelope", shapeValid);

    if (!shapeValid) {
      addIssue(issues, "INVALID_BATCH_ENVELOPE",
        "Batch output must contain executionOrder, executed and results arrays");
    } else {
      const order = output.executionOrder;
      const executed = output.executed;
      const results = output.results;

      const orderUnique = new Set(order).size === order.length;
      const executedUnique = new Set(executed).size === executed.length;
      const resultIds = results.map(item => item?.engineId);
      const resultIdsValid = resultIds.every(id =>
        typeof id === "string" && id.length > 0
      );
      const resultIdsUnique =
        resultIdsValid && new Set(resultIds).size === resultIds.length;

      const identifiersUnique =
        orderUnique && executedUnique && resultIdsUnique;

      addCheck(checks, "engine-identifiers-unique", identifiersUnique);

      if (!identifiersUnique) {
        addIssue(issues, "DUPLICATE_OR_INVALID_ENGINE_ID",
          "Batch contains duplicate or invalid engine identifiers");
      }

      const resultOrderMatches =
        resultIds.length === order.length &&
        resultIds.every((id, index) => id === order[index]);

      addCheck(checks, "execution-order-consistency", resultOrderMatches);

      if (!resultOrderMatches) {
        addIssue(issues, "EXECUTION_ORDER_MISMATCH",
          "Batch result order does not match executionOrder");
      }

      const statusesValid = results.every(item =>
        item &&
        NEA_EXECUTION_STATUSES.includes(item.status)
      );

      addCheck(checks, "engine-result-statuses", statusesValid);

      if (!statusesValid) {
        addIssue(issues, "INVALID_ENGINE_STATUS",
          "Batch contains an invalid engine execution status");
      }

      const succeededIds = results
        .filter(item => item?.status === "SUCCEEDED")
        .map(item => item.engineId);

      const executedMatches =
        executed.length === succeededIds.length &&
        executed.every((id, index) => id === succeededIds[index]);

      addCheck(checks, "executed-list-consistency", executedMatches);

      if (!executedMatches) {
        addIssue(issues, "EXECUTED_LIST_MISMATCH",
          "Executed list does not match successful engine results");
      }

      if (input.expectedExecutionOrder !== undefined) {
        const expected = input.expectedExecutionOrder;
        const matches = Array.isArray(expected) &&
          expected.length === order.length &&
          expected.every((id, index) => id === order[index]);

        addCheck(checks, "expected-execution-order", matches);

        if (!matches) {
          addIssue(issues, "EXPECTED_ORDER_MISMATCH",
            "Actual execution order differs from expected order");
        }
      }

      const hasUnsuccessful = results.some(item =>
        item && ["FAILED", "SKIPPED", "CANCELLED"].includes(item.status)
      );

      const aggregateStatusValid = hasUnsuccessful
        ? result.status === "FAILED"
        : result.status === "SUCCEEDED";

      addCheck(checks, "aggregate-status-consistency",
        aggregateStatusValid);

      if (!aggregateStatusValid) {
        addIssue(issues, "AGGREGATE_STATUS_MISMATCH",
          "Aggregate status contradicts engine result statuses");
      }
    }
  }

  const evidenceCount = countEvidence(result);
  addCheck(checks, "evidence-presence", evidenceCount > 0,
    evidenceCount > 0
      ? `${evidenceCount} evidence item(s) supplied; authenticity not established`
      : "No evidence items supplied");

  if (evidenceCount === 0) {
    addIssue(issues, "EVIDENCE_MISSING",
      "Structural checks passed, but no evidence was supplied",
      "warning");
  }

  if (result.status !== "SUCCEEDED") {
    addIssue(issues, "EXECUTION_NOT_SUCCEEDED",
      `Execution status is ${result.status}`);
  }

  const hasErrors = issues.some(issue => issue.severity === "error");

  let decision;
  let summary;

  if (hasErrors || result.status !== "SUCCEEDED") {
    decision = "REJECTED";
    summary = "Execution result failed one or more verification checks";
  } else if (evidenceCount === 0) {
    decision = "INDETERMINATE";
    summary = "Structural checks passed, but evidence is missing";
  } else {
    decision = "VERIFIED";
    summary = "Structural checks passed and evidence is present; authenticity is not established";
  }

  return makeReport({
    decision,
    checks,
    issues,
    evidenceCount,
    summary
  });
}
