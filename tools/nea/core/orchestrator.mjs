import {
  createExecutionRequest,
  createExecutionResult
} from "./contracts.mjs";

const WRITE_PERMISSIONS = new Set([
  "audit:write",
  "project:write"
]);

function requireDependencies(registry, engineId) {
  const validation = registry.validateDependencies();

  if (!validation.valid) {
    throw new Error(
      "Invalid engine dependency graph: " +
      validation.errors.join("; ")
    );
  }

  const selected = new Set();

  function collect(id) {
    if (selected.has(id)) return;

    const engine = registry.get(id);

    if (!engine) {
      throw new Error("Unknown NEA engine: " + id);
    }

    selected.add(id);

    for (const dependency of engine.metadata.dependencies ?? []) {
      collect(dependency);
    }
  }

  collect(engineId);

  return validation.executionOrder.filter(id => selected.has(id));
}

function hasWritePermission(engine) {
  const permissions = engine.metadata.permissions ?? [];

  return permissions.some(permission =>
    WRITE_PERMISSIONS.has(permission)
  );
}

function makeResult({
  request,
  status,
  startedAt,
  output = null,
  errors = [],
  metadata = {}
}) {
  return createExecutionResult({
    requestId: request.requestId,
    engineId: request.engineId,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    output,
    findings: [],
    errors,
    evidence: [],
    metadata
  });
}

export function createUniversalOrchestrator({
  registry,
  legacyRegistry
} = {}) {
  if (!registry ||
      typeof registry.get !== "function" ||
      typeof registry.validateDependencies !== "function") {
    throw new TypeError("A compatible NEA registry is required.");
  }

  if (!legacyRegistry ||
      typeof legacyRegistry.execute !== "function" ||
      typeof legacyRegistry.getPermissionStatus !== "function") {
    throw new TypeError("A permission-aware legacy registry is required.");
  }

  async function execute(input) {
    const request = createExecutionRequest(input);
    const startedAt = new Date().toISOString();

    const target = registry.get(request.engineId);

    if (!target) {
      return makeResult({
        request,
        status: "FAILED",
        startedAt,
        errors: ["Unknown NEA engine: " + request.engineId]
      });
    }

    let executionOrder;

    try {
      executionOrder = requireDependencies(registry, request.engineId);
    } catch (error) {
      return makeResult({
        request,
        status: "FAILED",
        startedAt,
        errors: [error.message]
      });
    }

    const engines = executionOrder.map(id => registry.get(id));

    // Preflight every engine before executing the first one.
    for (const engine of engines) {
      if (!engine.enabled) {
        return makeResult({
          request,
          status: "FAILED",
          startedAt,
          errors: ["Engine disabled: " + engine.id],
          metadata: { executionOrder }
        });
      }

      const permission = legacyRegistry.getPermissionStatus(engine.id);

      if (!permission) {
        return makeResult({
          request,
          status: "FAILED",
          startedAt,
          errors: ["Legacy permission status unavailable: " + engine.id],
          metadata: { executionOrder }
        });
      }

      if (permission.authorized !== true) {
        return makeResult({
          request,
          status: "FAILED",
          startedAt,
          errors: [
            "Permission denied for " + engine.id +
            ": " + (permission.missingPermissions ?? []).join(", ")
          ],
          metadata: { executionOrder }
        });
      }

      if (hasWritePermission(engine) &&
          engine.executionMode !== "controlled-write") {
        return makeResult({
          request,
          status: "FAILED",
          startedAt,
          errors: [
            "Engine execution mode conflicts with write permissions: " +
            engine.id
          ],
          metadata: { executionOrder }
        });
      }

      const requiresControlledWrite =
        engine.executionMode === "controlled-write" ||
        hasWritePermission(engine);

      if (requiresControlledWrite &&
          request.mode !== "controlled-write") {
        return makeResult({
          request,
          status: "FAILED",
          startedAt,
          errors: [
            "Controlled-write authorization required for engine: " +
            engine.id
          ],
          metadata: { executionOrder }
        });
      }
    }

    const results = [];
    const resultById = new Map();

    for (const engineId of executionOrder) {
      const engine = registry.get(engineId);
      const dependencies = engine.metadata.dependencies ?? [];

      const blockedBy = dependencies.filter(dependency => {
        return resultById.get(dependency)?.status !== "SUCCEEDED";
      });

      if (blockedBy.length > 0) {
        const skipped = {
          engineId,
          status: "SKIPPED",
          output: null,
          errors: [
            "Dependency did not succeed: " + blockedBy.join(", ")
          ],
          blockedBy
        };

        results.push(skipped);
        resultById.set(engineId, skipped);
        continue;
      }

      const engineStartedAt = new Date().toISOString();

      try {
        const legacyOutput = await legacyRegistry.execute(engineId, {
          input: request.input,
          nea: {
            contractVersion: request.contractVersion,
            requestId: request.requestId,
            correlationId: request.correlationId,
            operation: request.operation,
            mode: engine.executionMode ?? "read-only",
            authorization:
              engine.executionMode === "controlled-write"
                ? request.authorization
                : null
          }
        });

        if (legacyOutput?.exitCode !== undefined &&
            legacyOutput.exitCode !== 0) {
          throw new Error(
            "Engine exited with code " + legacyOutput.exitCode
          );
        }

        const succeeded = {
          engineId,
          status: "SUCCEEDED",
          startedAt: engineStartedAt,
          finishedAt: new Date().toISOString(),
          output: legacyOutput ?? null,
          errors: []
        };

        results.push(succeeded);
        resultById.set(engineId, succeeded);
      } catch (error) {
        const failed = {
          engineId,
          status: "FAILED",
          startedAt: engineStartedAt,
          finishedAt: new Date().toISOString(),
          output: null,
          errors: [error.message]
        };

        results.push(failed);
        resultById.set(engineId, failed);
      }
    }

    const failed = results.some(item =>
      item.status === "FAILED" || item.status === "SKIPPED"
    );

    return makeResult({
      request,
      status: failed ? "FAILED" : "SUCCEEDED",
      startedAt,
      output: {
        executionOrder,
        executed: results.filter(item =>
          item.status === "SUCCEEDED"
        ).map(item => item.engineId),
        results
      },
      errors: results.flatMap(item =>
        item.errors.map(message => ({
          engineId: item.engineId,
          message
        }))
      ),
      metadata: {
        executionMode: request.mode,
        totalEngines: executionOrder.length,
        succeeded: results.filter(item =>
          item.status === "SUCCEEDED"
        ).length,
        failed: results.filter(item =>
          item.status === "FAILED"
        ).length,
        skipped: results.filter(item =>
          item.status === "SKIPPED"
        ).length
      }
    });
  }

  return Object.freeze({ execute });
}
