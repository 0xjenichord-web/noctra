import test from "node:test";
import assert from "node:assert/strict";

import {
  createEngineDescriptor,
  createExecutionRequest,
  createExecutionResult,
  validateEngineDescriptor,
  validateExecutionRequest,
  validateExecutionResult,
  NEA_CONTRACT_VERSION
} from "../tools/nea/core/contracts.mjs";

const descriptor = {
  id: "example.audit",
  name: "Example Audit Engine",
  version: "1.0.0",
  domain: "security",
  capabilities: ["inspect", "analyze"],
  inputContract: "universal.input.v1",
  outputContract: "universal.result.v1"
};

test("publishes the initial NEA contract version", () => {
  assert.equal(NEA_CONTRACT_VERSION, "1.0.0");
});

test("creates a universal engine descriptor", () => {
  const result = createEngineDescriptor(descriptor);
  assert.equal(result.id, descriptor.id);
  assert.equal(result.executionMode, "read-only");
  assert.equal(Object.isFrozen(result), true);
});

test("rejects invalid engine identifiers", () => {
  assert.throws(
    () => createEngineDescriptor({ ...descriptor, id: "Invalid ID" }),
    /unsupported characters/
  );
});

test("rejects unsupported execution modes", () => {
  assert.throws(
    () => createEngineDescriptor({ ...descriptor, executionMode: "unsafe" }),
    /executionMode/
  );
});

test("creates a read-only execution request by default", () => {
  const result = createExecutionRequest({
    requestId: "req-001",
    engineId: descriptor.id,
    operation: "audit",
    input: { target: "project" }
  });
  assert.equal(result.mode, "read-only");
  assert.equal(result.authorization, null);
});

test("rejects controlled write without explicit approval", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-002",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: { approved: false }
  }), /explicit approval/);
});

test("accepts controlled write with structured authorization", () => {
  const result = createExecutionRequest({
    requestId: "req-003",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord()
  });
  assert.equal(result.mode, "controlled-write");
});

test("creates a successful execution result", () => {
  const result = createExecutionResult({
    requestId: "req-001",
    engineId: descriptor.id,
    status: "SUCCEEDED",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    output: { findingsCount: 0 }
  });
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.output.findingsCount, 0);
});

test("rejects invalid result status", () => {
  assert.throws(() => createExecutionResult({
    requestId: "req-001",
    engineId: descriptor.id,
    status: "UNKNOWN"
  }), /execution status/);
});

test("rejects a result whose finish precedes its start", () => {
  assert.throws(() => createExecutionResult({
    requestId: "req-001",
    engineId: descriptor.id,
    status: "FAILED",
    startedAt: "2026-01-02T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z"
  }), /cannot precede/);
});

test("validation helpers return structured errors", () => {
  assert.equal(validateEngineDescriptor(descriptor).valid, true);
  assert.equal(validateExecutionRequest({
    requestId: "req-001",
    engineId: descriptor.id,
    operation: "audit",
    input: {}
  }).valid, true);
  assert.equal(validateExecutionResult({
    requestId: "req-001",
    engineId: descriptor.id,
    status: "INVALID"
  }).valid, false);
});

test("descriptor metadata is defensively copied and deeply frozen", () => {
  const source = {
    security: {
      rules: ["rule-a"]
    }
  };

  const result = createEngineDescriptor({
    ...descriptor,
    metadata: source
  });

  source.security.rules.push("rule-b");

  assert.deepEqual(result.metadata.security.rules, ["rule-a"]);
  assert.equal(Object.isFrozen(result.metadata), true);
  assert.equal(Object.isFrozen(result.metadata.security), true);
  assert.equal(Object.isFrozen(result.metadata.security.rules), true);
  assert.throws(() => result.metadata.security.rules.push("rule-c"), TypeError);
});

test("execution request input is defensively copied and deeply frozen", () => {
  const source = {
    target: {
      assets: ["example.test"]
    }
  };

  const result = createExecutionRequest({
    requestId: "req-immutable-001",
    engineId: descriptor.id,
    operation: "audit",
    input: source
  });

  source.target.assets.push("other.test");

  assert.deepEqual(result.input.target.assets, ["example.test"]);
  assert.equal(Object.isFrozen(result.input.target), true);
  assert.equal(Object.isFrozen(result.input.target.assets), true);
  assert.throws(() => result.input.target.assets.push("third.test"), TypeError);
});

