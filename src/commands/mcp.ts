/**
 * miosa mcp serve — expose every major CLI command as an MCP server over stdio.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (newline-delimited).
 *   initialize    → server info + capabilities
 *   tools/list    → all tool schemas
 *   tools/call    → dispatch to MIOSA API
 *
 * Add to .claude/mcp.json:
 * {
 *   "mcpServers": {
 *     "miosa": {
 *       "command": "miosa",
 *       "args": ["mcp", "serve"]
 *     }
 *   }
 * }
 */

import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import type { Command } from "commander";
import { request } from "undici";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";

// ── JSON-RPC 2.0 wire types ──────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP types ────────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

// ── Tool definitions — mirror the Python MCP server exactly ─────────────────

const TOOL_LIST: McpTool[] = [
  // Lifecycle
  {
    name: "computer_create",
    description:
      "Create a new MIOSA computer and wait until it is active. Returns the computer ID. The new computer becomes the active computer for subsequent calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the computer",
        },
        template_type: {
          type: "string",
          description: "Template to boot from (default: miosa-desktop)",
          default: "miosa-desktop",
        },
        size: {
          type: "string",
          enum: ["small", "medium", "large", "xl"],
          description: "VM size (default: small)",
          default: "small",
        },
        workspace_id: {
          type: "string",
          description: "Workspace ID to assign the computer to (optional)",
        },
        external_workspace_id: {
          type: "string",
          description: "Your internal workspace ID for attribution (optional)",
        },
        external_project_id: {
          type: "string",
          description: "Your internal project ID for attribution (optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "computer_list",
    description: "List all computers in the tenant.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_destroy",
    description: "Permanently destroy a computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: {
          type: "string",
          description: "ID of the computer to destroy.",
        },
      },
      required: ["computer_id"],
    },
  },
  // Screenshot
  {
    name: "computer_screenshot",
    description:
      "Capture a PNG screenshot of the computer desktop. Returns the image so you can see the current screen state.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
      },
      required: ["computer_id"],
    },
  },
  // Pointer
  {
    name: "computer_click",
    description: "Click a mouse button at the given screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        x: { type: "integer", description: "X coordinate in pixels" },
        y: { type: "integer", description: "Y coordinate in pixels" },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button (default: left)",
          default: "left",
        },
      },
      required: ["computer_id", "x", "y"],
    },
  },
  {
    name: "computer_double_click",
    description: "Double-click at the given screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      required: ["computer_id", "x", "y"],
    },
  },
  {
    name: "computer_move_cursor",
    description:
      "Move the mouse cursor to the given coordinates without clicking.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      required: ["computer_id", "x", "y"],
    },
  },
  {
    name: "computer_drag",
    description: "Click-and-drag from one screen position to another.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        from_x: { type: "integer" },
        from_y: { type: "integer" },
        to_x: { type: "integer" },
        to_y: { type: "integer" },
      },
      required: ["computer_id", "from_x", "from_y", "to_x", "to_y"],
    },
  },
  {
    name: "computer_scroll",
    description: "Scroll in a direction on the desktop.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          default: "down",
        },
        clicks: {
          type: "integer",
          description: "Number of scroll detents (default: 3)",
          default: 3,
        },
        x: { type: "integer", description: "Optional X position for scroll" },
        y: { type: "integer", description: "Optional Y position for scroll" },
      },
      required: ["computer_id"],
    },
  },
  // Keyboard
  {
    name: "computer_type",
    description: "Type text into the currently focused field.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        text: { type: "string", description: "Text to type" },
      },
      required: ["computer_id", "text"],
    },
  },
  {
    name: "computer_key",
    description:
      "Press a single key. Use standard key names: Return, Tab, Escape, BackSpace, Delete, space, F1-F12, ctrl, shift, alt, super.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        key: { type: "string", description: "Key name to press" },
      },
      required: ["computer_id", "key"],
    },
  },
  {
    name: "computer_hotkey",
    description:
      "Press a keyboard shortcut (multiple keys simultaneously). Example: ['ctrl', 'c'] for copy.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Keys to press together, e.g. ['ctrl', 'c']",
        },
      },
      required: ["computer_id", "keys"],
    },
  },
  // Display info
  {
    name: "computer_get_screen_size",
    description: "Get the screen resolution (width and height in pixels).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_get_cursor_position",
    description: "Get the current mouse cursor position (x, y).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  // Clipboard
  {
    name: "computer_get_clipboard",
    description: "Read the current clipboard text content.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_set_clipboard",
    description: "Set the clipboard text content.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        text: { type: "string", description: "Text to put in clipboard" },
      },
      required: ["computer_id", "text"],
    },
  },
  // Window management
  {
    name: "computer_windows",
    description:
      "List all open windows on the desktop with their IDs, titles, and positions.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_launch",
    description:
      "Launch an application by name (e.g. 'firefox', 'gedit', 'xterm').",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        app: { type: "string", description: "Application name to launch" },
      },
      required: ["computer_id", "app"],
    },
  },
  // Shell & Files
  {
    name: "computer_bash",
    description:
      "Execute a bash command on the computer and return stdout + stderr. Commands run as the default user inside the VM.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        command: { type: "string", description: "Bash command to run" },
        timeout: {
          type: "integer",
          description: "Timeout in seconds (optional)",
        },
      },
      required: ["computer_id", "command"],
    },
  },
  {
    name: "computer_write_file",
    description: "Write text content to a file path inside the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        path: { type: "string", description: "Absolute path inside the VM" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["computer_id", "path", "content"],
    },
  },
  {
    name: "computer_read_file",
    description:
      "Read a file from inside the computer and return its content as text.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        path: { type: "string", description: "Absolute path inside the VM" },
      },
      required: ["computer_id", "path"],
    },
  },
  // Sandboxes
  {
    name: "sandbox_create",
    description:
      "Create a new lightweight code sandbox (Firecracker microVM without desktop).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the sandbox",
        },
        template_id: {
          type: "string",
          description: "Template / image ID (default: miosa-sandbox)",
        },
        cpu_count: { type: "integer", description: "vCPU count" },
        memory_mb: { type: "integer", description: "Memory in MB" },
        timeout_sec: {
          type: "integer",
          description: "Idle timeout in seconds",
        },
      },
    },
  },
  {
    name: "sandbox_exec",
    description: "Run a bash command inside a sandbox and return the output.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        command: { type: "string", description: "Command to run" },
        cwd: { type: "string", description: "Working directory (optional)" },
        timeout: {
          type: "integer",
          description: "Timeout in seconds (optional)",
        },
      },
      required: ["sandbox_id", "command"],
    },
  },
  {
    name: "sandbox_destroy",
    description: "Destroy a sandbox permanently.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID to destroy" },
      },
      required: ["sandbox_id"],
    },
  },
  // Deploy
  {
    name: "deploy",
    description: "Trigger a redeploy for an existing MIOSA deployment.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: {
          type: "string",
          description: "Deployment ID to redeploy",
        },
      },
      required: ["deployment_id"],
    },
  },
];

