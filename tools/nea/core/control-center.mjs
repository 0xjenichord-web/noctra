import { createTaskRouter } from "./task-router.mjs";

function isPlainObject(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function cloneData(value) {
  if (Array.isArray(value)) {
    return value.map(cloneData);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        cloneData(child)
      ])
    );
  }

  return value;
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

function requireSubsystem(condition, name) {
  if (!condition) {
    throw new TypeError("A compatible " + name + " is required.");
  }
}

/**
 * NIMPI unified control plane.
 *
 * Stage 7.1 exposes inspection, dependency analysis, impact analysis,
 * and safety assessment. It does not execute engines or modify files.
 */
export function createNimpiControlCenter({
  registry,
  orchestrator,
  verificationPipeline,
  adaptiveImpactEngine,
  safetyRecoveryCoordinator
} = {}) {
  requireSubsystem(
    registry &&
      typeof registry.list === "function" &&
      typeof registry.get === "function" &&
      typeof registry.validateDependencies === "function",
    "NEA registry"
  );

  requireSubsystem(
    orchestrator && typeof orchestrator.execute === "function",
    "NEA orchestrator"
  );

  requireSubsystem(
    verificationPipeline &&
      typeof verificationPipeline.execute === "function",
    "NEA verification pipeline"
  );

  requireSubsystem(
    adaptiveImpactEngine &&
      typeof adaptiveImpactEngine.analyze === "function",
    "NEA adaptive impact engine"
  );

  requireSubsystem(
    safetyRecoveryCoordinator &&
      typeof safetyRecoveryCoordinator.assess === "function" &&
      typeof safetyRecoveryCoordinator.restore === "function",
    "NEA safety recovery coordinator"
  );

  const taskRouter = createTaskRouter({ registry });

  function routeTask(input) {
    return taskRouter.routeTask(input);
  }

  function getSystemStatus() {
    const engines = registry.list({ includeDisabled: true });

    if (!Array.isArray(engines)) {
      throw new TypeError("NEA registry list() must return an array.");
    }

    const dependencies = registry.validateDependencies();

    if (
      !dependencies ||
      typeof dependencies.valid !== "boolean" ||
      !Array.isArray(dependencies.errors) ||
      !Array.isArray(dependencies.executionOrder)
    ) {
      throw new TypeError("NEA registry returned an invalid dependency report.");
    }

    const enabled = engines.filter(engine => engine.enabled).length;
    const disabled = engines.length - enabled;

    return freezeDeep({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: dependencies.valid ? "READY" : "REVIEW_REQUIRED",
      contractVersion: registry.contractVersion ?? null,
      engines: {
        total: engines.length,
        enabled,
        disabled
      },
      dependencyGraph: {
        valid: dependencies.valid,
        errors: [...dependencies.errors],
        executionOrder: [...dependencies.executionOrder]
      },
      subsystems: {
        registry: "AVAILABLE",
        orchestrator: "AVAILABLE",
        verificationPipeline: "AVAILABLE",
        adaptiveImpactEngine: "AVAILABLE",
        safetyRecoveryCoordinator: "AVAILABLE"
      },
      capabilities: {
        engineInspection: true,
        dependencyInspection: true,
        changeImpactAnalysis: true,
        safetyAssessment: true,
        engineExecution: false,
        controlledWrite: false,
        restoreExecution: false
      },
      safety: {
        enginesExecuted: false,
        commandsExecuted: false,
        projectFilesModified: false,
        restoreExecuted: false
      }
    });
  }

  function getEngineDashboard() {
    const engines = registry.list({ includeDisabled: true });

    if (!Array.isArray(engines)) {
      throw new TypeError("NEA registry list() must return an array.");
    }

    const dependencyReport = registry.validateDependencies();

    if (
      !dependencyReport ||
      typeof dependencyReport.valid !== "boolean" ||
      !Array.isArray(dependencyReport.errors) ||
      !Array.isArray(dependencyReport.executionOrder)
    ) {
      throw new TypeError("NEA registry returned an invalid dependency report.");
    }

    const engineById = new Map();

    for (const engine of engines) {
      if (
        !engine ||
        typeof engine.id !== "string" ||
        !engine.id ||
        typeof engine.domain !== "string" ||
        !engine.domain ||
        typeof engine.enabled !== "boolean" ||
        !Array.isArray(engine.capabilities)
      ) {
        throw new TypeError("NEA registry returned an invalid engine descriptor.");
      }

      if (engineById.has(engine.id)) {
        throw new TypeError("NEA registry returned duplicate engine IDs.");
      }

      engineById.set(engine.id, engine);
    }

    const domains = new Map();
    const capabilities = new Map();
    const dependencyIssues = [];
    const reviewEngineIds = new Set();

    let enabled = 0;
    let disabled = 0;

    for (const engine of engines) {
      if (engine.enabled) enabled++;
      else disabled++;

      if (!domains.has(engine.domain)) {
        domains.set(engine.domain, {
          domain: engine.domain,
          total: 0,
          enabled: 0,
          disabled: 0,
          engineIds: []
        });
      }

      const domain = domains.get(engine.domain);
      domain.total++;
      domain[engine.enabled ? "enabled" : "disabled"]++;
      domain.engineIds.push(engine.id);

      for (const capabilityName of engine.capabilities) {
        if (
          typeof capabilityName !== "string" ||
          !capabilityName.trim()
        ) {
          throw new TypeError("Engine capabilities must be non-empty strings.");
        }

        if (!capabilities.has(capabilityName)) {
          capabilities.set(capabilityName, {
            capability: capabilityName,
            engineCount: 0,
            enabledEngineCount: 0,
            engineIds: []
          });
        }

        const capability = capabilities.get(capabilityName);
        capability.engineCount++;
        if (engine.enabled) capability.enabledEngineCount++;
        capability.engineIds.push(engine.id);
      }

      const dependencies = engine.metadata?.dependencies ?? [];

      if (
        !Array.isArray(dependencies) ||
        dependencies.some(id => typeof id !== "string" || !id.trim())
      ) {
        throw new TypeError(
          "Engine dependencies must be an array of non-empty strings."
        );
      }

      for (const dependencyId of dependencies) {
        const dependency = engineById.get(dependencyId);

        if (!dependency) {
          dependencyIssues.push({
            engineId: engine.id,
            dependencyId,
            issue: "MISSING_DEPENDENCY"
          });
          reviewEngineIds.add(engine.id);
          continue;
        }

        if (!dependency.enabled) {
          dependencyIssues.push({
            engineId: engine.id,
            dependencyId,
            issue: "DISABLED_DEPENDENCY"
          });
          reviewEngineIds.add(engine.id);
        }
      }
    }

    const domainList = [...domains.values()]
      .map(domain => ({
        ...domain,
        engineIds: [...domain.engineIds].sort()
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));

    const capabilityList = [...capabilities.values()]
      .map(capability => ({
        ...capability,
        engineIds: [...capability.engineIds].sort()
      }))
      .sort((a, b) => a.capability.localeCompare(b.capability));

    const dependencyErrors = [...dependencyReport.errors];

    const engineInventory = engines
      .map(engine => {
        const dependencies = engine.metadata?.dependencies ?? [];

        const dependencyDetails = dependencies.map(dependencyId => {
          const dependency = engineById.get(dependencyId);

          return {
            id: dependencyId,
            exists: Boolean(dependency),
            enabled: dependency?.enabled ?? false,
            status: !dependency
              ? "MISSING"
              : dependency.enabled
                ? "AVAILABLE"
                : "DISABLED"
          };
        });

        const reviewRequired = dependencyDetails.some(
          dependency => dependency.status !== "AVAILABLE"
        );

        return {
          id: engine.id,
          name: engine.name,
          version: engine.version,
          domain: engine.domain,
          enabled: engine.enabled,
          status: engine.enabled ? "ENABLED" : "DISABLED",
          executionMode: engine.executionMode,
          capabilities: [...engine.capabilities],
          dependencies: dependencyDetails,
          reviewRequired
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const executionModes = {
      readOnly: engines.filter(
        engine => engine.executionMode === "read-only"
      ).length,
      controlledWrite: engines.filter(
        engine => engine.executionMode === "controlled-write"
      ).length,
      unspecified: engines.filter(
        engine =>
          engine.executionMode !== "read-only" &&
          engine.executionMode !== "controlled-write"
      ).length
    };

    return freezeDeep({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status:
        !dependencyReport.valid ||
        dependencyErrors.length > 0 ||
        dependencyIssues.length > 0
          ? "REVIEW_REQUIRED"
          : "READY",
      overview: {
        totalEngines: engines.length,
        enabled,
        disabled,
        domainCount: domainList.length,
        capabilityCount: capabilityList.length,
        dependencyIssueCount: dependencyIssues.length,
        dependencyErrorCount: dependencyErrors.length,
        reviewRequired: reviewEngineIds.size
      },
      domains: domainList,
      capabilities: capabilityList,
      engines: engineInventory,
      executionModes,
      dependencies: {
        valid: dependencyReport.valid,
        errors: dependencyErrors,
        issues: dependencyIssues
      },
      review: {
        required:
          !dependencyReport.valid ||
          reviewEngineIds.size > 0 ||
          dependencyErrors.length > 0,
        engineIds: [...reviewEngineIds].sort(),
        reasons: [
          ...(!dependencyReport.valid || dependencyErrors.length > 0
            ? ["DEPENDENCY_GRAPH_INVALID"]
            : []),
          ...dependencyIssues.map(issue => issue.issue)
        ].filter((reason, index, all) => all.indexOf(reason) === index).sort()
      },
      safety: {
        readOnly: true,
        enginesExecuted: false,
        commandsExecuted: false,
        projectFilesModified: false
      }
    });
  }

  function listEngines(options = {}) {
    if (!isPlainObject(options)) {
      throw new TypeError("Engine list options must be a plain object.");
    }

    if (
      options.includeDisabled !== undefined &&
      typeof options.includeDisabled !== "boolean"
    ) {
      throw new TypeError("includeDisabled must be a boolean.");
    }

    const includeDisabled = options.includeDisabled === true;
    const engines = registry.list({ includeDisabled: true });

    if (!Array.isArray(engines)) {
      throw new TypeError("NEA registry list() must return an array.");
    }

    const result = engines
      .filter(engine => includeDisabled || engine.enabled)
      .map(engine => ({
        id: engine.id,
        name: engine.name,
        version: engine.version,
        domain: engine.domain,
        enabled: engine.enabled,
        executionMode: engine.executionMode,
        capabilities: [...engine.capabilities],
        dependencies: [
          ...(engine.metadata?.dependencies ?? [])
        ]
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return freezeDeep(result);
  }

  function inspectEngine(id) {
    if (typeof id !== "string" || !id.trim()) {
      throw new TypeError("Engine id must be a non-empty string.");
    }

    const engine = registry.get(id.trim());

    if (!engine) return null;

    const dependencies = [
      ...(engine.metadata?.dependencies ?? [])
    ];

    return freezeDeep({
      id: engine.id,
      name: engine.name,
      version: engine.version,
      domain: engine.domain,
      enabled: engine.enabled,
      executionMode: engine.executionMode,
      contractVersion: engine.contractVersion,
      inputContract: cloneData(engine.inputContract),
      outputContract: cloneData(engine.outputContract),
      capabilities: [...engine.capabilities],
      dependencies: dependencies.map(dependencyId => {
        const dependency = registry.get(dependencyId);

        return {
          id: dependencyId,
          exists: Boolean(dependency),
          enabled: dependency?.enabled ?? false
        };
      }),
      metadata: cloneData(engine.metadata ?? {})
    });
  }

  function inspectDependencies() {
    const report = registry.validateDependencies();

    if (
      !report ||
      typeof report.valid !== "boolean" ||
      !Array.isArray(report.errors) ||
      !Array.isArray(report.executionOrder)
    ) {
      throw new TypeError("NEA registry returned an invalid dependency report.");
    }

    return freezeDeep({
      valid: report.valid,
      status: report.valid ? "VALID" : "INVALID",
      errors: [...report.errors],
      executionOrder: [...report.executionOrder]
    });
  }

  async function analyzeChangeImpact(input) {
    if (!isPlainObject(input)) {
      throw new TypeError("Change impact input must be a plain object.");
    }

    if (!input.changeReport || typeof input.changeReport !== "object") {
      throw new TypeError("changeReport is required.");
    }

    return adaptiveImpactEngine.analyze(input);
  }

  async function assessSafety(input) {
    if (!isPlainObject(input)) {
      throw new TypeError("Safety assessment input must be a plain object.");
    }

    return safetyRecoveryCoordinator.assess(input);
  }

  return Object.freeze({
    getSystemStatus,
    routeTask,
    getEngineDashboard,
    listEngines,
    inspectEngine,
    inspectDependencies,
    analyzeChangeImpact,
    assessSafety
  });
}