test("controlled-write authorization is defensively copied and deeply frozen", () => {
  const authorization = makeAuthorizationRecord({
    target: {
      projectRoot: "/authorized/project",
      files: ["src/example.mjs"]
    }
  });

  const result = createExecutionRequest({
    requestId: "req-immutable-002",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization
  });

  authorization.target.files.push("src/modified.mjs");

  assert.deepEqual(
    result.authorization.target.files,
    ["src/example.mjs"]
  );
  assert.equal(Object.isFrozen(result.authorization.target), true);
  assert.equal(Object.isFrozen(result.authorization.target.files), true);
  assert.throws(() => {
    result.authorization.target.files.push("src/changed.mjs");
  }, TypeError);
});

test("execution result deeply freezes output and nested collection entries", () => {
  const source = {
    output: {
      summary: {
        count: 1
      }
    },
    finding: {
      details: {
        severity: "high"
      }
    },
    evidence: {
      metadata: {
        verified: true
      }
    }
  };

  const result = createExecutionResult({
    requestId: "req-immutable-003",
    engineId: descriptor.id,
    status: "SUCCEEDED",
    output: source.output,
    findings: [source.finding],
    evidence: [source.evidence],
    errors: [{ details: { code: "E_TEST" } }]
  });

  source.output.summary.count = 99;
  source.finding.details.severity = "low";
  source.evidence.metadata.verified = false;

  assert.equal(result.output.summary.count, 1);
  assert.equal(result.findings[0].details.severity, "high");
  assert.equal(result.evidence[0].metadata.verified, true);

  assert.equal(Object.isFrozen(result.output.summary), true);
  assert.equal(Object.isFrozen(result.findings[0].details), true);
  assert.equal(Object.isFrozen(result.evidence[0].metadata), true);
  assert.equal(Object.isFrozen(result.errors[0].details), true);

  assert.throws(() => {
    result.findings[0].details.severity = "critical";
  }, TypeError);
});

test("execution mode and status constants are immutable", async () => {
  const {
    NEA_EXECUTION_MODES,
    NEA_EXECUTION_STATUSES
  } = await import("../tools/nea/core/contracts.mjs");

  assert.equal(Object.isFrozen(NEA_EXECUTION_MODES), true);
  assert.equal(Object.isFrozen(NEA_EXECUTION_STATUSES), true);
});

test("contract rejects unsupported nested data types", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-invalid-map",
    engineId: descriptor.id,
    operation: "audit",
    input: {
      payload: new Map()
    }
  }), TypeError);

  assert.throws(() => createExecutionRequest({
    requestId: "req-invalid-date",
    engineId: descriptor.id,
    operation: "audit",
    input: {
      timestamp: new Date()
    }
  }), TypeError);
});

test("contract rejects undefined values in nested data", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-invalid-undefined",
    engineId: descriptor.id,
    operation: "audit",
    input: {
      target: undefined
    }
  }), TypeError);
});

test("contract rejects circular nested data", () => {
  const input = {};
  input.self = input;

  assert.throws(() => createExecutionRequest({
    requestId: "req-circular",
    engineId: descriptor.id,
    operation: "audit",
    input
  }), TypeError);
});

test("contract rejects custom prototype objects", () => {
  const customPrototype = { inherited: true };
  const payload = Object.create(customPrototype);
  payload.target = "example.test";

  assert.throws(() => createExecutionRequest({
    requestId: "req-custom-prototype",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }), TypeError);
});

test("contract rejects null-prototype objects", () => {
  const payload = Object.create(null);
  payload.target = "example.test";

  assert.throws(() => createExecutionRequest({
    requestId: "req-null-prototype",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }), TypeError);
});

test("contract safely preserves own __proto__ data properties", () => {
  const payload = JSON.parse(
    '{"__proto__":{"polluted":true},"target":"example.test"}'
  );

  const result = createExecutionRequest({
    requestId: "req-proto-key",
    engineId: descriptor.id,
    operation: "audit",
    input: payload
  });

  assert.equal(Object.getPrototypeOf(result.input), Object.prototype);
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.input, "__proto__"),
    true
  );
  assert.equal(result.input.__proto__.polluted, true);
  assert.equal(Object.isFrozen(result.input), true);
  assert.equal(Object.prototype.polluted, undefined);
});