// ── Wire helpers ─────────────────────────────────────────────────────────────

function ok(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function err(msg: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function image(pngBytes: Buffer): McpToolResult {
  return {
    content: [
      {
        type: "image",
        data: pngBytes.toString("base64"),
        mimeType: "image/png",
      },
    ],
  };
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function dispatchTool(
  client: MiosaClient,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const cid =
    typeof args["computer_id"] === "string" ? args["computer_id"] : undefined;

  try {
    // ── Lifecycle ──────────────────────────────────────────────────────────
    if (name === "computer_create") {
      const body: Record<string, unknown> = { name: args["name"] };
      if (args["template_type"]) body["template_type"] = args["template_type"];
      if (args["size"]) body["size"] = args["size"];
      if (args["workspace_id"]) body["workspace_id"] = args["workspace_id"];
      if (args["external_workspace_id"])
        body["external_workspace_id"] = args["external_workspace_id"];
      if (args["external_project_id"])
        body["external_project_id"] = args["external_project_id"];
      const computer = await client.apiPost<Record<string, unknown>>(
        "/api/v1/computers",
        body,
      );
      const data = unwrapData(computer) as Record<string, unknown>;
      const id = String(data["id"] ?? "");
      const compName = String(data["name"] ?? args["name"]);

      // Poll until the computer reaches "active" state (mirrors Python MCP behaviour)
      const POLL_INTERVAL_MS = 2_000;
      const POLL_TIMEOUT_MS = 30_000;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let finalStatus = String(data["status"] ?? data["state"] ?? "created");

      while (finalStatus !== "active" && Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, POLL_INTERVAL_MS),
        );
        try {
          const poll = await client.apiGet<Record<string, unknown>>(
            `/api/v1/computers/${encodeURIComponent(id)}`,
          );
          const pollData = unwrapData(poll) as Record<string, unknown>;
          finalStatus = String(
            pollData["status"] ?? pollData["state"] ?? finalStatus,
          );
        } catch {
          // Transient error during poll — keep waiting
        }
      }

      return ok(
        `Created computer '${compName}' (id=${id}, status=${finalStatus}).`,
      );
    }

    if (name === "computer_list") {
      const result = await client.apiGet<unknown>("/api/v1/computers");
      const items = listOf(result);
      if (items.length === 0) return ok("No computers found.");
      const lines = ["Available computers:"];
      for (const c of items) {
        const r = c as Record<string, unknown>;
        lines.push(`  ${r["id"]}  ${r["name"]}  ${r["status"] ?? r["state"]}`);
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_destroy") {
      if (!cid) return err("computer_id is required");
      await client.apiDelete(`/api/v1/computers/${encodeURIComponent(cid)}`);
      return ok(`Computer ${cid} destroyed.`);
    }

    // ── Screenshot ────────────────────────────────────────────────────────
    if (name === "computer_screenshot") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/screenshot`,
      );
      // The API returns { data: { image: "<base64>", format: "png" } }
      const data = unwrapData(result) as Record<string, unknown>;
      const b64 = typeof data["image"] === "string" ? data["image"] : null;
      if (!b64) return err("Screenshot API returned no image data");
      return image(Buffer.from(b64, "base64"));
    }

    // ── Pointer ───────────────────────────────────────────────────────────
    if (name === "computer_click") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/click`,
        {
          x: args["x"],
          y: args["y"],
          button: args["button"] ?? "left",
        },
      );
      return ok(
        `Clicked (${args["x"]}, ${args["y"]}) button=${args["button"] ?? "left"}`,
      );
    }

    if (name === "computer_double_click") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/double-click`,
        {
          x: args["x"],
          y: args["y"],
        },
      );
      return ok(`Double-clicked (${args["x"]}, ${args["y"]})`);
    }

    if (name === "computer_move_cursor") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/move`,
        {
          x: args["x"],
          y: args["y"],
        },
      );
      return ok(`Moved cursor to (${args["x"]}, ${args["y"]})`);
    }

    if (name === "computer_drag") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/drag`,
        {
          from_x: args["from_x"],
          from_y: args["from_y"],
          to_x: args["to_x"],
          to_y: args["to_y"],
        },
      );
      return ok(
        `Dragged from (${args["from_x"]}, ${args["from_y"]}) to (${args["to_x"]}, ${args["to_y"]})`,
      );
    }

    if (name === "computer_scroll") {
      if (!cid) return err("computer_id is required");
      const body: Record<string, unknown> = {
        direction: args["direction"] ?? "down",
        clicks: args["clicks"] ?? 3,
      };
      if (args["x"] !== undefined) body["x"] = args["x"];
      if (args["y"] !== undefined) body["y"] = args["y"];
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/scroll`,
        body,
      );
      return ok(`Scrolled ${body["direction"]} by ${body["clicks"]} clicks`);
    }

    // ── Keyboard ──────────────────────────────────────────────────────────
    if (name === "computer_type") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/type`,
        {
          text: args["text"],
        },
      );
      const preview =
        typeof args["text"] === "string"
          ? args["text"].slice(0, 40) + (args["text"].length > 40 ? "..." : "")
          : "";
      return ok(`Typed: ${JSON.stringify(preview)}`);
    }

    if (name === "computer_key") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/key`,
        {
          key: args["key"],
        },
      );
      return ok(`Pressed key: ${args["key"]}`);
    }

    if (name === "computer_hotkey") {
      if (!cid) return err("computer_id is required");
      const keys = args["keys"] as string[];
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/hotkey`,
        {
          keys,
        },
      );
      return ok(`Pressed hotkey: ${keys.join("+")}`);
    }

    // ── Display info ──────────────────────────────────────────────────────
    if (name === "computer_get_screen_size") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/screen-size`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(`Screen size: ${data["width"]}x${data["height"]} px`);
    }

    if (name === "computer_get_cursor_position") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/cursor`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(`Cursor position: x=${data["x"]}, y=${data["y"]}`);
    }

    // ── Clipboard ─────────────────────────────────────────────────────────
    if (name === "computer_get_clipboard") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/clipboard`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(`Clipboard content:\n${data["text"] ?? ""}`);
    }

    if (name === "computer_set_clipboard") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/clipboard`,
        {
          text: args["text"],
        },
      );
      return ok("Clipboard updated.");
    }

    // ── Window management ─────────────────────────────────────────────────
    if (name === "computer_windows") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/windows`,
      );
      const windows = listOf(result);
      if (windows.length === 0) return ok("No open windows found.");
      const lines = ["Open windows:"];
      for (const w of windows) {
        const r = w as Record<string, unknown>;
        const focused = r["focused"] ? " [focused]" : "";
        lines.push(
          `  id=${r["id"]}  title=${JSON.stringify(r["title"])}  app=${JSON.stringify(r["app"])}` +
            `  pos=(${r["x"]},${r["y"]})  size=${r["width"]}x${r["height"]}${focused}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_launch") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/launch`,
        {
          app: args["app"],
        },
      );
      return ok(`Launched: ${args["app"]}`);
    }

    // ── Shell & Files ─────────────────────────────────────────────────────
    if (name === "computer_bash") {
      if (!cid) return err("computer_id is required");
      const body: Record<string, unknown> = { command: args["command"] };
      if (args["timeout"] !== undefined) body["timeout"] = args["timeout"];
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/exec`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const parts: string[] = [];
      if (data["output"] ?? data["stdout"]) {
        parts.push(`stdout:\n${data["output"] ?? data["stdout"]}`);
      }
      if (data["stderr"]) parts.push(`stderr:\n${data["stderr"]}`);
      parts.push(`exit_code: ${data["exit_code"] ?? 0}`);
      return ok(parts.join("\n"));
    }

    if (name === "computer_write_file") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/write`,
        {
          path: args["path"],
          content: args["content"],
          encoding: "utf8",
        },
      );
      const len =
        typeof args["content"] === "string" ? args["content"].length : 0;
      return ok(`Wrote ${len} bytes to ${args["path"]}`);
    }

    if (name === "computer_read_file") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/download?path=${encodeURIComponent(
          String(args["path"] ?? ""),
        )}`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const content =
        typeof data["content"] === "string"
          ? Buffer.from(data["content"], "base64").toString("utf8")
          : typeof data["text"] === "string"
            ? data["text"]
            : JSON.stringify(data);
      return ok(content);
    }

    // ── Sandboxes ─────────────────────────────────────────────────────────
    if (name === "sandbox_create") {
      const body: Record<string, unknown> = {};
      if (args["name"]) body["name"] = args["name"];
      if (args["template_id"]) body["template_id"] = args["template_id"];
      if (args["cpu_count"] !== undefined)
        body["cpu_count"] = args["cpu_count"];
      if (args["memory_mb"] !== undefined)
        body["memory_mb"] = args["memory_mb"];
      if (args["timeout_sec"] !== undefined)
        body["timeout_sec"] = args["timeout_sec"];
      const result = await client.apiPost<unknown>("/api/v1/sandboxes", body);
      const data = unwrapData(result) as Record<string, unknown>;
      const sid = String(data["id"] ?? "");
      return ok(`Created sandbox '${data["name"] ?? sid}' (id=${sid}).`);
    }

    if (name === "sandbox_exec") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const body: Record<string, unknown> = { command: args["command"] };
      if (args["cwd"]) body["cwd"] = args["cwd"];
      if (args["timeout"] !== undefined) body["timeout"] = args["timeout"];
      const result = await client.apiPost<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/exec`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const parts: string[] = [];
      if (data["output"] ?? data["stdout"]) {
        parts.push(`stdout:\n${data["output"] ?? data["stdout"]}`);
      }
      if (data["stderr"]) parts.push(`stderr:\n${data["stderr"]}`);
      parts.push(`exit_code: ${data["exit_code"] ?? 0}`);
      return ok(parts.join("\n"));
    }

    if (name === "sandbox_destroy") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      await client.apiDelete(`/api/v1/sandboxes/${encodeURIComponent(sid)}`);
      return ok(`Sandbox ${sid} destroyed.`);
    }

    // ── Deploy ────────────────────────────────────────────────────────────
    if (name === "deploy") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/deployments/${encodeURIComponent(did)}/redeploy`,
        {},
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(`Redeploy queued (build id: ${data["id"] ?? "unknown"})`);
    }

    return err(`Unknown tool: ${name}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg);
  }
}

