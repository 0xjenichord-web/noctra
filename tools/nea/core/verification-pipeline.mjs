import {
  verifyExecutionResult
} from "./verification.mjs";

export function createVerificationPipeline({
  orchestrator
} = {}) {
  if (!orchestrator ||
      typeof orchestrator.execute !== "function") {
    throw new TypeError("A compatible NEA orchestrator is required.");
  }

  async function execute(input) {
    // Exactly one orchestration call. Verification never re-runs engines.
    const executionResult = await orchestrator.execute(input);

    const verification = verifyExecutionResult({
      result: executionResult,
      expectedRequestId: input.requestId,
      expectedEngineId: input.engineId,
      ...(Array.isArray(input.expectedExecutionOrder)
        ? { expectedExecutionOrder: input.expectedExecutionOrder }
        : {})
    });

    // Preserve the exact original ExecutionResult object.
    return Object.freeze({
      executionResult,
      verification
    });
  }

  return Object.freeze({ execute });
}
