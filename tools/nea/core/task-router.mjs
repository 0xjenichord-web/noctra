function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    freezeDeep(child);
  }

  return Object.freeze(value);
}

function validateInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("Task routing input must be a plain object.");
  }

  const requiredCapabilities = input.requiredCapabilities ?? [];

  if (
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.some(
      item => typeof item !== "string" || !item.trim()
    )
  ) {
    throw new TypeError(
      "requiredCapabilities must be an array of non-empty strings."
    );
  }

  if (new Set(requiredCapabilities).size !== requiredCapabilities.length) {
    throw new TypeError("requiredCapabilities must not contain duplicates.");
  }

  if (
    input.domain !== undefined &&
    (typeof input.domain !== "string" || !input.domain.trim())
  ) {
    throw new TypeError("domain must be a non-empty string.");
  }

  if (
    input.preferredEngineId !== undefined &&
    (typeof input.preferredEngineId !== "string" ||
      !input.preferredEngineId.trim())
  ) {
    throw new TypeError("preferredEngineId must be a non-empty string.");
  }

  if (
    requiredCapabilities.length === 0 &&
    input.domain === undefined &&
    input.preferredEngineId === undefined
  ) {
    throw new TypeError(
      "At least one routing criterion is required."
    );
  }

  const authorization = input.authorization;

  if (
    authorization !== undefined &&
    (
      !isPlainObject(authorization) ||
      authorization.approved !== true ||
      typeof authorization.reference !== "string" ||
      !authorization.reference.trim()
    )
  ) {
    throw new TypeError(
      "Controlled-write authorization requires approved:true and a reference."
    );
  }

  return {
    requiredCapabilities,
    domain: input.domain,
    preferredEngineId: input.preferredEngineId,
    authorization
  };
}

