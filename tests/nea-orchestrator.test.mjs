import test from "node:test";
import assert from "node:assert/strict";

import {
  createUniversalEngineRegistry
} from "../tools/nea/core/engine-registry.mjs";

import {
  createUniversalOrchestrator
} from "../tools/nea/core/orchestrator.mjs";

const TIMESTAMP = "2026-11-21T00:00:00.000Z";

function descriptor(id, options = {}) {
  return {
    id,
    name: options.name ?? id,
    version: "1.0.0",
    domain: options.domain ?? "test",
    capabilities: options.capabilities ?? ["test.execute"],
    inputContract: "test.input.v1",
    outputContract: "test.output.v1",
    executionMode: options.executionMode ?? "read-only",
    enabled: options.enabled ?? true,
    metadata: {
      permissions: options.permissions ?? [],
      dependencies: options.dependencies ?? []
    }
  };
}

function setup(definitions = [], options = {}) {
  const registry = createUniversalEngineRegistry();

  for (const definition of definitions) {
    registry.register(descriptor(definition.id, definition));
  }

  const calls = [];
  const permissionOverrides = options.permissionOverrides ?? {};
  const failures = options.failures ?? {};

  const legacyRegistry = {
    getPermissionStatus(engineId) {
      return permissionOverrides[engineId] ?? {
        engineId,
        authorized: true,
        requiredPermissions: [],
        grantedPermissions: [],
        missingPermissions: []
      };
    },

    async execute(engineId, context) {
      calls.push({ engineId, context });

      if (failures[engineId]) {
        throw new Error(failures[engineId]);
      }

      return { engineId, exitCode: 0 };
    }
  };

  return {
    registry,
    legacyRegistry,
    calls,
    orchestrator: createUniversalOrchestrator({
      registry,
      legacyRegistry
    })
  };
}

function request(engineId, overrides = {}) {
  return {
    requestId: "request-001",
    engineId,
    operation: "test.execute",
    mode: "read-only",
    input: { sample: true },
    requestedAt: TIMESTAMP,
    ...overrides
  };
}

function authorization(engineId, approvalId) {
  return {
    schemaVersion: "1.0.0",
    approvalId,
    issuer: "noctra-test-authority",
    subject: "test-operator",
    issuedAt: "2026-11-21T00:00:00.000Z",
    expiresAt: "2026-11-21T23:59:59.999Z",
    engineId,
    operation: "test.execute",
    target: {
      projectRoot: "/authorized/test-project"
    },
    scope: {
      actions: ["test.execute"],
      resources: ["test-resource"]
    },
    policyVersion: "1.0.0",
    integrityProof: {
      algorithm: "Ed25519",
      keyId: "test-key-01",
      signature: "dGVzdC1zaWduYXR1cmU="
    }
  };
}

test("executes a single engine through the legacy registry", async () => {
  const env = setup([{ id: "alpha" }]);

  const result = await env.orchestrator.execute(request("alpha"));

  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(
    env.calls.map(call => call.engineId),
    ["alpha"]
  );
  assert.deepEqual(result.output.executed, ["alpha"]);
});

test("executes dependencies before the requested engine", async () => {
  const env = setup([
    { id: "root", dependencies: ["dependency"] },
    { id: "dependency" }
  ]);

  const result = await env.orchestrator.execute(request("root"));

  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(
    env.calls.map(call => call.engineId),
    ["dependency", "root"]
  );
});

test("does not execute unrelated engines", async () => {
  const env = setup([
    { id: "alpha" },
    { id: "unrelated" }
  ]);

  await env.orchestrator.execute(request("alpha"));

  assert.deepEqual(
    env.calls.map(call => call.engineId),
    ["alpha"]
  );
});

test("rejects execution when legacy permissions are denied", async () => {
  const env = setup(
    [{ id: "alpha" }],
    {
      permissionOverrides: {
        alpha: {
          engineId: "alpha",
          authorized: false,
          missingPermissions: ["project:read"]
        }
      }
    }
  );

  const result = await env.orchestrator.execute(request("alpha"));

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
  assert.match(result.errors[0], /Permission denied/);
});

test("requires controlled-write mode for audit:write engines", async () => {
  const env = setup([
    {
      id: "writer",
      executionMode: "controlled-write",
      permissions: ["audit:write"]
    }
  ]);

  const result = await env.orchestrator.execute(request("writer"));

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
  assert.match(result.errors[0], /Controlled-write authorization required/);
});

test("requires controlled-write mode for project:write engines", async () => {
  const env = setup([
    {
      id: "builder",
      executionMode: "controlled-write",
      permissions: ["project:write"]
    }
  ]);

  const result = await env.orchestrator.execute(request("builder"));

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
});

test("allows controlled-write with explicit authorization", async () => {
  const env = setup([
    {
      id: "writer",
      executionMode: "controlled-write",
      permissions: ["audit:write"]
    }
  ]);

  const result = await env.orchestrator.execute(request("writer", {
    mode: "controlled-write",
    authorization: authorization("writer", "test-approval-001")
  }));

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(env.calls.length, 1);
  assert.equal(
    env.calls[0].context.nea.authorization.approvalId,
    "test-approval-001"
  );
});

test("skips dependent engines when a dependency fails", async () => {
  const env = setup(
    [
      { id: "dependency" },
      { id: "root", dependencies: ["dependency"] }
    ],
    {
      failures: {
        dependency: "simulated failure"
      }
    }
  );

  const result = await env.orchestrator.execute(request("root"));

  assert.equal(result.status, "FAILED");

  const dependency = result.output.results.find(
    item => item.engineId === "dependency"
  );
  const root = result.output.results.find(
    item => item.engineId === "root"
  );

  assert.equal(dependency.status, "FAILED");
  assert.equal(root.status, "SKIPPED");
  assert.deepEqual(root.blockedBy, ["dependency"]);
  assert.deepEqual(
    env.calls.map(call => call.engineId),
    ["dependency"]
  );
});