test("contract rejects getters without invoking them", () => {
  let getterCalls = 0;
  const payload = {};

  Object.defineProperty(payload, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unexpected";
    }
  });

  assert.throws(() => createExecutionRequest({
    requestId: "req-getter",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }), TypeError);

  assert.equal(getterCalls, 0);
});

test("contract rejects symbol properties", () => {
  const payload = {
    target: "example.test"
  };

  payload[Symbol("hidden")] = "unexpected";

  assert.throws(() => createExecutionRequest({
    requestId: "req-symbol",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }), TypeError);
});

test("contract rejects arrays with additional properties", () => {
  const payload = ["example.test"];
  payload.extra = "unexpected";

  assert.throws(() => createExecutionRequest({
    requestId: "req-array-property",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }), TypeError);
});

test("contract rejects sparse arrays", () => {
  const payload = [];
  payload[2] = "example.test";

  assert.throws(() => createExecutionRequest({
    requestId: "req-sparse-array",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }), TypeError);
});

test("contract rejects proxies whose inspection traps throw", () => {
  const payload = new Proxy({}, {
    ownKeys() {
      throw new Error("blocked ownKeys inspection");
    }
  });

  assert.throws(() => createExecutionRequest({
    requestId: "req-proxy",
    engineId: descriptor.id,
    operation: "audit",
    input: { payload }
  }));
});

test("rejects legacy approval references as authorization proof", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-legacy-approval",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: {
      approved: true,
      reference: "legacy-approval-001"
    }
  }), /authorization record/i);
});

test("rejects incomplete structured authorization records", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-incomplete-approval",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: {
      schemaVersion: "1.0.0",
      approvalId: "approval-001",
      issuer: "noctra-local-authority"
    }
  }), /authorization record/i);
});

function makeAuthorizationRecord(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    approvalId: "approval-test-001",
    issuer: "noctra-local-authority",
    subject: "authorized-operator",
    issuedAt: "2026-11-21T03:00:00.000Z",
    expiresAt: "2026-11-21T04:00:00.000Z",
    engineId: descriptor.id,
    operation: "apply",
    target: {
      projectRoot: "/authorized/project"
    },
    scope: {
      actions: ["apply"],
      resources: ["authorized-resource"]
    },
    policyVersion: "1.0.0",
    integrityProof: {
      algorithm: "Ed25519",
      keyId: "test-key-01",
      signature: "dGVzdC1zaWduYXR1cmU="
    },
    ...overrides
  };
}

test("accepts a complete structured authorization record", () => {
  const result = createExecutionRequest({
    requestId: "req-structured-approval",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord()
  });

  assert.equal(result.mode, "controlled-write");
  assert.equal(result.authorization.approvalId, "approval-test-001");
  assert.equal(result.authorization.engineId, descriptor.id);
  assert.equal(Object.isFrozen(result.authorization), true);
  assert.equal(Object.isFrozen(result.authorization.target), true);
  assert.equal(Object.isFrozen(result.authorization.scope.actions), true);
});

test("rejects structured authorization without integrity proof", () => {
  const authorization = makeAuthorizationRecord();
  delete authorization.integrityProof;

  assert.throws(() => createExecutionRequest({
    requestId: "req-no-integrity-proof",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization
  }), /authorization record/i);
});

test("rejects invalid authorization timestamps", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-invalid-approval-time",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord({
      issuedAt: "not-a-timestamp"
    })
  }), /authorization record/i);
});

test("rejects authorization expiry before issue time", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-expired-order",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord({
      expiresAt: "2026-11-21T02:59:59.000Z"
    })
  }), /authorization record/i);
});

test("rejects authorization bound to another engine", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-wrong-approval-engine",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord({
      engineId: "another.engine"
    })
  }), /authorization record/i);
});

test("rejects authorization bound to another operation", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-wrong-approval-operation",
    engineId: descriptor.id,
    operation: "audit",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord()
  }), /authorization record/i);
});

test("rejects authorization whose scope does not include the requested operation", () => {
  assert.throws(() => createExecutionRequest({
    requestId: "req-out-of-scope-operation",
    engineId: descriptor.id,
    operation: "apply",
    mode: "controlled-write",
    input: {},
    authorization: makeAuthorizationRecord({
      scope: {
        actions: ["audit"],
        resources: ["authorized-resource"]
      }
    })
  }), /authorization record/i);
});
