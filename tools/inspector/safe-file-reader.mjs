import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

const SECRET_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts"
]);

const SECRET_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore"
]);

function reject(message) {
  throw new Error(`SafeFileReader: ${message}`);
}

function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    reject("A non-empty relative path is required");
  }

  if (
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value)
  ) {
    reject("Invalid or absolute path");
  }

  const segments = value.split("/");

  if (
    segments.some(segment =>
      segment === "" ||
      segment === "." ||
      segment === ".."
    )
  ) {
    reject("Unsafe path segment");
  }

  const basename = segments.at(-1).toLowerCase();
  const extension = path.posix.extname(basename);

  if (
    SECRET_NAMES.has(basename) ||
    basename.startsWith(".env.") ||
    SECRET_EXTENSIONS.has(extension)
  ) {
    reject("Sensitive file access is prohibited");
  }

  return segments;
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

export async function createSafeFileReader({
  rootPath,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
} = {}) {
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    reject("A project root path is required");
  }

  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes < 1
  ) {
    reject("maxFileBytes must be a positive safe integer");
  }

  const root = await fs.realpath(rootPath);
  const rootStat = await fs.lstat(root);

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    reject("Project root must be a real directory");
  }

  async function readFile(relativePath) {
    const segments = validateRelativePath(relativePath);
    const target = path.resolve(root, ...segments);

    if (!isInsideRoot(root, target)) {
      reject("Path escapes project root");
    }

    let current = root;

    // Inspect every path component without following symlinks.
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);

      const stat = await fs.lstat(current);

      if (stat.isSymbolicLink()) {
        reject("Symbolic links are prohibited");
      }

      const isFinal = index === segments.length - 1;

      if (isFinal && !stat.isFile()) {
        reject("Target must be a regular file");
      }

      if (!isFinal && !stat.isDirectory()) {
        reject("Parent path component must be a directory");
      }
    }

    const beforeOpen = await fs.lstat(target);

    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
      reject("Target is not a regular file");
    }

    if (beforeOpen.size > maxFileBytes) {
      reject("File exceeds configured size limit");
    }

    let handle;

    try {
      const flags =
        constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0);

      handle = await fs.open(target, flags);

      const openedStat = await handle.stat();

      if (
        !openedStat.isFile() ||
        !sameFileIdentity(beforeOpen, openedStat)
      ) {
        reject("File identity changed during opening");
      }

      if (openedStat.size > maxFileBytes) {
        reject("File exceeds configured size limit");
      }

      const chunks = [];
      let totalBytes = 0;

      while (true) {
        const remaining = maxFileBytes - totalBytes;
        const buffer = Buffer.alloc(
          Math.min(CHUNK_SIZE, remaining + 1)
        );

        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          null
        );

        if (bytesRead === 0) break;

        totalBytes += bytesRead;

        if (totalBytes > maxFileBytes) {
          reject("File grew beyond configured size limit");
        }

        chunks.push(buffer.subarray(0, bytesRead));
      }

      const afterRead = await handle.stat();

      if (!sameFileIdentity(openedStat, afterRead)) {
        reject("File identity changed during reading");
      }

      const currentPathStat = await fs.lstat(target);

      if (
        currentPathStat.isSymbolicLink() ||
        !sameFileIdentity(afterRead, currentPathStat)
      ) {
        reject("File path changed during reading");
      }

      const canonicalTarget = await fs.realpath(target);

      if (canonicalTarget !== target) {
        reject("Canonical file path changed");
      }

      const contentBuffer = Buffer.concat(chunks, totalBytes);
      const content = contentBuffer.toString("utf8");

      // Reject invalid UTF-8 rather than silently replacing bytes.
      if (!Buffer.from(content, "utf8").equals(contentBuffer)) {
        reject("File is not valid UTF-8 text");
      }

      const sha256 = createHash("sha256")
        .update(contentBuffer)
        .digest("hex");

      return Object.freeze({
        relativePath: segments.join("/"),
        content,
        sizeBytes: totalBytes,
        sha256,
        fileIdentity: Object.freeze({
          device: String(afterRead.dev),
          inode: String(afterRead.ino)
        })
      });
    } finally {
      await handle?.close();
    }
  }

  return Object.freeze({
    readFile,
    rootPath: root,
    maxFileBytes
  });
}
