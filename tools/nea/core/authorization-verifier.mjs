import { verify as verifySignature } from "node:crypto";

const SCHEMA_VERSION = "1.0.0";
const SIGNATURE_ALGORITHM = "Ed25519";

function invalid(reason) {
  return Object.freeze({
    valid: false,
    reason
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype;
}

function assertSafeData(value, ancestors = new WeakSet()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite number");
    }

    return;
  }

  if (typeof value !== "object") {
    throw new Error("Unsupported authorization data");
  }

  if (ancestors.has(value)) {
    throw new Error("Circular authorization data");
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new Error("Unsupported authorization object");
  }

  ancestors.add(value);

  try {
    const keys = Reflect.ownKeys(value);

    if (Array.isArray(value)) {
      for (const key of keys) {
        if (key === "length") continue;

        if (
          typeof key !== "string" ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          throw new Error("Invalid array property");
        }
      }

      if (keys.length !== value.length + 1) {
        throw new Error("Sparse authorization array");
      }

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index)
        );

        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        ) {
          throw new Error("Invalid array element");
        }

        assertSafeData(descriptor.value, ancestors);
      }

      return;
    }

    for (const key of keys) {
      if (typeof key !== "string") {
        throw new Error("Symbol authorization property");
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new Error("Invalid authorization property");
      }

      assertSafeData(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();

    return `{${keys.map(key =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")}}`;
  }

  return JSON.stringify(value);
}

function requireNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(requireNonEmptyString) &&
    new Set(value).size === value.length
  );
}

function parseTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }

  const milliseconds = Date.parse(value);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return null;
  }

  return milliseconds;
}

function getTrustedKey(trustedIssuers, issuer, keyId) {
  const issuerKeys = trustedIssuers.get(issuer);

  if (!(issuerKeys instanceof Map)) {
    return null;
  }

  return issuerKeys.get(keyId) ?? null;
}

export function createAuthorizationVerifier({
  trustedIssuers,
  isRevoked,
  clock
} = {}) {
  if (
    !(trustedIssuers instanceof Map) ||
    trustedIssuers.size === 0
  ) {
    throw new Error("Authorization trust store is required");
  }

  if (typeof isRevoked !== "function") {
    throw new Error("Authorization revocation checker is required");
  }

  if (typeof clock !== "function") {
    throw new Error("Authorization clock is required");
  }

  async function verify(record, context) {
    try {
      assertSafeData(record);
      assertSafeData(context);

      if (!isPlainObject(record) || !isPlainObject(context)) {
        return invalid("INVALID_RECORD_OR_CONTEXT");
      }

      if (record.schemaVersion !== SCHEMA_VERSION) {
        return invalid("UNSUPPORTED_SCHEMA_VERSION");
      }

      if (
        !requireNonEmptyString(record.approvalId) ||
        !requireNonEmptyString(record.issuer) ||
        !requireNonEmptyString(record.subject) ||
        !requireNonEmptyString(record.engineId) ||
        !requireNonEmptyString(record.operation) ||
        !requireNonEmptyString(record.policyVersion)
      ) {
        return invalid("INVALID_REQUIRED_FIELDS");
      }

      const proof = record.integrityProof;

      if (
        !isPlainObject(proof) ||
        proof.algorithm !== SIGNATURE_ALGORITHM ||
        !requireNonEmptyString(proof.keyId) ||
        !requireNonEmptyString(proof.signature)
      ) {
        return invalid("INVALID_INTEGRITY_PROOF");
      }

      const publicKey = getTrustedKey(
        trustedIssuers,
        record.issuer,
        proof.keyId
      );

      if (!publicKey) {
        return invalid("UNTRUSTED_ISSUER_OR_KEY");
      }

      const issuedAt = parseTimestamp(record.issuedAt);
      const expiresAt = parseTimestamp(record.expiresAt);

      if (issuedAt === null || expiresAt === null) {
        return invalid("INVALID_APPROVAL_TIMESTAMP");
      }

      if (expiresAt <= issuedAt) {
        return invalid("INVALID_APPROVAL_LIFETIME");
      }

      const currentTime = clock();

      const now = currentTime instanceof Date
        ? currentTime.getTime()
        : NaN;

      if (!Number.isFinite(now)) {
        return invalid("INVALID_VERIFIER_CLOCK");
      }

      if (issuedAt > now) {
        return invalid("APPROVAL_NOT_YET_VALID");
      }

      if (expiresAt <= now) {
        return invalid("APPROVAL_EXPIRED");
      }

      const unsignedRecord = {};

      for (const key of Object.keys(record)) {
        if (key !== "integrityProof") {
          Object.defineProperty(unsignedRecord, key, {
            value: record[key],
            enumerable: true,
            writable: false,
            configurable: false
          });
        }
      }

      let signatureBytes;

      try {
        signatureBytes = Buffer.from(proof.signature, "base64");

        if (
          signatureBytes.length === 0 ||
          signatureBytes.toString("base64") !== proof.signature
        ) {
          return invalid("INVALID_SIGNATURE_ENCODING");
        }
      } catch {
        return invalid("INVALID_SIGNATURE_ENCODING");
      }

      const signatureValid = verifySignature(
        null,
        Buffer.from(canonicalize(unsignedRecord)),
        publicKey,
        signatureBytes
      );

      if (!signatureValid) {
        return invalid("INVALID_SIGNATURE");
      }

      if (
        record.engineId !== context.engineId ||
        record.operation !== context.operation
      ) {
        return invalid("ENGINE_OR_OPERATION_MISMATCH");
      }

      if (
        canonicalize(record.target) !== canonicalize(context.target)
      ) {
        return invalid("TARGET_MISMATCH");
      }

      if (
        record.policyVersion !== context.policyVersion
      ) {
        return invalid("POLICY_VERSION_MISMATCH");
      }

      if (
        !isPlainObject(record.scope) ||
        !requireStringArray(record.scope.actions) ||
        !requireStringArray(record.scope.resources) ||
        !requireStringArray(context.actions) ||
        !requireStringArray(context.resources)
      ) {
        return invalid("INVALID_SCOPE");
      }

      const approvedActions = new Set(record.scope.actions);
      const approvedResources = new Set(record.scope.resources);

      if (!context.actions.every(action => approvedActions.has(action))) {
        return invalid("ACTION_OUTSIDE_SCOPE");
      }

      if (
        !context.resources.every(resource =>
          approvedResources.has(resource)
        )
      ) {
        return invalid("RESOURCE_OUTSIDE_SCOPE");
      }

      let revoked;

      try {
        revoked = await isRevoked(record.approvalId);
      } catch {
        return invalid("REVOCATION_CHECK_UNAVAILABLE");
      }

      if (typeof revoked !== "boolean") {
        return invalid("INVALID_REVOCATION_RESPONSE");
      }

      if (revoked) {
        return invalid("APPROVAL_REVOKED");
      }

      return Object.freeze({
        valid: true,
        approvalId: record.approvalId,
        issuer: record.issuer,
        subject: record.subject,
        engineId: record.engineId,
        operation: record.operation,
        policyVersion: record.policyVersion
      });
    } catch {
      return invalid("AUTHORIZATION_VERIFICATION_FAILED");
    }
  }

  return Object.freeze({ verify });
}
