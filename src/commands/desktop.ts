import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { request } from "undici";
import { loadConfig } from "../config.js";
import { AuthError, NetworkError, mapHttpError } from "../errors.js";
import {
  enc,
  getAndPrint,
  postAndPrint,
  runAction,
  type JsonOptions,
} from "./enterprise-util.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function desktopPath(id: string, sub: string): string {
  return `/api/v1/computers/${enc(id)}/desktop/${sub}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "@miosa/cli/0.1.0",
  };
}

/** Fetch raw binary from the screenshot endpoint; returns Buffer. */
async function fetchScreenshot(id: string): Promise<Buffer> {
  const config = loadConfig();
  if (!config.api_key) {
    throw new AuthError(
      "You are not logged in. Run: miosa login",
      "Run `miosa login` to authenticate.",
    );
  }
  const endpoint = (config.endpoint || "https://api.miosa.ai").replace(
    /\/$/,
    "",
  );
  const url = `${endpoint}${desktopPath(id, "screenshot")}`;

  let res;
  try {
    res = await request(url, {
      method: "GET",
      headers: authHeaders(config.api_key),
    });
  } catch (err) {
    throw new NetworkError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
      "Check your connection and endpoint: miosa status",
    );
  }

  if (res.statusCode >= 400) {
    const rawBody = await res.body.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      body = { message: rawBody || `HTTP ${res.statusCode}` };
    }
    throw mapHttpError(res.statusCode, body, rawBody);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Register desktop subcommands onto the `computers` command group
// ---------------------------------------------------------------------------

export function registerDesktopCommands(computers: Command): void {
  // -------------------------------------------------------------------------
  // screenshot <id> [--output file.png]
  // -------------------------------------------------------------------------
  computers
    .command("screenshot <id>")
    .description("Capture a screenshot of the Computer desktop")
    .option(
      "--output <file>",
      "Save PNG to file (default: print base64 to stdout)",
    )
    .option("--json", "Output as JSON (wraps base64 in {data})")
    .action((id: string, opts: { output?: string; json?: boolean }) =>
      runAction(async () => {
        const png = await fetchScreenshot(id);
        if (opts.output) {
          writeFileSync(opts.output, png);
          console.log(
            `Screenshot saved to ${opts.output} (${png.length} bytes)`,
          );
          return;
        }
        if (opts.json) {
          console.log(
            JSON.stringify(
              { data: png.toString("base64"), format: "png" },
              null,
              2,
            ),
          );
          return;
        }
        // Default: emit raw base64 so callers can pipe it
        process.stdout.write(png.toString("base64") + "\n");
      }),
    );

  // -------------------------------------------------------------------------
  // click <id> <x> <y> [--button left|right|middle]
  // -------------------------------------------------------------------------
  computers
    .command("click <id> <x> <y>")
    .description("Click at coordinates on the Computer desktop")
    .option("--button <button>", "Mouse button: left, right, middle", "left")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        x: string,
        y: string,
        opts: JsonOptions & { button: string },
      ) =>
        runAction(() =>
          postAndPrint(desktopPath(id, "click"), opts, {
            x: Number(x),
            y: Number(y),
            button: opts.button,
          }),
        ),
    );

  // -------------------------------------------------------------------------
  // double-click <id> <x> <y>
  // -------------------------------------------------------------------------
  computers
    .command("double-click <id> <x> <y>")
    .description("Double-click at coordinates on the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, x: string, y: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(desktopPath(id, "double-click"), opts, {
          x: Number(x),
          y: Number(y),
        }),
      ),
    );

  // -------------------------------------------------------------------------
  // right-click <id> <x> <y>
  // -------------------------------------------------------------------------
  computers
    .command("right-click <id> <x> <y>")
    .description("Right-click at coordinates on the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, x: string, y: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(desktopPath(id, "click"), opts, {
          x: Number(x),
          y: Number(y),
          button: "right",
        }),
      ),
    );

  // -------------------------------------------------------------------------
  // type <id> <text>
  // -------------------------------------------------------------------------
  computers
    .command("type <id> <text>")
    .description("Type text on the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, text: string, opts: JsonOptions) =>
      runAction(() => postAndPrint(desktopPath(id, "type"), opts, { text })),
    );

  // -------------------------------------------------------------------------
  // key <id> <key>
  // -------------------------------------------------------------------------
  computers
    .command("key <id> <key>")
    .description(
      "Press a single key on the Computer desktop (e.g. Return, Escape)",
    )
    .option("--json", "Output as JSON")
    .action((id: string, key: string, opts: JsonOptions) =>
      runAction(() => postAndPrint(desktopPath(id, "key"), opts, { key })),
    );

  // -------------------------------------------------------------------------
  // hotkey <id> <keys...>   e.g. miosa computers hotkey abc123 ctrl shift t
  // -------------------------------------------------------------------------
  computers
    .command("hotkey <id> <keys...>")
    .description(
      "Press a key combination on the Computer desktop (e.g. ctrl shift t)",
    )
    .option("--json", "Output as JSON")
    .action((id: string, keys: string[], opts: JsonOptions) =>
      runAction(() => postAndPrint(desktopPath(id, "hotkey"), opts, { keys })),
    );

  // -------------------------------------------------------------------------
  // scroll <id> [--direction down] [--clicks 3]
  // -------------------------------------------------------------------------
  computers
    .command("scroll <id>")
    .description("Scroll on the Computer desktop")
    .option(
      "--direction <direction>",
      "Scroll direction: up, down, left, right",
      "down",
    )
    .option("--clicks <n>", "Number of scroll clicks", "3")
    .option("--x <x>", "X coordinate for scroll position")
    .option("--y <y>", "Y coordinate for scroll position")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: JsonOptions & {
          direction: string;
          clicks: string;
          x?: string;
          y?: string;
        },
      ) =>
        runAction(() => {
          const body: Record<string, unknown> = {
            direction: opts.direction,
            clicks: Number(opts.clicks),
          };
          if (opts.x !== undefined) body["x"] = Number(opts.x);
          if (opts.y !== undefined) body["y"] = Number(opts.y);
          return postAndPrint(desktopPath(id, "scroll"), opts, body);
        }),
    );

  // -------------------------------------------------------------------------
  // drag <id> <fromX> <fromY> <toX> <toY>
  // -------------------------------------------------------------------------
  computers
    .command("drag <id> <fromX> <fromY> <toX> <toY>")
    .description("Drag from one coordinate to another on the Computer desktop")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        fromX: string,
        fromY: string,
        toX: string,
        toY: string,
        opts: JsonOptions,
      ) =>
        runAction(() =>
          postAndPrint(desktopPath(id, "drag"), opts, {
            from_x: Number(fromX),
            from_y: Number(fromY),
            to_x: Number(toX),
            to_y: Number(toY),
          }),
        ),
    );

  // -------------------------------------------------------------------------
  // move-cursor <id> <x> <y>
  // -------------------------------------------------------------------------
  computers
    .command("move-cursor <id> <x> <y>")
    .description("Move the mouse cursor to coordinates on the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, x: string, y: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(desktopPath(id, "move"), opts, {
          x: Number(x),
          y: Number(y),
        }),
      ),
    );

  // -------------------------------------------------------------------------
  // mouse-down <id> <x> <y>
  // -------------------------------------------------------------------------
  computers
    .command("mouse-down <id> <x> <y>")
    .description("Press and hold a mouse button at coordinates")
    .option("--button <button>", "Mouse button: left, right, middle", "left")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        x: string,
        y: string,
        opts: JsonOptions & { button: string },
      ) =>
        runAction(() =>
          postAndPrint(desktopPath(id, "mouse-down"), opts, {
            x: Number(x),
            y: Number(y),
            button: opts.button,
          }),
        ),
    );

  // -------------------------------------------------------------------------
  // mouse-up <id> <x> <y>
  // -------------------------------------------------------------------------
  computers
    .command("mouse-up <id> <x> <y>")
    .description("Release a mouse button at coordinates")
    .option("--button <button>", "Mouse button: left, right, middle", "left")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        x: string,
        y: string,
        opts: JsonOptions & { button: string },
      ) =>
        runAction(() =>
          postAndPrint(desktopPath(id, "mouse-up"), opts, {
            x: Number(x),
            y: Number(y),
            button: opts.button,
          }),
        ),
    );

  // -------------------------------------------------------------------------
  // cursor <id>   — GET current cursor position and type
  // -------------------------------------------------------------------------
  computers
    .command("cursor <id>")
    .description(
      "Get the current cursor position and type on the Computer desktop",
    )
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(desktopPath(id, "cursor"), opts)),
    );

  // -------------------------------------------------------------------------
  // screen-size <id>
  // -------------------------------------------------------------------------
  computers
    .command("screen-size <id>")
    .description("Get the screen dimensions of the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(desktopPath(id, "screen-size"), opts)),
    );

  // -------------------------------------------------------------------------
  // clipboard <id> [--set "text"]
  // -------------------------------------------------------------------------
  computers
    .command("clipboard <id>")
    .description("Get or set clipboard content on the Computer desktop")
    .option("--set <text>", "Write this text to the clipboard (omit to read)")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions & { set?: string }) =>
      runAction(() => {
        if (opts.set !== undefined) {
          return postAndPrint(desktopPath(id, "clipboard"), opts, {
            text: opts.set,
          });
        }
        return getAndPrint(desktopPath(id, "clipboard"), opts);
      }),
    );

  // -------------------------------------------------------------------------
  // windows <id>
  // -------------------------------------------------------------------------
  computers
    .command("windows <id>")
    .description("List open windows on the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(desktopPath(id, "windows"), opts)),
    );

  // -------------------------------------------------------------------------
  // launch <id> <app>
  // -------------------------------------------------------------------------
  computers
    .command("launch <id> <app>")
    .description("Launch an application on the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, app: string, opts: JsonOptions) =>
      runAction(() => postAndPrint(desktopPath(id, "launch"), opts, { app })),
    );

  // -------------------------------------------------------------------------
  // desktop-env <id>
  // -------------------------------------------------------------------------
  computers
    .command("desktop-env <id>")
    .description("Get desktop environment information for the Computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(desktopPath(id, "environment"), opts)),
    );

  // -------------------------------------------------------------------------
  // a11y-tree <id>
  // -------------------------------------------------------------------------
  computers
    .command("a11y-tree <id>")
    .description("Get the accessibility tree for the Computer desktop")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(desktopPath(id, "accessibility-tree"), opts)),
    );
}
