import path from "node:path";
import { UserError } from "../errors.js";

// Remote roots that `--delete` must never wipe. `sandbox sync/cp --delete`
// runs `rm -rf <remote-dir>` inside the sandbox; pointing it at one of these
// destroys the OS or live service data (a real incident wiped live Postgres
// data under /var/lib).
export const PROTECTED_DELETE_ROOTS: ReadonlySet<string> = new Set([
  "",
  "/",
  "/var",
  "/var/lib",
  "/etc",
  "/usr",
  "/home",
  "/root",
  "/tmp",
]);

// Normalize a remote dir for deletion: trim whitespace, collapse duplicate
// slashes and dot segments, drop trailing slashes, and anchor relative paths
// at "/" (sandbox exec runs with cwd "/"). "" and "." normalize to "/".
export function normalizeRemoteDeleteDir(remoteDir: string): string {
  return path.posix.resolve("/", remoteDir.trim());
}

// Returns the normalized remote dir, or throws when it is a protected root.
export function assertDeletableRemoteDir(remoteDir: string): string {
  const normalized = normalizeRemoteDeleteDir(remoteDir);
  if (PROTECTED_DELETE_ROOTS.has(normalized)) {
    throw new UserError(
      `Refusing --delete against protected path ${normalized}.`,
      "Target a specific subdirectory (e.g. /workspace/app) or re-run without --delete.",
    );
  }
  return normalized;
}
