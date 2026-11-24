import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import {
  createRecoveryPoint,
  loadVerifiedRecoveryPoint,
  verifyRecoveryPoint
} from "./recovery-store.mjs";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
}

async function inspectTarget(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some(
      part => !part || part === "." || part === ".."
    )
  ) {
    throw new Error(`Unsafe restore path: ${relativePath}`);
  }

  const parts = relativePath.split("/");
  if ([".git", "node_modules", ".nacc"].includes(parts[0])) {
    throw new Error(`Protected restore path: ${relativePath}`);
  }

  const target = path.resolve(root, ...parts);
  if (!inside(root, target)) {
    throw new Error(`Restore path escapes project root: ${relativePath}`);
  }

  const parent = path.dirname(target);
  const realParent = await fs.realpath(parent);

  if (!inside(root, realParent)) {
    throw new Error(`Restore parent escapes project root: ${relativePath}`);
  }

  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`Unsafe restore parent: ${relativePath}`);
  }

  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Restore target must be an existing regular file: ${relativePath}`);
  }

  return {
    target,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777
  };
}

async function writeStagedFile(target, content, mode) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.nea-stage`
  );

  const handle = await fs.open(temp, "wx", 0o600);

  try {
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }

  await handle.close();
  return temp;
}

export function createRestoreCoordinator({
  createRecoveryPointFn = createRecoveryPoint,
  loadRecoveryPointFn = loadVerifiedRecoveryPoint,
  verifyRecoveryPointFn = verifyRecoveryPoint
} = {}) {
  for (const [name, fn] of Object.entries({
    createRecoveryPointFn,
    loadRecoveryPointFn,
    verifyRecoveryPointFn
  })) {
    if (typeof fn !== "function") {
      throw new TypeError(`${name} must be a function.`);
    }
  }

  async function restore({
    rootPath,
    recoveryPointId,
    authorization,
    recoveryDir
  } = {}) {
    if (typeof rootPath !== "string" || !rootPath) {
      throw new TypeError("A project root is required.");
    }

    if (
      !authorization ||
      authorization.approved !== true ||
      typeof authorization.reference !== "string" ||
      !authorization.reference.trim()
    ) {
      throw new Error("Explicit restore authorization is required.");
    }

    if (typeof recoveryPointId !== "string" || !recoveryPointId) {
      throw new TypeError("A recovery point identifier is required.");
    }

    const root = await fs.realpath(rootPath);

    const verification = await verifyRecoveryPointFn(
      root,
      recoveryPointId,
      { recoveryDir }
    );

    if (!verification.valid || !verification.restorable) {
      throw new Error("Recovery point failed integrity verification.");
    }

    const recovery = await loadRecoveryPointFn(
      root,
      recoveryPointId,
      { recoveryDir }
    );

    if (
      recovery.root !== root ||
      !Array.isArray(recovery.files) ||
      recovery.files.length === 0
    ) {
      throw new Error("Recovery point content is invalid.");
    }

    const paths = recovery.files.map(file => file.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error("Recovery point contains duplicate paths.");
    }

    const targets = [];
    for (const file of recovery.files) {
      const target = await inspectTarget(root, file.path);
      targets.push({ ...target, file, temp: null, backup: null, backupMoved: false, published: false });
    }

    // Preserve the current state before changing any project file.
    const preRestore = await createRecoveryPointFn(root, {
      paths,
      recoveryDir
    });

    const staged = [];

    try {
      for (const entry of targets) {
        const current = await fs.lstat(entry.target);

        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.dev !== entry.dev ||
          current.ino !== entry.ino ||
          current.size !== entry.size ||
          current.mtimeMs !== entry.mtimeMs
        ) {
          throw new Error(`Restore target changed during preflight: ${entry.file.path}`);
        }

        entry.temp = await writeStagedFile(
          entry.target,
          entry.file.content,
          entry.mode
        );
        staged.push(entry);
      }
    } catch (error) {
      for (const entry of staged) {
        await fs.unlink(entry.temp).catch(() => {});
      }
      throw new Error(`Restore staging failed: ${error.message}`, { cause: error });
    }

    const rollbackErrors = [];

    try {
      for (const entry of targets) {
        const current = await fs.lstat(entry.target);

        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.dev !== entry.dev ||
          current.ino !== entry.ino
        ) {
          throw new Error(`Restore target changed before replacement: ${entry.file.path}`);
        }

        entry.backup = path.join(
          path.dirname(entry.target),
          `.${path.basename(entry.target)}.${process.pid}.${randomUUID()}.nea-backup`
        );

        await fs.rename(entry.target, entry.backup);
        entry.backupMoved = true;
      }

      for (const entry of targets) {
        await fs.rename(entry.temp, entry.target);
        entry.temp = null;
        entry.published = true;
      }
    } catch (error) {
      for (const entry of [...targets].reverse()) {
        if (!entry.published) continue;
        try {
          await fs.unlink(entry.target);
          entry.published = false;
        } catch (rollbackError) {
          rollbackErrors.push(
            `remove restored file ${entry.file.path}: ${rollbackError.message}`
          );
        }
      }

      for (const entry of [...targets].reverse()) {
        if (!entry.backup || !entry.backupMoved) continue;
        try {
          await fs.rename(entry.backup, entry.target);
          entry.backup = null;
          entry.backupMoved = false;
        } catch (rollbackError) {
          rollbackErrors.push(
            `restore original file ${entry.file.path}: ${rollbackError.message}`
          );
        }
      }

      for (const entry of targets) {
        if (entry.temp) {
          await fs.unlink(entry.temp).catch(() => {});
        }
      }

      const suffix = rollbackErrors.length
        ? `; rollback issues: ${rollbackErrors.join("; ")}`
        : "";

      throw new Error(
        `Restore transaction failed: ${error.message}${suffix}`,
        { cause: error }
      );
    }

    const postRestoreErrors = [];

    for (const entry of targets) {
      try {
        const content = await fs.readFile(entry.target);
        const actualHash = createHash("sha256").update(content).digest("hex");

        if (actualHash !== entry.file.sha256) {
          throw new Error("restored content hash mismatch");
        }
      } catch (error) {
        postRestoreErrors.push(
          entry.file.path + ": " + error.message
        );
      }
    }

    if (postRestoreErrors.length) {
      const verificationRollbackErrors = [];

      for (const entry of [...targets].reverse()) {
        if (!entry.published) continue;

        try {
          await fs.unlink(entry.target);
          entry.published = false;
        } catch (error) {
          verificationRollbackErrors.push(
            `remove unverified file ${entry.file.path}: ${error.message}`
          );
        }
      }

      for (const entry of [...targets].reverse()) {
        if (!entry.backupMoved || !entry.backup) continue;

        try {
          await fs.rename(entry.backup, entry.target);
          entry.backup = null;
          entry.backupMoved = false;
        } catch (error) {
          verificationRollbackErrors.push(
            `restore original file ${entry.file.path}: ${error.message}`
          );
        }
      }

      for (const entry of targets) {
        if (entry.temp) {
          await fs.unlink(entry.temp).catch(() => {});
        }
      }

      const rollbackSuffix = verificationRollbackErrors.length
        ? "; rollback issues: " + verificationRollbackErrors.join("; ")
        : "";

      throw new Error(
        "Post-restore verification failed: " +
        postRestoreErrors.join("; ") +
        ". Pre-restore recovery point: " + preRestore.id +
        rollbackSuffix
      );
    }

    // Backups are removed only after every restored file passes verification.
    const cleanupErrors = [];

    for (const entry of targets) {
      if (!entry.backup) continue;

      try {
        await fs.unlink(entry.backup);
        entry.backup = null;
        entry.backupMoved = false;
      } catch (error) {
        cleanupErrors.push({
          path: entry.file.path,
          error: error.message
        });
      }
    }

    return Object.freeze({
      status: cleanupErrors.length ? "RESTORED_WITH_CLEANUP_WARNINGS" : "RESTORED",
      recoveryPointId,
      preRestoreRecoveryPointId: preRestore.id,
      restoredFiles: Object.freeze(paths),
      verified: true,
      cleanupErrors: Object.freeze(cleanupErrors.map(Object.freeze)),
      authorizationReference: authorization.reference
    });
  }

  return Object.freeze({ restore });
}
