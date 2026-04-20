import process from "node:process";

export class ProgressBar {
  private current = 0;
  private readonly width: number;
  private readonly label: string;

  constructor(label: string, width = 30) {
    this.label = label;
    this.width = width;
  }

  update(current: number, total: number): void {
    this.current = current;
    const pct = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.round(this.width * pct);
    const empty = this.width - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    const pctStr = Math.round(pct * 100)
      .toString()
      .padStart(3);
    const transferred = formatBytes(current);
    const totalStr = formatBytes(total);
    process.stdout.write(
      `\r${this.label} [${bar}] ${pctStr}% ${transferred}/${totalStr}`,
    );
  }

  done(): void {
    process.stdout.write("\n");
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
