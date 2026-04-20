import process from "node:process";

let wasRaw = false;

export function enterRawMode(): void {
  if (!process.stdin.isTTY) return;
  wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

export function exitRawMode(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(wasRaw);
  process.stdin.pause();
}

export function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