// ── Payload helpers ───────────────────────────────────────────────────────────

function unwrapData(payload: unknown): unknown {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in (payload as Record<string, unknown>)
  ) {
    return (payload as Record<string, unknown>)["data"];
  }
  return payload;
}

function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    const r = payload as Record<string, unknown>;
    if (Array.isArray(r["data"])) return r["data"] as unknown[];
  }
  return [];
}

// ── MCP server loop ───────────────────────────────────────────────────────────

async function runServer(): Promise<void> {
  const config = loadConfig();
  if (!config.api_key) {
    process.stderr.write(
      "Error: MIOSA_API_KEY is not set and no saved auth found.\n" +
        "Set MIOSA_API_KEY env var or run: miosa login\n",
    );
    process.exit(1);
  }

  const client = new MiosaClient(config);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }

    const id = req.id ?? null;

    switch (req.method) {
      case "initialize": {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "miosa-mcp", version: "0.1.1" },
          },
        });
        break;
      }

      case "notifications/initialized":
        // No response required for notifications
        break;

      case "tools/list": {
        send({
          jsonrpc: "2.0",
          id,
          result: { tools: TOOL_LIST },
        });
        break;
      }

      case "tools/call": {
        const params = req.params as Record<string, unknown> | undefined;
        const toolName = String(params?.["name"] ?? "");
        const toolArgs = (params?.["arguments"] ?? {}) as Record<
          string,
          unknown
        >;

        const toolResult = await dispatchTool(client, toolName, toolArgs);
        send({ jsonrpc: "2.0", id, result: toolResult });
        break;
      }

      case "ping": {
        send({ jsonrpc: "2.0", id, result: {} });
        break;
      }

      default: {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
    }
  }
}