test("continues independent branches after another branch fails", async () => {
  const env = setup(
    [
      { id: "root", dependencies: ["branch-a", "branch-b"] },
      { id: "branch-a" },
      { id: "branch-b" }
    ],
    {
      failures: {
        "branch-a": "branch failure"
      }
    }
  );

  const result = await env.orchestrator.execute(request("root"));

  assert.equal(result.status, "FAILED");
  assert.deepEqual(
    env.calls.map(call => call.engineId),
    ["branch-a", "branch-b"]
  );

  const branchB = result.output.results.find(
    item => item.engineId === "branch-b"
  );
  const root = result.output.results.find(
    item => item.engineId === "root"
  );

  assert.equal(branchB.status, "SUCCEEDED");
  assert.equal(root.status, "SKIPPED");
});

test("rejects malformed execution requests", async () => {
  const env = setup([{ id: "alpha" }]);

  await assert.rejects(
    env.orchestrator.execute({
      engineId: "alpha"
    }),
    /requestId/
  );

  assert.equal(env.calls.length, 0);
});

test("returns the standard NEA result envelope", async () => {
  const env = setup([{ id: "alpha" }]);

  const result = await env.orchestrator.execute(request("alpha"));

  assert.equal(result.contractVersion, "1.0.0");
  assert.equal(result.requestId, "request-001");
  assert.equal(result.engineId, "alpha");
  assert.equal(result.status, "SUCCEEDED");
  assert.ok(Array.isArray(result.findings));
  assert.ok(Array.isArray(result.errors));
  assert.ok(Array.isArray(result.evidence));
  assert.ok(result.startedAt);
  assert.ok(result.finishedAt);
});

test("returns FAILED for an unknown engine", async () => {
  const env = setup([{ id: "alpha" }]);

  const result = await env.orchestrator.execute(request("missing"));

  assert.equal(result.status, "FAILED");
  assert.match(result.errors[0], /Unknown NEA engine/);
  assert.equal(env.calls.length, 0);
});

test("preflights the complete dependency chain before execution", async () => {
  const env = setup(
    [
      { id: "dependency" },
      { id: "root", dependencies: ["dependency"] }
    ],
    {
      permissionOverrides: {
        root: {
          engineId: "root",
          authorized: false,
          missingPermissions: ["project:read"]
        }
      }
    }
  );

  const result = await env.orchestrator.execute(request("root"));

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
});

test("maps legacy write permissions to controlled-write descriptors", () => {
  const registry = createUniversalEngineRegistry();

  const legacyRegistry = {
    list() {
      return [
        {
          id: "read-engine",
          name: "Read Engine",
          version: "1.0.0",
          domain: "test",
          capabilities: ["read"],
          permissions: ["project:read"]
        },
        {
          id: "audit-engine",
          name: "Audit Engine",
          version: "1.0.0",
          domain: "test",
          capabilities: ["audit"],
          permissions: ["audit:write"]
        },
        {
          id: "build-engine",
          name: "Build Engine",
          version: "1.0.0",
          domain: "test",
          capabilities: ["build"],
          permissions: ["project:write"]
        }
      ];
    }
  };

  registry.registerLegacyEngines(legacyRegistry);

  assert.equal(
    registry.get("read-engine").executionMode,
    "read-only"
  );
  assert.equal(
    registry.get("audit-engine").executionMode,
    "controlled-write"
  );
  assert.equal(
    registry.get("build-engine").executionMode,
    "controlled-write"
  );
});

test("rejects read-only requests for controlled-write descriptors without write permissions", async () => {
  const env = setup([
    {
      id: "descriptor-writer",
      executionMode: "controlled-write",
      permissions: []
    }
  ]);

  const result = await env.orchestrator.execute(
    request("descriptor-writer")
  );

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
  assert.match(
    result.errors[0],
    /Controlled-write authorization required/
  );
});

test("preflights controlled-write descriptors throughout the dependency chain", async () => {
  const env = setup([
    {
      id: "writer-dependency",
      executionMode: "controlled-write",
      permissions: []
    },
    {
      id: "read-root",
      dependencies: ["writer-dependency"]
    }
  ]);

  const result = await env.orchestrator.execute(
    request("read-root")
  );

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
  assert.match(
    result.errors[0],
    /Controlled-write authorization required/
  );
});

test("rejects read-only descriptors with conflicting write permissions", async () => {
  const env = setup([
    {
      id: "conflicting-engine",
      executionMode: "read-only",
      permissions: ["audit:write"]
    }
  ]);

  const result = await env.orchestrator.execute(
    request("conflicting-engine", {
      mode: "controlled-write",
      authorization: authorization(
        "conflicting-engine",
        "test-approval-conflict"
      )
    })
  );

  assert.equal(result.status, "FAILED");
  assert.equal(env.calls.length, 0);
  assert.match(
    result.errors[0],
    /execution mode conflicts with write permissions/
  );
});

test("keeps read-only engine mode when request uses controlled-write", async () => {
  const env = setup([
    {
      id: "read-only-engine",
      executionMode: "read-only",
      permissions: []
    }
  ]);

  const result = await env.orchestrator.execute(
    request("read-only-engine", {
      mode: "controlled-write",
      authorization: authorization(
        "read-only-engine",
        "test-approval-read-only"
      )
    })
  );

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(env.calls.length, 1);
  assert.equal(
    env.calls[0].context.nea.mode,
    "read-only"
  );
  assert.equal(
    env.calls[0].context.nea.authorization,
    null
  );
});
