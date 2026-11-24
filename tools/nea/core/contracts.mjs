const ENGINE_ID = /^[a-z0-9][a-z0-9._-]*$/;

const EXECUTION_STATUSES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED"
]);

const EXECUTION_MODES = Object.freeze([
  "read-only",
  "controlled-write"
]);

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(field + " must be a non-empty string");
  }

  return value.trim();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype;
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    throw new TypeError(field + " must be a plain object");
  }

  return value;
}

/**
 * Accepts only JSON-like data.
 * Creates a defensive copy and deeply freezes the copy.
 * Circular references, accessors and unsupported object types are rejected.
 */
function cloneAndFreezeData(value, field, ancestors = new WeakSet()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(field + " must not contain non-finite numbers");
    }

    return value;
  }

  if (typeof value !== "object") {
    throw new TypeError(field + " contains an unsupported data type");
  }

  if (ancestors.has(value)) {
    throw new TypeError(field + " must not contain circular references");
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);

      for (const key of keys) {
        if (key === "length") {
          continue;
        }

        if (
          typeof key !== "string" ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          throw new TypeError(
            field + " contains unsupported array properties"
          );
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          throw new TypeError(
            field + " must not contain accessor or hidden properties"
          );
        }
      }

      const copy = [];

      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(field + " must not contain sparse arrays");
        }

        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index)
        );

        copy.push(
          cloneAndFreezeData(
            descriptor.value,
            field,
            ancestors
          )
        );
      }

      return Object.freeze(copy);
    }

    if (!isPlainObject(value)) {
      throw new TypeError(
        field + " contains an unsupported object type"
      );
    }

    const copy = {};

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(field + " must not contain symbol keys");
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        throw new TypeError(
          field + " must not contain accessor or hidden properties"
        );
      }

      Object.defineProperty(copy, key, {
        value: cloneAndFreezeData(
          descriptor.value,
          field,
          ancestors
        ),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }

    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function freezeRecord(value, field = "record") {
  return cloneAndFreezeData(
    requireObject(value, field),
    field
  );
}

function requireStringArray(value, field) {
  if (
    !Array.isArray(value) ||
    value.some(item => typeof item !== "string" || !item.trim())
  ) {
    throw new TypeError(
      field + " must be an array of non-empty strings"
    );
  }

  return Object.freeze([
    ...new Set(value.map(item => item.trim()))
  ]);
}

function requireTimestamp(value, field) {
  const timestamp = value ?? new Date().toISOString();

  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new TypeError(
      field + " must be a valid ISO date string"
    );
  }

  return timestamp;
}

/**
 * Universal identity and capability contract for every NOCTRA engine.
 * Domain and capabilities are extensible; no engine-specific assumptions.
 */
export function createEngineDescriptor(input) {
  requireObject(input, "descriptor");

  const id = requireString(input.id, "id");

  if (!ENGINE_ID.test(id)) {
    throw new TypeError("id contains unsupported characters");
  }

  const executionMode = input.executionMode ?? "read-only";

  if (!EXECUTION_MODES.includes(executionMode)) {
    throw new TypeError("Unsupported executionMode");
  }

  const descriptor = {
    contractVersion: "1.0.0",
    id,
    name: requireString(input.name, "name"),
    version: requireString(input.version, "version"),
    domain: requireString(input.domain, "domain"),
    capabilities: requireStringArray(input.capabilities, "capabilities"),
    inputContract: requireString(input.inputContract, "inputContract"),
    outputContract: requireString(input.outputContract, "outputContract"),
    executionMode,
    enabled: input.enabled ?? true,
    metadata: freezeRecord(input.metadata ?? {}, "metadata")
  };

  if (typeof descriptor.enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }

  return Object.freeze(descriptor);
}

/**
 * Standard request envelope shared by all engines.
 */