// ── install: device-flow auth + auto-wire the host MCP into a client ────────

interface DeviceFlow {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  api_key?: string;
  error?: string;
}

const MCP_REMOTE_URL = "https://api.miosa.ai/api/v1/mcp";
const MCP_SERVER_NAME = "miosa";

type SupportedClient = "claude" | "cursor" | "gemini" | "manual";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function postJson<T>(
  endpoint: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await request(`${endpoint.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.statusCode, body: parsed };
}

async function runDeviceFlow(
  endpoint: string,
  clientName: string,
): Promise<string> {
  const start = await postJson<DeviceFlow>(endpoint, "/api/v1/auth/cli/start", {
    client_name: clientName,
  });
  if (start.status >= 400) {
    throw new Error(`Failed to start auth flow (HTTP ${start.status})`);
  }
  const flow = start.body;

  console.log();
  console.log(chalk.bold("Authorize MIOSA MCP for this device"));
  console.log();
  console.log(`  Open: ${chalk.cyan(flow.verification_uri_complete)}`);
  console.log(`  Code: ${chalk.bold(flow.user_code)}`);
  console.log();

  try {
    openUrl(flow.verification_uri_complete);
    console.log(chalk.dim("  Browser opened. Waiting for approval..."));
  } catch {
    console.log(chalk.dim("  Could not open a browser automatically."));
  }

  const deadline = Date.now() + flow.expires_in * 1000;
  const intervalMs = Math.max(flow.interval || 3, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await postJson<TokenResponse>(
      endpoint,
      "/api/v1/auth/cli/token",
      { device_code: flow.device_code },
    );
    if (poll.status === 200 && poll.body.api_key) {
      return poll.body.api_key;
    }
    if (poll.status === 428 || poll.body.error === "authorization_pending") {
      continue;
    }
    if (poll.body.error === "access_denied") {
      throw new Error("Login was denied in the browser.");
    }
    if (poll.body.error === "expired_token" || poll.status === 410) {
      throw new Error("Login request expired. Run the command again.");
    }
    throw new Error(
      `Login failed: ${poll.body.error ?? `HTTP ${poll.status}`}`,
    );
  }

  throw new Error("Login timed out. Run the command again.");
}

function wireClaudeCode(
  apiKey: string,
  remoteUrl: string,
  scope: "local" | "user" | "project",
): { ok: true } | { ok: false; reason: string } {
  // `claude mcp remove` first so re-running install replaces cleanly.
  spawnSync("claude", ["mcp", "remove", MCP_SERVER_NAME, "--scope", scope], {
    stdio: "ignore",
  });

  const result = spawnSync(
    "claude",
    [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      scope,
      MCP_SERVER_NAME,
      remoteUrl,
      "--header",
      `Authorization: Bearer ${apiKey}`,
    ],
    { stdio: "pipe", encoding: "utf8" },
  );

  if (result.error) {
    return {
      ok: false,
      reason: `Could not run \`claude\` CLI: ${result.error.message}`,
    };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    return {
      ok: false,
      reason: result.stderr?.trim() || `claude mcp add exited ${result.status}`,
    };
  }
  return { ok: true };
}

