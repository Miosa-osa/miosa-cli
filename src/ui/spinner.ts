// Re-export ora with a typed wrapper so commands don't import ora directly
export { default as ora } from "ora";

import ora from "ora";

export function spin(text: string): ReturnType<typeof ora> {
  return ora({ text, spinner: "dots" }).start();
}
