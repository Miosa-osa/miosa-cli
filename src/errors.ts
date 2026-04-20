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
  ) {
    super(message);
    this.name = "MiosaError";
  }
}

export class AuthError extends MiosaError {
  constructor(message = "Authentication failed. Run: miosa login") {
    super(message, EXIT_AUTH_ERROR);
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

export class ServerError extends MiosaError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message, EXIT_SERVER_ERROR);
  }
}

export function mapHttpError(
  status: number,
  body: ApiErrorBody,
  rawBody: string,
): MiosaError {
  const msg = body.error?.message ?? body.message ?? `HTTP ${status}`;

  switch (status) {
    case 401:
    case 403:
      return new AuthError(
        `Access denied (${status}): ${msg}. Run: miosa login`,
      );
    case 402:
      return new UserError(
        `Insufficient credits: ${msg}`,
        "Top up at https://miosa.ai/billing",
      );
    case 404:
      return new UserError(`Not found: ${msg}`);
    case 422:
      return new UserError(
        `Validation error: ${msg}`,
        body.error?.details ? JSON.stringify(body.error.details) : undefined,
      );
    case 429:
      return new UserError("Rate limited. Wait a moment and retry.");
    case 501:
      return new ServerError(`Feature not available: ${msg}`, status, rawBody);
    default:
      if (status >= 500) {
        return new ServerError(
          `Server error (${status}): ${msg}`,
          status,
          rawBody,
        );
      }
      return new MiosaError(msg, EXIT_USER_ERROR);
  }
}