export function createTaskRouter({ registry } = {}) {
  if (
    !registry ||
    typeof registry.list !== "function" ||
    typeof registry.validateDependencies !== "function"
  ) {
    throw new TypeError("A compatible NEA registry is required.");
  }

  function routeTask(input) {
    const criteria = validateInput(input);
    const engines = registry.list({ includeDisabled: true });

    if (!Array.isArray(engines)) {
      throw new TypeError("NEA registry list() must return an array.");
    }

    const engineById = new Map();

    for (const engine of engines) {
      if (
        !engine ||
        typeof engine.id !== "string" ||
        !engine.id ||
        typeof engine.domain !== "string" ||
        !Array.isArray(engine.capabilities) ||
        typeof engine.enabled !== "boolean"
      ) {
        throw new TypeError("NEA registry returned an invalid engine.");
      }

      if (engineById.has(engine.id)) {
        throw new TypeError("NEA registry returned duplicate engine IDs.");
      }

      if (
        engine.capabilities.some(
          capability =>
            typeof capability !== "string" || !capability.trim()
        )
      ) {
        throw new TypeError("Engine capabilities must be non-empty strings.");
      }

      const dependencies = engine.metadata?.dependencies ?? [];

      if (
        !Array.isArray(dependencies) ||
        dependencies.some(
          dependency => typeof dependency !== "string" || !dependency.trim()
        )
      ) {
        throw new TypeError("Engine dependencies must be valid identifiers.");
      }

      engineById.set(engine.id, engine);
    }

    const graph = registry.validateDependencies();

    if (
      !graph ||
      typeof graph.valid !== "boolean" ||
      !Array.isArray(graph.errors) ||
      !Array.isArray(graph.executionOrder)
    ) {
      throw new TypeError("NEA registry returned an invalid dependency report.");
    }

    const matching = engines.filter(engine =>
      (
        criteria.requiredCapabilities.length === 0 ||
        criteria.requiredCapabilities.some(
          capability => engine.capabilities.includes(capability)
        )
      ) &&
      (
        criteria.domain === undefined ||
        engine.domain === criteria.domain
      ) &&
      (
        criteria.preferredEngineId === undefined ||
        engine.id === criteria.preferredEngineId ||
        criteria.requiredCapabilities.length > 0 ||
        criteria.domain !== undefined
      )
    );

    function inspectDependencyChain(engine) {
      const order = [];
      const visited = new Set();
      const visiting = new Set();
      const issues = [];

      function visit(id) {
        if (visited.has(id)) return;

        if (visiting.has(id)) {
          issues.push("DEPENDENCY_CYCLE:" + id);
          return;
        }

        const dependency = engineById.get(id);

        if (!dependency) {
          issues.push("MISSING_DEPENDENCY:" + id);
          return;
        }

        if (!dependency.enabled) {
          issues.push("DISABLED_DEPENDENCY:" + id);
        }

        visiting.add(id);

        for (const dependencyId of dependency.metadata?.dependencies ?? []) {
          visit(dependencyId);
        }

        visiting.delete(id);
        visited.add(id);
        order.push(id);
      }

      visit(engine.id);

      return { order, issues };
    }

    const candidates = matching.map(engine => {
      const chain = inspectDependencyChain(engine);
      const reasons = [...chain.issues];

      const matchedCapabilities = criteria.requiredCapabilities.filter(
        capability => engine.capabilities.includes(capability)
      );

      const missingCapabilities = criteria.requiredCapabilities.filter(
        capability => !engine.capabilities.includes(capability)
      );

      const matchScore = criteria.requiredCapabilities.length === 0
        ? 100
        : Math.round(
            matchedCapabilities.length /
            criteria.requiredCapabilities.length * 100
          );

      const decisionReasons = [];

      decisionReasons.push(
        missingCapabilities.length === 0
          ? "ALL_REQUIRED_CAPABILITIES_MATCHED"
          : "MISSING_REQUIRED_CAPABILITIES"
      );

      if (criteria.domain === undefined) {
        decisionReasons.push("DOMAIN_NOT_SPECIFIED");
      } else {
        decisionReasons.push("DOMAIN_MATCHED");
      }

      decisionReasons.push(
        chain.issues.length === 0
          ? "DEPENDENCY_CHAIN_VALID"
          : "DEPENDENCY_CHAIN_HAS_ISSUES"
      );

      let status = "READY";

      if (missingCapabilities.length > 0) {
        status = "BLOCKED";
        reasons.push("MISSING_REQUIRED_CAPABILITIES");
      }

      if (!engine.enabled) {
        status = "BLOCKED";
        reasons.push("ENGINE_DISABLED");
      }

      if (!graph.valid) {
        status = "REVIEW_REQUIRED";
        reasons.push("INVALID_DEPENDENCY_GRAPH");
      } else if (chain.issues.length > 0) {
        status = "BLOCKED";
      }

      const dependencyChain = chain.order
        .map(id => engineById.get(id))
        .filter(Boolean);

      const requiresAuthorization = dependencyChain.some(
        item => item.executionMode === "controlled-write"
      );

      const unsupportedExecutionMode = dependencyChain.some(
        item =>
          item.executionMode !== "read-only" &&
          item.executionMode !== "controlled-write"
      );

      if (status === "READY" && unsupportedExecutionMode) {
        status = "BLOCKED";
        reasons.push("UNSUPPORTED_EXECUTION_MODE_IN_DEPENDENCY_CHAIN");
      }

      if (status === "READY" && requiresAuthorization && !criteria.authorization) {
        status = "AUTHORIZATION_REQUIRED";
        reasons.push("CONTROLLED_WRITE_REQUIRES_EXPLICIT_AUTHORIZATION");
      }

      return {
        id: engine.id,
        name: engine.name,
        version: engine.version,
        domain: engine.domain,
        enabled: engine.enabled,
        executionMode: engine.executionMode,
        capabilities: [...engine.capabilities],
        matchedCapabilities,
        missingCapabilities,
        matchScore,
        decision: {
          eligible: status === "READY",
          status,
          reasons: [...new Set([...decisionReasons, ...reasons])],
          blockers: [...reasons],
          authorizationRequired:
            requiresAuthorization && !criteria.authorization
        },
        dependencies: [...(engine.metadata?.dependencies ?? [])],
        dependencyOrder: chain.order,
        status,
        reasons
      };
    });

    candidates.sort((a, b) => {
      const eligibilityDifference =
        Number(b.status === "READY") - Number(a.status === "READY");

      if (eligibilityDifference !== 0) {
        return eligibilityDifference;
      }

      const scoreDifference = b.matchScore - a.matchScore;

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      if (a.id === criteria.preferredEngineId) return -1;
      if (b.id === criteria.preferredEngineId) return 1;

      return a.id.localeCompare(b.id);
    });

    candidates.forEach((candidate, index) => {
      candidate.ranking = index + 1;
    });

    const ready = candidates.filter(candidate => candidate.status === "READY");
    const authorizationRequired = candidates.some(
      candidate => candidate.status === "AUTHORIZATION_REQUIRED"
    );

    let status = "NO_MATCH";
    let selectedEngineId = null;
    let executionOrder = [];

    if (!graph.valid && candidates.length > 0) {
      status = "REVIEW_REQUIRED";
    } else if (ready.length === 1) {
      status = "ROUTED";
      selectedEngineId = ready[0].id;
      executionOrder = ready[0].dependencyOrder;
    } else if (ready.length > 1) {
      status = "AMBIGUOUS";
    } else if (authorizationRequired) {
      status = "AUTHORIZATION_REQUIRED";
    } else if (candidates.length > 0) {
      status = "REVIEW_REQUIRED";
    }

    return freezeDeep({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status,
      selectedEngineId,
      requiredCapabilities: [...criteria.requiredCapabilities],
      domain: criteria.domain ?? null,
      preferredEngineId: criteria.preferredEngineId ?? null,
      candidates,
      executionOrder,
      dependencyGraph: {
        valid: graph.valid,
        errors: [...graph.errors]
      },
      authorization: {
        supplied: Boolean(criteria.authorization),
        executionPerformed: false
      },
      safety: {
        readOnly: true,
        enginesExecuted: false,
        commandsExecuted: false,
        projectFilesModified: false
      }
    });
  }

  return Object.freeze({ routeTask });
}
