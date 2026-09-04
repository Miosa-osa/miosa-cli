import {
  EXIT_AUTH_ERROR,
  EXIT_NETWORK_ERROR,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  type ApiErrorBody,
} from "./types.js";

export class MiosaError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly hint?: string,
    public readonly details?: unknown,
    public readonly requestId?: string | null,
  ) {
    super(message);
    this.name = "MiosaError";
  }
}

export class AuthError extends MiosaError {
  constructor(
    message = "Authentication failed. Run: miosa login",
    hint = "If this terminal was revoked, run `miosa login` again to create a new token.",
    details?: unknown,
    requestId?: string | null,
  ) {
    super(message, EXIT_AUTH_ERROR, hint, details, requestId);
  }
}

export class NetworkError extends MiosaError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_NETWORK_ERROR, hint);
  }
}

export class UserError extends MiosaError {
  constructor(message: string, hint?: string) {
    super(message, EXIT_USER_ERROR, hint);
  }
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || (statusCode >= 500 && statusCode <= 599 && statusCode !== 501);
}

export class ServerError extends MiosaError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
    requestId?: string | null,
    hint?: string,
  ) {
    super(message, EXIT_SERVER_ERROR, hint, body, requestId);
  }

  get retryable(): boolean {
    return isRetryableStatus(this.statusCode);
  }
}

export class ApiResponseError extends MiosaError {
  constructor(
    public readonly code: string,
    message: string,
    exitCode: number,
    public readonly retryable: boolean,
    hint?: string,
    details?: unknown,
    requestId?: string | null,
  ) {
    super(message, exitCode, hint, details, requestId);
  }
}

export function mapHttpError(
  status: number,
  body: ApiErrorBody,
  rawBody: string,
  requestId?: string | null,
): MiosaError {
  const structuredError =
    typeof body.error === "object" && body.error !== null
      ? body.error
      : undefined;
  const legacyError =
    typeof body.error === "string" && body.error.trim() !== ""
      ? body.error
      : undefined;
  const msg =
    structuredError?.message ?? legacyError ?? body.message ?? `HTTP ${status}`;
  const apiCode = structuredError?.code;
  const apiDetails = structuredError?.details;

  if (apiCode && status !== 401 && status !== 403) {
    return new ApiResponseError(
      apiCode,
      msg,
      status >= 500 ? EXIT_SERVER_ERROR : EXIT_USER_ERROR,
      isRetryableStatus(status),
      undefined,
      apiDetails ?? rawBody,
      requestId,
    );
  }

  switch (status) {
    case 401:
    case 403:
      if (
        /revoked|expired|invalid|not found|unauthorized|forbidden/i.test(msg)
      ) {
        return new AuthError(
          `This terminal connection is no longer authorized (${status}): ${msg}`,
          "Run `miosa login` to reconnect this terminal, or manage tokens at https://miosa.ai/account.",
          apiDetails ?? rawBody,
          requestId,
        );
      }
      return new AuthError(
        `Access denied (${status}): ${msg}`,
        "Run `miosa login` to connect this terminal.",
        apiDetails ?? rawBody,
        requestId,
      );
    case 402:
      return new UserError(
        `Insufficient credits: ${msg}`,
        "Top up at https://miosa.ai/billing",
      );
    case 404:
      return new UserError(`Not found: ${msg}`);
    case 422:
      return new ApiResponseError(
        "VALIDATION_ERROR",
        msg,
        EXIT_USER_ERROR,
        false,
        "Correct the reported fields and retry the same command.",
        structuredError?.details ?? rawBody,
        requestId,
      );
    case 429:
      return new UserError("Rate limited. Wait a moment and retry.");
    case 501:
      return new ServerError(
        `Feature not available: ${msg}`,
        status,
        rawBody,
        requestId,
      );
    default:
      if (status >= 500) {
        return new ServerError(
          `Server error (${status}): ${msg}`,
          status,
          rawBody,
          requestId,
        );
      }
      return new MiosaError(msg, EXIT_USER_ERROR);
  }
}