function validateAuthorizationRecord(
  value,
  engineId,
  operation
) {
  const field = "authorization record";

  try {
    const record = freezeRecord(
      requireObject(value, field),
      field
    );

    if (record.approved === false) {
      throw new Error("Controlled write requires explicit approval");
    }

    if (record.schemaVersion !== "1.0.0") {
      throw new Error("unsupported schema version");
    }

    for (const key of [
      "approvalId", "issuer", "subject",
      "engineId", "operation", "policyVersion"
    ]) {
      requireString(record[key], field + "." + key);
    }

    if (record.engineId !== engineId || record.operation !== operation) {
      throw new Error("engine or operation binding mismatch");
    }

    const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    function parseTimestamp(value) {
      if (typeof value !== "string" || !pattern.test(value)) {
        throw new Error("invalid UTC timestamp");
      }

      const time = Date.parse(value);

      if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
        throw new Error("invalid UTC timestamp");
      }

      return time;
    }

    const issuedAt = parseTimestamp(record.issuedAt);
    const expiresAt = parseTimestamp(record.expiresAt);

    if (expiresAt <= issuedAt) {
      throw new Error("expiry must follow issue time");
    }

    const target = requireObject(record.target, field + ".target");

    if (Object.keys(target).length === 0) {
      throw new Error("target must not be empty");
    }

    const scope = requireObject(record.scope, field + ".scope");
    const actions = requireStringArray(scope.actions, field + ".scope.actions");
    const resources = requireStringArray(scope.resources, field + ".scope.resources");

    if (
      actions.length === 0 ||
      resources.length === 0 ||
      actions.length !== scope.actions.length ||
      resources.length !== scope.resources.length ||
      !actions.includes(record.operation)
    ) {
      throw new Error("authorization scope mismatch");
    }

    const proof = requireObject(
      record.integrityProof,
      field + ".integrityProof"
    );

    if (proof.algorithm !== "Ed25519") {
      throw new Error("unsupported integrity proof algorithm");
    }

    requireString(proof.keyId, field + ".integrityProof.keyId");
    requireString(proof.signature, field + ".integrityProof.signature");

    return record;
  } catch (error) {
    throw new TypeError("Invalid authorization record: " + error.message);
  }
}

export function createExecutionRequest(input) {
  requireObject(input, "request");

  const mode = input.mode ?? "read-only";

  if (!EXECUTION_MODES.includes(mode)) {
    throw new TypeError("Unsupported execution mode");
  }

  let authorization = null;

  if (mode === "controlled-write") {
    authorization = validateAuthorizationRecord(
      input.authorization,
      input.engineId,
      input.operation
    );
  }

  return Object.freeze({
    contractVersion: "1.0.0",
    requestId: requireString(input.requestId, "requestId"),
    engineId: requireString(input.engineId, "engineId"),
    operation: requireString(input.operation, "operation"),
    mode,
    input: freezeRecord(
      requireObject(input.input, "input"),
      "input"
    ),
    requestedAt: requireTimestamp(input.requestedAt, "requestedAt"),
    correlationId: input.correlationId == null
      ? null
      : requireString(input.correlationId, "correlationId"),
    authorization,
    metadata: freezeRecord(input.metadata ?? {}, "metadata")
  });
}

/**
 * Standard result envelope for success, failure and skipped execution.
 */
export function createExecutionResult(input) {
  requireObject(input, "result");

  const status = requireString(input.status, "status");

  if (!EXECUTION_STATUSES.includes(status)) {
    throw new TypeError("Unsupported execution status");
  }

  const startedAt = requireTimestamp(input.startedAt, "startedAt");
  const finishedAt = requireTimestamp(input.finishedAt, "finishedAt");

  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new RangeError("finishedAt cannot precede startedAt");
  }

  const findings = input.findings ?? [];
  const errors = input.errors ?? [];
  const evidence = input.evidence ?? [];

  if (![findings, errors, evidence].every(Array.isArray)) {
    throw new TypeError(
      "findings, errors and evidence must be arrays"
    );
  }

  return Object.freeze({
    contractVersion: "1.0.0",
    requestId: requireString(input.requestId, "requestId"),
    engineId: requireString(input.engineId, "engineId"),
    status,
    startedAt,
    finishedAt,
    output: input.output == null
      ? null
      : cloneAndFreezeData(input.output, "output"),
    findings: cloneAndFreezeData(findings, "findings"),
    errors: cloneAndFreezeData(errors, "errors"),
    evidence: cloneAndFreezeData(evidence, "evidence"),
    metadata: freezeRecord(input.metadata ?? {}, "metadata")
  });
}

export function validateEngineDescriptor(input) {
  try {
    createEngineDescriptor(input);

    return {
      valid: true,
      errors: []
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error.message]
    };
  }
}

export function validateExecutionRequest(input) {
  try {
    createExecutionRequest(input);

    return {
      valid: true,
      errors: []
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error.message]
    };
  }
}

export function validateExecutionResult(input) {
  try {
    createExecutionResult(input);

    return {
      valid: true,
      errors: []
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error.message]
    };
  }
}

export const NEA_CONTRACT_VERSION = "1.0.0";

export const NEA_EXECUTION_STATUSES = EXECUTION_STATUSES;
export const NEA_EXECUTION_MODES = EXECUTION_MODES;
