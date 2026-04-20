import chalk from "chalk";

export interface Column<T> {
  header: string;
  key: keyof T | ((row: T) => string);
  width?: number;
  color?: (val: string, row: T) => string;
}

export function renderTable<T extends object>(
  rows: T[],
  columns: Column<T>[],
): void {
  if (rows.length === 0) {
    console.log(chalk.dim("(no results)"));
    return;
  }

  // Compute column widths
  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const maxData = rows.reduce((max, row) => {
      const val = getCellValue(row, col);
      return Math.max(max, val.length);
    }, 0);
    return col.width ?? Math.max(headerLen, maxData);
  });

  // Header row
  const header = columns
    .map((col, i) =>
      chalk.bold(col.header.padEnd(widths[i] ?? col.header.length)),
    )
    .join("  ");
  console.log(header);

  // Separator
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  console.log(chalk.dim(sep));

  // Data rows
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const w = widths[i] ?? 0;
        const val = getCellValue(row, col);
        const padded = val.padEnd(w);
        return col.color ? col.color(padded, row) : padded;
      })
      .join("  ");
    console.log(line);
  }
}

function getCellValue<T extends object>(row: T, col: Column<T>): string {
  if (typeof col.key === "function") {
    return col.key(row);
  }
  const val = row[col.key];
  if (val === null || val === undefined) return chalk.dim("—");
  return String(val);
}
