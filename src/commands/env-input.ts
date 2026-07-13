import fs from "node:fs";
import { UserError } from "../errors.js";

/**
 * Literal-safe env input: --env-file and --env-stdin.
 *
 * Inline `--env KEY=VALUE` args pass through the user's shell first, which
 * expands `$N`, `$r`, etc. in unquoted values (this corrupted scrypt hashes
 * in the wild). Files and stdin bypass the shell entirely - values are taken
 * byte-for-byte with NO variable expansion.
 */

export const ENV_FILE_OPTION_HELP =
  "Read env vars from a dotenv-format file. Values are literal (no shell/variable expansion) - the safe path for secrets.";

export const ENV_STDIN_OPTION_HELP =
  "Read env vars as KEY=VALUE lines from stdin. Values are literal (no shell/variable expansion) - the safe path for secrets.";

export const ENV_INLINE_SHELL_WARNING =
  "Inline values are subject to your shell's expansion (e.g. $VAR); prefer --env-file or --env-stdin for secrets.";

// dotenv-format line: optional `export `, KEY, `=`, then an optionally quoted
// value. Quoted values (single, double, or backtick) may span multiple lines.
// Mirrors the `dotenv` package's parser - WITHOUT any dotenv-expand behavior.
const DOTENV_LINE =
  /^\s*(?:export\s+)?([\w.-]+)\s*=[^\S\r\n]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]+)?[^\S\r\n]*(?:#.*)?$/gm;

/** Parse dotenv-format content. Values are literal: NO variable expansion. */
export function parseDotenv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const normalized = content.replace(/\r\n?/g, "\n");
  const line = new RegExp(DOTENV_LINE.source, DOTENV_LINE.flags);
  let match: RegExpExecArray | null;
  while ((match = line.exec(normalized)) !== null) {
    const key = match[1] as string;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/m, "$2");
    if (quote === '"') {
      // Double-quoted values support escaped newlines, per dotenv convention.
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }
    env[key] = value;
  }
  return env;
}

/** Read and parse a dotenv-format file. Values are byte-for-byte literal. */
export function readEnvFile(filePath: string): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new UserError(
      `Cannot read env file: ${filePath}`,
      "Pass a readable dotenv-format file to --env-file.",
    );
  }
  return parseDotenv(content);
}

/** Read KEY=VALUE lines (dotenv format) from stdin until EOF. */
export async function readEnvStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<Record<string, string>> {
  let content = "";
  for await (const chunk of stream) {
    content += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return parseDotenv(content);
}

/**
 * Merge env sources. Precedence (lowest → highest):
 * --env-file, then --env-stdin, then inline KEY=VALUE args.
 */
export async function resolveEnvInputs(
  inline: Record<string, string>,
  opts: { envFile?: string; envStdin?: boolean },
): Promise<Record<string, string>> {
  let env: Record<string, string> = {};
  if (opts.envFile) env = { ...env, ...readEnvFile(opts.envFile) };
  if (opts.envStdin) env = { ...env, ...(await readEnvStdin()) };
  return { ...env, ...inline };
}
