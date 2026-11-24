import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign
} from "node:crypto";

import {
  createAuthorizationVerifier
} from "../tools/nea/core/authorization-verifier.mjs";

const NOW = "2026-11-21T03:30:00.000Z";

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

function createFixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const unsignedRecord = {
    schemaVersion: "1.0.0",
    approvalId: "approval-test-001",
    issuer: "noctra-test-authority",
    subject: "test-operator",
    issuedAt: "2026-11-21T03:00:00.000Z",
    expiresAt: "2026-11-21T04:00:00.000Z",
    engineId: "security.audit",
    operation: "apply",
    target: {
      projectRoot: "/authorized/project"
    },
    scope: {
      actions: ["apply"],
      resources: ["src/example.mjs"]
    },
    policyVersion: "1.0.0",
    ...overrides
  };

  const signature = sign(
    null,
    Buffer.from(canonicalize(unsignedRecord)),
    privateKey
  ).toString("base64");

  const record = {
    ...unsignedRecord,
    integrityProof: {
      algorithm: "Ed25519",
      keyId: "test-key-01",
      signature
    }
  };

  const trustedIssuers = new Map([
    [
      "noctra-test-authority",
      new Map([["test-key-01", publicKey]])
    ]
  ]);

  const verifier = createAuthorizationVerifier({
    trustedIssuers,
    isRevoked: async () => false,
    clock: () => new Date(NOW)
  });

  const context = {
    engineId: "security.audit",
    operation: "apply",
    target: {
      projectRoot: "/authorized/project"
    },
    actions: ["apply"],
    resources: ["src/example.mjs"],
    policyVersion: "1.0.0"
  };

  return {
    record,
    verifier,
    context,
    publicKey,
    privateKey
  };
}

test("accepts a valid Ed25519 authorization record", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, true);
  assert.equal(result.approvalId, record.approvalId);
});

test("rejects an unknown issuer", async () => {
  const { record, verifier, context } = createFixture();

  record.issuer = "unknown-authority";

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects an unknown signing key", async () => {
  const { record, verifier, context } = createFixture();

  record.integrityProof.keyId = "unknown-key";

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects a modified record with an invalid signature", async () => {
  const { record, verifier, context } = createFixture();

  record.subject = "modified-operator";

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects an expired authorization", async () => {
  const { record, verifier, context } = createFixture({
    expiresAt: "2026-11-21T03:20:00.000Z"
  });

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects an authorization that is not yet valid", async () => {
  const { record, verifier, context } = createFixture({
    issuedAt: "2026-11-21T03:45:00.000Z"
  });

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects a revoked approval", async () => {
  const { record, context, publicKey } = createFixture();

  const verifier = createAuthorizationVerifier({
    trustedIssuers: new Map([
      [
        "noctra-test-authority",
        new Map([["test-key-01", publicKey]])
      ]
    ]),
    isRevoked: async approvalId =>
      approvalId === record.approvalId,
    clock: () => new Date(NOW)
  });

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects a different engine binding", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, {
    ...context,
    engineId: "wallet.transfer"
  });

  assert.equal(result.valid, false);
});

test("rejects a different operation binding", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, {
    ...context,
    operation: "delete"
  });

  assert.equal(result.valid, false);
});

test("rejects a different target binding", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, {
    ...context,
    target: {
      projectRoot: "/another/project"
    }
  });

  assert.equal(result.valid, false);
});

test("rejects an action outside the approved scope", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, {
    ...context,
    actions: ["delete"]
  });

  assert.equal(result.valid, false);
});

test("rejects a resource outside the approved scope", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, {
    ...context,
    resources: ["src/unauthorized.mjs"]
  });

  assert.equal(result.valid, false);
});

test("rejects a different policy version", async () => {
  const { record, verifier, context } = createFixture();

  const result = await verifier.verify(record, {
    ...context,
    policyVersion: "2.0.0"
  });

  assert.equal(result.valid, false);
});

test("fails closed when revocation checking fails", async () => {
  const { record, context, publicKey } = createFixture();

  const verifier = createAuthorizationVerifier({
    trustedIssuers: new Map([
      [
        "noctra-test-authority",
        new Map([["test-key-01", publicKey]])
      ]
    ]),
    isRevoked: async () => {
      throw new Error("Revocation service unavailable");
    },
    clock: () => new Date(NOW)
  });

  const result = await verifier.verify(record, context);

  assert.equal(result.valid, false);
});

test("rejects missing trust configuration", () => {
  assert.throws(() => {
    createAuthorizationVerifier({
      isRevoked: async () => false,
      clock: () => new Date(NOW)
    });
  });
});

test("rejects missing revocation checker", () => {
  assert.throws(() => {
    createAuthorizationVerifier({
      trustedIssuers: new Map(),
      clock: () => new Date(NOW)
    });
  });
});
