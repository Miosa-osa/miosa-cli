import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ApplicationOperationState =
  | "pending"
  | "succeeded"
  | "failed"
  | "blocked";

export interface ApplicationOperation {
  schema_version: 1;
  operation_id: string;
  idempotency_key: string;
  action: "promote" | "rollback";
  deployment_id: string;
  release_id: string;
  previous_version_id: string | null;
  target_version_id: string;
  state: ApplicationOperationState;
  receipt_id?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export function applicationIdempotencyKey(
  action: ApplicationOperation["action"],
  deploymentId: string,
  releaseId: string,
  targetVersionId: string,
): string {
  return `app_${createHash("sha256")
    .update([action, deploymentId, releaseId, targetVersionId].join(":"))
    .digest("hex")
    .slice(0, 40)}`;
}

function operationDir(appDir: string): string {
  return path.join(appDir, ".miosa", "operations");
}

export function createApplicationOperation(
  appDir: string,
  input: Omit<
    ApplicationOperation,
    "schema_version" | "operation_id" | "created_at" | "updated_at"
  >,
): ApplicationOperation {
  const now = new Date().toISOString();
  const operation: ApplicationOperation = {
    schema_version: 1,
    operation_id: `op_${randomUUID()}`,
    ...input,
    created_at: now,
    updated_at: now,
  };
  saveApplicationOperation(appDir, operation);
  return operation;
}

export function saveApplicationOperation(
  appDir: string,
  operation: ApplicationOperation,
): string {
  const dir = operationDir(appDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${operation.operation_id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(operation, null, 2)}\n`, {
    mode: 0o600,
  });
  return file;
}

export function loadApplicationOperation(
  appDir: string,
  operationId: string,
): ApplicationOperation | null {
  const file = path.join(operationDir(appDir), `${operationId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as ApplicationOperation;
}

export function updateApplicationOperation(
  appDir: string,
  operation: ApplicationOperation,
  update: Partial<ApplicationOperation>,
): ApplicationOperation {
  const next = {
    ...operation,
    ...update,
    updated_at: new Date().toISOString(),
  };
  saveApplicationOperation(appDir, next);
  return next;
}