function printManualSnippet(
  client: SupportedClient,
  apiKey: string,
  remoteUrl: string,
): void {
  const masked =
    apiKey.length > 12
      ? apiKey.slice(0, 6) + "…" + apiKey.slice(-4)
      : "msk_u_…";
  console.log();
  console.log(chalk.bold("Manual install snippet"));
  console.log(
    chalk.dim(`  (your key: ${masked} — saved to ~/.miosa/config.json)`),
  );
  console.log();

  if (client === "cursor") {
    console.log(chalk.dim("  Add to ~/.cursor/mcp.json:"));
    console.log();
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            miosa: {
              transport: "http",
              url: remoteUrl,
              headers: { Authorization: `Bearer ${apiKey}` },
            },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (client === "gemini") {
    console.log(
      `  ${chalk.cyan(`gemini mcp add ${MCP_SERVER_NAME} ${remoteUrl} \\`)}`,
    );
    console.log(
      `    ${chalk.cyan(`--header "Authorization: Bearer ${apiKey}"`)}`,
    );
    return;
  }

  // claude / manual
  console.log(
    `  ${chalk.cyan(`claude mcp add --transport http --scope user ${MCP_SERVER_NAME} \\`)}`,
  );
  console.log(`    ${chalk.cyan(remoteUrl + " \\")}`);
  console.log(
    `    ${chalk.cyan(`--header "Authorization: Bearer ${apiKey}"`)}`,
  );
}

async function runInstall(opts: {
  client: SupportedClient;
  scope: "local" | "user" | "project";
  remoteUrl: string;
}): Promise<void> {
  const config = loadConfig();
  const clientName = `MIOSA MCP (${opts.client === "manual" ? "manual" : opts.client})`;

  console.log(
    chalk.bold("MIOSA MCP installer"),
    chalk.dim(`— wiring ${opts.client} → ${opts.remoteUrl}`),
  );

  const apiKey = await runDeviceFlow(config.endpoint, clientName);

  if (opts.client === "claude") {
    const wired = wireClaudeCode(apiKey, opts.remoteUrl, opts.scope);
    if (wired.ok) {
      console.log();
      console.log(
        chalk.green("✓"),
        `MCP server '${MCP_SERVER_NAME}' added to Claude Code (${opts.scope} scope).`,
      );
      console.log();
      console.log(chalk.dim("Verify:"));
      console.log(`  ${chalk.cyan("claude mcp list")}`);
      console.log();
      console.log(chalk.dim("Try in a fresh Claude Code session:"));
      console.log(
        chalk.dim(
          `  "Create a MIOSA sandbox, run \`python -c 'print(2+2)'\`, then destroy it."`,
        ),
      );
      return;
    }
    console.log();
    console.log(
      chalk.yellow("!"),
      `Could not auto-wire Claude Code: ${wired.reason}`,
    );
    console.log(chalk.yellow("  Falling back to manual snippet:"));
    printManualSnippet("claude", apiKey, opts.remoteUrl);
    return;
  }

  // cursor / gemini / manual — print the snippet
  printManualSnippet(opts.client, apiKey, opts.remoteUrl);
}

// ── Commander registration ────────────────────────────────────────────────────

export function register(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Model Context Protocol — expose MIOSA tools to AI agents");

  mcp
    .command("serve")
    .description(
      "Start an MCP server over stdio (JSON-RPC 2.0). Add to .claude/mcp.json to use with Claude.",
    )
    .action(() => {
      runServer().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`miosa mcp serve fatal: ${msg}\n`);
        process.exit(1);
      });
    });

  mcp
    .command("install")
    .description(
      "Install the hosted MIOSA MCP server (https://api.miosa.ai/api/v1/mcp) into your AI client. Opens a browser to log in and wire your account.",
    )
    .option(
      "-c, --client <client>",
      "Which AI client to wire: claude (default), cursor, gemini, manual",
      "claude",
    )
    .option(
      "-s, --scope <scope>",
      "Claude Code config scope: local, user (default), or project",
      "user",
    )
    .option(
      "--url <url>",
      "Override the hosted MCP URL (default: https://api.miosa.ai/api/v1/mcp)",
      MCP_REMOTE_URL,
    )
    .action(async (opts: { client: string; scope: string; url: string }) => {
      const client = (
        ["claude", "cursor", "gemini", "manual"].includes(opts.client)
          ? opts.client
          : "claude"
      ) as SupportedClient;
      const scope = (
        ["local", "user", "project"].includes(opts.scope) ? opts.scope : "user"
      ) as "local" | "user" | "project";
      try {
        await runInstall({ client, scope, remoteUrl: opts.url });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(3);
      }
    });
}
