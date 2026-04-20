import chalk from "chalk";
import { MiosaError } from "../errors.js";

export function handleError(err: unknown): never {
  if (err instanceof MiosaError) {
    console.error(chalk.red(`Error: ${err.message}`));
    if (err.hint) {
      console.error(chalk.dim(`  Hint: ${err.hint}`));
    }
    process.exit(err.exitCode);
  }
  if (err instanceof Error) {
    console.error(chalk.red(`Unexpected error: ${err.message}`));
    if (process.env["MIOSA_DEBUG"]) {
      console.error(err.stack);
    }
    process.exit(1);
  }
  console.error(chalk.red(`Unknown error: ${String(err)}`));
  process.exit(1);
}

/** Parse "host:/path" or just "host" (path defaults to "/") */
export function parseHostPath(arg: string): { host: string; path: string } {
  const colonIdx = arg.indexOf(":");
  if (colonIdx === -1) return { host: arg, path: "/" };
  return {
    host: arg.slice(0, colonIdx),
    path: arg.slice(colonIdx + 1) || "/",
  };
}

/** Parse KEY=VAL pairs into a Record */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      result[pair] = "";
    } else {
      result[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return result;
}

/** Parse duration strings like "30s", "2m", "1h" into milliseconds */
export function parseDuration(s: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(s);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const n = parseInt(match[1] ?? "0", 10);
  switch (match[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 1_000; // default: seconds
  }
}
