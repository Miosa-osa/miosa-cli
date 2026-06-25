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
  {
    name: "computer_get",
    description: "Get details and current status of a computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: {
          type: "string",
          description: "ID of the computer to fetch.",
        },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_start",
    description: "Start a stopped computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_stop",
    description: "Stop a running computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_restart",
    description: "Restart a computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_update",
    description: "Rename a computer or update its metadata.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        name: {
          type: "string",
          description: "New human-readable name for the computer (optional).",
        },
        metadata: {
          type: "object",
          description: "Arbitrary key/value metadata to attach (optional).",
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
  // Desktop — extended pointer / keyboard / window / env
  {
    name: "computer_right_click",
    description: "Right-click at the given screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        x: { type: "integer", description: "X coordinate in pixels" },
        y: { type: "integer", description: "Y coordinate in pixels" },
      },
      required: ["computer_id", "x", "y"],
    },
  },
  {
    name: "computer_mouse_down",
    description:
      "Press and hold a mouse button at (x, y). Pair with computer_mouse_up to release.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        x: { type: "integer" },
        y: { type: "integer" },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left",
        },
      },
      required: ["computer_id", "x", "y"],
    },
  },
  {
    name: "computer_mouse_up",
    description: "Release a held mouse button at (x, y).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        x: { type: "integer" },
        y: { type: "integer" },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left",
        },
      },
      required: ["computer_id", "x", "y"],
    },
  },
  {
    name: "computer_key_down",
    description:
      "Press and hold a key without releasing it. Pair with computer_key_up.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        key: { type: "string", description: "Key name to hold down" },
      },
      required: ["computer_id", "key"],
    },
  },
  {
    name: "computer_key_up",
    description: "Release a previously held key.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        key: { type: "string", description: "Key name to release" },
      },
      required: ["computer_id", "key"],
    },
  },
  {
    name: "computer_wait",
    description: "Pause execution inside the computer for N seconds.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        seconds: {
          type: "number",
          description: "Seconds to wait (may be fractional, e.g. 0.5)",
        },
      },
      required: ["computer_id", "seconds"],
    },
  },
  {
    name: "computer_focus_window",
    description: "Bring a window to the foreground by its window ID.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        window_id: {
          type: "string",
          description: "Window ID from computer_windows",
        },
      },
      required: ["computer_id", "window_id"],
    },
  },
  {
    name: "computer_set_window_size",
    description: "Resize a window to the given width and height in pixels.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        window_id: {
          type: "string",
          description: "Window ID from computer_windows",
        },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["computer_id", "window_id", "width", "height"],
    },
  },
  {
    name: "computer_set_window_position",
    description: "Move a window to the given screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        window_id: {
          type: "string",
          description: "Window ID from computer_windows",
        },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      required: ["computer_id", "window_id", "x", "y"],
    },
  },
  {
    name: "computer_maximize_window",
    description: "Maximize a window.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        window_id: {
          type: "string",
          description: "Window ID from computer_windows",
        },
      },
      required: ["computer_id", "window_id"],
    },
  },
  {
    name: "computer_minimize_window",
    description: "Minimize (iconify) a window.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        window_id: {
          type: "string",
          description: "Window ID from computer_windows",
        },
      },
      required: ["computer_id", "window_id"],
    },
  },
  {
    name: "computer_close_window",
    description: "Close a window.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        window_id: {
          type: "string",
          description: "Window ID from computer_windows",
        },
      },
      required: ["computer_id", "window_id"],
    },
  },
  {
    name: "computer_get_desktop_env",
    description:
      "Get desktop environment info (name, resolution, session type).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_set_wallpaper",
    description:
      "Set the desktop wallpaper. Accepts an absolute path inside the VM (e.g. '/home/ubuntu/bg.png') or an https:// URL.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
        path: {
          type: "string",
          description:
            "Absolute VM path or https:// URL for the wallpaper image",
        },
      },
      required: ["computer_id", "path"],
    },
  },
  {
    name: "computer_accessibility_tree",
    description:
      "Get the AT-SPI accessibility tree for the current desktop state. Returns a nested JSON structure describing all visible UI elements with roles, names, bounding boxes, and parent/child relationships.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string", description: "Computer ID." },
      },
      required: ["computer_id"],
    },
  },
  // Files — extended
  {
    name: "computer_list_files",
    description: "List directory contents on the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        path: {
          type: "string",
          description: "Directory path to list (default: /)",
        },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_stat_file",
    description:
      "Get file/directory metadata (size, type, permissions, mtime) inside the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        path: { type: "string", description: "Absolute path inside the VM" },
      },
      required: ["computer_id", "path"],
    },
  },
  {
    name: "computer_mkdir",
    description:
      "Create a directory (and any missing parents) inside the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        path: {
          type: "string",
          description: "Absolute directory path to create",
        },
        recursive: {
          type: "boolean",
          description: "Create parent directories if missing (default: true)",
          default: true,
        },
      },
      required: ["computer_id", "path"],
    },
  },
  {
    name: "computer_rename_file",
    description: "Rename or move a file/directory inside the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        source: { type: "string", description: "Current absolute path" },
        dest: { type: "string", description: "New absolute path" },
      },
      required: ["computer_id", "source", "dest"],
    },
  },
  {
    name: "computer_copy_file",
    description: "Copy a file or directory tree inside the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        source: { type: "string", description: "Source absolute path" },
        dest: { type: "string", description: "Destination absolute path" },
        recursive: {
          type: "boolean",
          description: "Copy directory trees recursively (default: false)",
          default: false,
        },
      },
      required: ["computer_id", "source", "dest"],
    },
  },
  {
    name: "computer_delete_file",
    description: "Delete a file or directory inside the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        path: { type: "string", description: "Absolute path to delete" },
      },
      required: ["computer_id", "path"],
    },
  },
  {
    name: "computer_upload_file",
    description:
      "Upload a local file from the host machine into the computer at a given path.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        local_path: {
          type: "string",
          description: "Absolute path on the local host to upload",
        },
        remote_path: {
          type: "string",
          description: "Destination absolute path inside the VM",
        },
      },
      required: ["computer_id", "local_path", "remote_path"],
    },
  },
  // Checkpoints
  {
    name: "computer_checkpoint_create",
    description:
      "Save the current state of the computer as a checkpoint (snapshot).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        comment: {
          type: "string",
          description: "Optional human-readable label for the checkpoint",
        },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_checkpoint_list",
    description: "List all saved checkpoints for the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_checkpoint_restore",
    description: "Restore the computer to a previously saved checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        checkpoint_id: {
          type: "string",
          description: "ID of the checkpoint to restore",
        },
      },
      required: ["computer_id", "checkpoint_id"],
    },
  },
  {
    name: "computer_checkpoint_delete",
    description: "Delete a saved checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        checkpoint_id: {
          type: "string",
          description: "ID of the checkpoint to delete",
        },
      },
      required: ["computer_id", "checkpoint_id"],
    },
  },
  // Services
  {
    name: "computer_service_create",
    description:
      "Create and start a long-running background service on the computer (like systemd — process manager for your VM).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        name: { type: "string", description: "Service name (must be unique)" },
        command: { type: "string", description: "Shell command to run" },
        working_dir: {
          type: "string",
          description: "Working directory for the service (optional)",
        },
        port: {
          type: "integer",
          description: "Port the service listens on (optional)",
        },
        restart_policy: {
          type: "string",
          enum: ["always", "on-failure", "never"],
          description: "Restart behaviour (default: always)",
        },
      },
      required: ["computer_id", "name", "command"],
    },
  },
  {
    name: "computer_service_list",
    description: "List all background services registered on the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_service_start",
    description: "Start a stopped background service.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        service_id: { type: "string", description: "Service ID to start" },
      },
      required: ["computer_id", "service_id"],
    },
  },
  {
    name: "computer_service_stop",
    description: "Stop a running background service (sends SIGTERM).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        service_id: { type: "string", description: "Service ID to stop" },
      },
      required: ["computer_id", "service_id"],
    },
  },
  {
    name: "computer_service_restart",
    description: "Restart a background service (stop then start).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        service_id: { type: "string", description: "Service ID to restart" },
      },
      required: ["computer_id", "service_id"],
    },
  },
  {
    name: "computer_service_logs",
    description:
      "Retrieve recent log output from a background service (last 100 lines).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        service_id: { type: "string", description: "Service ID" },
      },
      required: ["computer_id", "service_id"],
    },
  },
  {
    name: "computer_service_delete",
    description: "Delete a background service (stops it first if running).",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        service_id: { type: "string", description: "Service ID to delete" },
      },
      required: ["computer_id", "service_id"],
    },
  },
  // Env vars
  {
    name: "computer_env_list",
    description: "List all environment variables set on the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_env_set",
    description:
      "Set (create or update) an environment variable on the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        name: { type: "string", description: "Variable name" },
        value: { type: "string", description: "Variable value" },
      },
      required: ["computer_id", "name", "value"],
    },
  },
  {
    name: "computer_env_delete",
    description: "Delete an environment variable from the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        name: {
          type: "string",
          description: "Variable name to delete",
        },
      },
      required: ["computer_id", "name"],
    },
  },
  // Logs
  {
    name: "computer_logs",
    description: "Get recent VM-level logs from the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        lines: {
          type: "integer",
          description: "Number of recent log lines to return (optional)",
        },
      },
      required: ["computer_id"],
    },
  },
  // Domains
  {
    name: "computer_domain_add",
    description:
      "Add a custom domain to the computer. Returns CNAME verification instructions to add to your DNS registrar.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        fqdn: {
          type: "string",
          description: "Fully-qualified domain name (e.g. app.example.com)",
        },
      },
      required: ["computer_id", "fqdn"],
    },
  },
  {
    name: "computer_domain_list",
    description: "List all custom domains registered for the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "computer_domain_delete",
    description: "Delete a custom domain mapping from the computer.",
    inputSchema: {
      type: "object",
      properties: {
        computer_id: { type: "string" },
        domain_id: {
          type: "string",
          description: "Domain ID to delete",
        },
      },
      required: ["computer_id", "domain_id"],
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
  // Sandbox lifecycle (list/get/pause/resume)
  {
    name: "sandbox_list",
    description: "List all sandboxes in the tenant.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["provisioning", "running", "paused", "destroyed", "error"],
          description: "Filter by state (optional)",
        },
      },
    },
  },
  {
    name: "sandbox_get",
    description: "Get details of a specific sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
      },
      required: ["sandbox_id"],
    },
  },
  {
    name: "sandbox_pause",
    description: "Pause a running sandbox (suspends it to save compute).",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
      },
      required: ["sandbox_id"],
    },
  },
  {
    name: "sandbox_resume",
    description: "Resume a paused sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
      },
      required: ["sandbox_id"],
    },
  },
  // Sandbox files
  {
    name: "sandbox_write_file",
    description: "Write text content to a file path inside a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        path: {
          type: "string",
          description: "Absolute path inside the sandbox",
        },
        content: { type: "string", description: "File content (text)" },
      },
      required: ["sandbox_id", "path", "content"],
    },
  },
  {
    name: "sandbox_read_file",
    description:
      "Read a file from inside a sandbox and return its content as text.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        path: {
          type: "string",
          description: "Absolute path inside the sandbox",
        },
      },
      required: ["sandbox_id", "path"],
    },
  },
  {
    name: "sandbox_list_files",
    description: "List files in a directory inside a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        path: {
          type: "string",
          description: "Directory path to list (default: /workspace)",
          default: "/workspace",
        },
        depth: { type: "integer", description: "Recursion depth (optional)" },
      },
      required: ["sandbox_id"],
    },
  },
  {
    name: "sandbox_upload",
    description: "Upload a file (UTF-8 text or base64 binary) into a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        path: {
          type: "string",
          description: "Destination path inside the sandbox",
        },
        content: {
          type: "string",
          description: "File content as UTF-8 text or base64-encoded binary",
        },
      },
      required: ["sandbox_id", "path", "content"],
    },
  },
  // Sandbox exec
  {
    name: "sandbox_python",
    description:
      "Run Python code inside a sandbox and return stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        code: { type: "string", description: "Python code to execute" },
        timeout: {
          type: "integer",
          description: "Timeout in seconds (optional)",
        },
      },
      required: ["sandbox_id", "code"],
    },
  },
  // Sandbox snapshots
  {
    name: "sandbox_snapshot_create",
    description: "Create a snapshot of the current sandbox state.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        comment: {
          type: "string",
          description: "Optional comment for the snapshot",
        },
      },
      required: ["sandbox_id"],
    },
  },
  {
    name: "sandbox_snapshot_list",
    description: "List all snapshots for a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
      },
      required: ["sandbox_id"],
    },
  },
  {
    name: "sandbox_snapshot_restore",
    description: "Restore a sandbox from a specific snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        snapshot_id: {
          type: "string",
          description: "Snapshot ID to restore from",
        },
      },
      required: ["sandbox_id", "snapshot_id"],
    },
  },
  // Sandbox logs
  {
    name: "sandbox_logs",
    description: "Get logs from a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        lines: {
          type: "integer",
          description: "Number of log lines to return (optional)",
        },
      },
      required: ["sandbox_id"],
    },
  },
  // Sandbox preview
  {
    name: "sandbox_expose",
    description:
      "Expose a port on a sandbox and return a publicly accessible preview URL.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        port: {
          type: "integer",
          description:
            "Port number to expose (optional; exposes default port if omitted)",
        },
      },
      required: ["sandbox_id"],
    },
  },
  // Sandbox deploy
  {
    name: "sandbox_deploy",
    description: "Deploy sandbox contents to production.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_id: { type: "string", description: "Sandbox ID" },
        name: { type: "string", description: "Deployment name (optional)" },
        output_path: {
          type: "string",
          description: "Path inside the sandbox to deploy (optional)",
        },
        entrypoint: {
          type: "string",
          description: "Entrypoint command or file (optional)",
        },
        domain: { type: "string", description: "Custom domain (optional)" },
      },
      required: ["sandbox_id"],
    },
  },
  // Sandbox templates
  {
    name: "sandbox_template_list",
    description: "List available sandbox templates.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sandbox_template_create",
    description: "Create a custom sandbox template from a build spec.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Template name" },
        build_spec: {
          type: "object",
          description: "Build specification (Dockerfile, packages, etc.)",
        },
        slug: {
          type: "string",
          description: "URL-friendly identifier (optional)",
        },
        description: {
          type: "string",
          description: "Human-readable description (optional)",
        },
      },
      required: ["name", "build_spec"],
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
  // Deployments
  {
    name: 'deployment_list',
    description: 'List all deployments in the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'deployment_get',
    description: 'Get details of a specific deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
      },
      required: ['deployment_id'],
    },
  },
  {
    name: 'deployment_create',
    description: 'Create a new deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Deployment name' },
        type: { type: 'string', description: 'Deployment type (e.g. web, worker)' },
        source: { type: 'object', description: 'Source configuration' },
        env_vars: { type: 'object', description: 'Environment variables as key-value pairs' },
        region: { type: 'string', description: 'Deployment region (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'deployment_delete',
    description: 'Delete a deployment permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID to delete' },
      },
      required: ['deployment_id'],
    },
  },
  {
    name: 'deployment_publish',
    description: 'Publish a new version of a deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
        source: { type: 'object', description: 'Source configuration for the new version' },
      },
      required: ['deployment_id'],
    },
  },
  {
    name: 'deployment_rollback',
    description: 'Rollback a deployment to a previous version.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
        version_id: { type: 'string', description: 'Version ID to roll back to' },
      },
      required: ['deployment_id', 'version_id'],
    },
  },
  {
    name: 'deployment_env_list',
    description: 'List environment variables for a deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
      },
      required: ['deployment_id'],
    },
  },
  {
    name: 'deployment_env_set',
    description: 'Set (create or update) an environment variable for a deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
        key: { type: 'string', description: 'Environment variable name' },
        value: { type: 'string', description: 'Environment variable value' },
      },
      required: ['deployment_id', 'key', 'value'],
    },
  },
  {
    name: 'deployment_logs',
    description: 'Get logs for a deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
        lines: { type: 'integer', description: 'Number of log lines to return (default: 100)', default: 100 },
        since: { type: 'string', description: 'ISO 8601 timestamp to fetch logs from (optional)' },
      },
      required: ['deployment_id'],
    },
  },
  {
    name: 'deployment_version_list',
    description: 'List all versions of a deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
      },
      required: ['deployment_id'],
    },
  },
  {
    name: 'deployment_version_promote',
    description: 'Promote a specific version to be the active deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Deployment ID' },
        version_id: { type: 'string', description: 'Version ID to promote' },
      },
      required: ['deployment_id', 'version_id'],
    },
  },
  // Storage
  {
    name: 'storage_bucket_list',
    description: 'List all storage buckets in the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'storage_bucket_create',
    description: 'Create a new storage bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        region: { type: 'string', description: 'Bucket region (optional)' },
        public: { type: 'boolean', description: 'Whether the bucket is publicly readable (default: false)', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'storage_bucket_delete',
    description: 'Delete a storage bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket_id: { type: 'string', description: 'Bucket ID or name to delete' },
      },
      required: ['bucket_id'],
    },
  },
  {
    name: 'storage_object_list',
    description: 'List objects in a storage bucket, optionally filtered by prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket_id: { type: 'string', description: 'Bucket ID or name' },
        prefix: { type: 'string', description: 'Key prefix to filter by (optional)' },
      },
      required: ['bucket_id'],
    },
  },
  {
    name: 'storage_object_upload',
    description: 'Upload an object to a storage bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket_id: { type: 'string', description: 'Bucket ID or name' },
        key: { type: 'string', description: 'Object key (path within bucket)' },
        content: { type: 'string', description: 'Object content (text or base64-encoded binary)' },
        content_type: { type: 'string', description: 'MIME type of the object (optional)' },
      },
      required: ['bucket_id', 'key', 'content'],
    },
  },
  {
    name: 'storage_object_download',
    description: 'Download an object from a storage bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket_id: { type: 'string', description: 'Bucket ID or name' },
        key: { type: 'string', description: 'Object key to download' },
      },
      required: ['bucket_id', 'key'],
    },
  },
  {
    name: 'storage_object_delete',
    description: 'Delete an object from a storage bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket_id: { type: 'string', description: 'Bucket ID or name' },
        key: { type: 'string', description: 'Object key to delete' },
      },
      required: ['bucket_id', 'key'],
    },
  },
  {
    name: 'storage_presign',
    description: 'Get a presigned URL for temporary access to a storage object.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket_id: { type: 'string', description: 'Bucket ID or name' },
        key: { type: 'string', description: 'Object key' },
        expires_in: { type: 'integer', description: 'URL expiry in seconds (default: 3600)', default: 3600 },
        method: { type: 'string', enum: ['GET', 'PUT'], description: 'HTTP method (default: GET)', default: 'GET' },
      },
      required: ['bucket_id', 'key'],
    },
  },
  // Databases
  {
    name: 'database_list',
    description: 'List all managed databases in the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'database_create',
    description: 'Create a new managed database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Database name' },
        engine: { type: 'string', enum: ['postgres', 'postgresql', 'mysql', 'redis'], description: 'Database engine' },
        version: { type: 'string', description: 'Engine version (optional)' },
        size: { type: 'string', description: 'Database size/tier (optional)' },
        region: { type: 'string', description: 'Region (optional)' },
      },
      required: ['name', 'engine'],
    },
  },
  {
    name: 'database_get',
    description: 'Get details of a specific database.',
    inputSchema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'Database ID' },
      },
      required: ['database_id'],
    },
  },
  {
    name: 'database_delete',
    description: 'Delete a managed database permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'Database ID to delete' },
      },
      required: ['database_id'],
    },
  },
  {
    name: 'database_credentials',
    description: 'Get the connection string and credentials for a database.',
    inputSchema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'Database ID' },
      },
      required: ['database_id'],
    },
  },
  {
    name: 'database_logs',
    description: 'Get logs for a managed database.',
    inputSchema: {
      type: 'object',
      properties: {
        database_id: { type: 'string', description: 'Database ID' },
        lines: { type: 'integer', description: 'Number of log lines to return (default: 100)', default: 100 },
        since: { type: 'string', description: 'ISO 8601 timestamp to fetch logs from (optional)' },
      },
      required: ['database_id'],
    },
  },
  // Workspaces
  {
    name: 'workspace_list',
    description: 'List all workspaces in the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'workspace_create',
    description: 'Create a new workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace name' },
        description: { type: 'string', description: 'Workspace description (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'workspace_get',
    description: 'Get details of a specific workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'workspace_update',
    description: "Update a workspace's name or description.",
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' },
        name: { type: 'string', description: 'New workspace name (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'workspace_stats',
    description: 'Get resource statistics for a workspace (computers, sandboxes, databases, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'workspace_usage',
    description: 'Get usage data (compute hours, storage, bandwidth) for a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID' },
        period: { type: 'string', description: "Billing period (e.g. '2026-05'). Defaults to current month." },
      },
      required: ['workspace_id'],
    },
  },
  // Billing
  {
    name: 'billing_usage',
    description: 'Get current billing period usage for the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'billing_plan',
    description: 'Get the current billing plan details for the tenant.',
    inputSchema: { type: 'object', properties: {} },
  },
];


// ── Wire helpers ─────────────────────────────────────────────────────────────

function ok(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function err(msg: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandInCwd(command: string, cwd?: string): string {
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

function normalizeDatabaseEngine(engine: unknown): string {
  const value = String(engine ?? "postgresql").trim().toLowerCase();
  return value === "postgres" ? "postgresql" : value;
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

    if (name === "computer_get") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `id=${data["id"]}  name=${JSON.stringify(data["name"])}  status=${data["status"] ?? data["state"]}`,
      );
    }

    if (name === "computer_start") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/start`,
        {},
      );
      return ok(`Computer ${cid} start issued.`);
    }

    if (name === "computer_stop") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/stop`,
        {},
      );
      return ok(`Computer ${cid} stop issued.`);
    }

    if (name === "computer_restart") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/restart`,
        {},
      );
      return ok(`Computer ${cid} restart issued.`);
    }

    if (name === "computer_update") {
      if (!cid) return err("computer_id is required");
      const body: Record<string, unknown> = {};
      if (typeof args["name"] === "string") body["name"] = args["name"];
      if (args["metadata"] !== undefined) body["metadata"] = args["metadata"];
      const result = await client.apiPatch<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Computer ${cid} updated: name=${JSON.stringify(data["name"] ?? args["name"])}.`,
      );
    }

    // ── Screenshot ────────────────────────────────────────────────────────
    if (name === "computer_screenshot") {
      if (!cid) return err("computer_id is required");
      const png = await client.apiGetBinary(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/screenshot`,
      );
      return image(png);
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

    // ── Extended pointer ──────────────────────────────────────────────────
    if (name === "computer_right_click") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/click`,
        { x: args["x"], y: args["y"], button: "right" },
      );
      return ok(`Right-clicked (${args["x"]}, ${args["y"]})`);
    }

    if (name === "computer_mouse_down") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/mouse-down`,
        {
          x: args["x"],
          y: args["y"],
          button: args["button"] ?? "left",
        },
      );
      return ok(
        `Mouse down at (${args["x"]}, ${args["y"]}) button=${args["button"] ?? "left"}`,
      );
    }

    if (name === "computer_mouse_up") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/mouse-up`,
        {
          x: args["x"],
          y: args["y"],
          button: args["button"] ?? "left",
        },
      );
      return ok(
        `Mouse up at (${args["x"]}, ${args["y"]}) button=${args["button"] ?? "left"}`,
      );
    }

    // ── Extended keyboard ─────────────────────────────────────────────────
    if (name === "computer_key_down") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/key-down`,
        { key: args["key"] },
      );
      return ok(`Key down: ${args["key"]}`);
    }

    if (name === "computer_key_up") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/key-up`,
        { key: args["key"] },
      );
      return ok(`Key up: ${args["key"]}`);
    }

    // ── Wait ──────────────────────────────────────────────────────────────
    if (name === "computer_wait") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/wait`,
        { seconds: args["seconds"] },
      );
      return ok(`Waited ${args["seconds"]}s`);
    }

    // ── Window management (extended) ──────────────────────────────────────
    if (name === "computer_focus_window") {
      if (!cid) return err("computer_id is required");
      const wid = String(args["window_id"] ?? "");
      if (!wid) return err("window_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/window/focus`,
        { window_id: wid },
      );
      return ok(`Focused window ${wid}`);
    }

    if (name === "computer_set_window_size") {
      if (!cid) return err("computer_id is required");
      const wid = String(args["window_id"] ?? "");
      if (!wid) return err("window_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/window/${encodeURIComponent(wid)}/resize`,
        { width: args["width"], height: args["height"] },
      );
      return ok(`Resized window ${wid} to ${args["width"]}x${args["height"]}`);
    }

    if (name === "computer_set_window_position") {
      if (!cid) return err("computer_id is required");
      const wid = String(args["window_id"] ?? "");
      if (!wid) return err("window_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/window/${encodeURIComponent(wid)}/move`,
        { x: args["x"], y: args["y"] },
      );
      return ok(`Moved window ${wid} to (${args["x"]}, ${args["y"]})`);
    }

    if (name === "computer_maximize_window") {
      if (!cid) return err("computer_id is required");
      const wid = String(args["window_id"] ?? "");
      if (!wid) return err("window_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/window/${encodeURIComponent(wid)}/maximize`,
        {},
      );
      return ok(`Maximized window ${wid}`);
    }

    if (name === "computer_minimize_window") {
      if (!cid) return err("computer_id is required");
      const wid = String(args["window_id"] ?? "");
      if (!wid) return err("window_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/window/${encodeURIComponent(wid)}/minimize`,
        {},
      );
      return ok(`Minimized window ${wid}`);
    }

    if (name === "computer_close_window") {
      if (!cid) return err("computer_id is required");
      const wid = String(args["window_id"] ?? "");
      if (!wid) return err("window_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/window/${encodeURIComponent(wid)}/close`,
        {},
      );
      return ok(`Closed window ${wid}`);
    }

    // ── Desktop environment ───────────────────────────────────────────────
    if (name === "computer_get_desktop_env") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/environment`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `desktop_env: name=${JSON.stringify(data["name"])}  resolution=${data["resolution"]}  session_type=${JSON.stringify(data["session_type"])}`,
      );
    }

    if (name === "computer_set_wallpaper") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/wallpaper`,
        { path: args["path"] },
      );
      return ok(`Wallpaper set to: ${args["path"]}`);
    }

    if (name === "computer_accessibility_tree") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/desktop/accessibility-tree`,
      );
      const tree = unwrapData(result);
      const json = JSON.stringify(tree, null, 2);
      return ok(
        json.length > 8000 ? json.slice(0, 8000) + "\n…(truncated)" : json,
      );
    }

    // ── Files — extended ──────────────────────────────────────────────────
    if (name === "computer_list_files") {
      if (!cid) return err("computer_id is required");
      const path = typeof args["path"] === "string" ? args["path"] : undefined;
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/files${qs}`,
      );
      const items = listOf(result);
      if (items.length === 0) return ok(`No files found at ${path ?? "/"}.`);
      const lines = [`Files at ${path ?? "/"}:`];
      for (const e of items) {
        const r = e as Record<string, unknown>;
        lines.push(
          `  ${r["name"]}  ${r["type"] ?? r["kind"] ?? ""}  ${r["size"] ?? ""}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_stat_file") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/stat`,
        { path: args["path"] },
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const lines = [
        `path: ${args["path"]}`,
        `type: ${data["type"] ?? data["kind"] ?? ""}`,
        `size: ${data["size"] ?? ""}`,
        `mode: ${data["mode"] ?? ""}`,
        `mtime: ${data["mtime"] ?? data["modified_at"] ?? ""}`,
      ];
      return ok(lines.join("\n"));
    }

    if (name === "computer_mkdir") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/mkdir`,
        {
          path: args["path"],
          recursive: args["recursive"] !== false,
          mode: "0755",
        },
      );
      return ok(`Created directory ${args["path"]}`);
    }

    if (name === "computer_rename_file") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/rename`,
        { from: args["source"], to: args["dest"] },
      );
      return ok(`Renamed ${args["source"]} -> ${args["dest"]}`);
    }

    if (name === "computer_copy_file") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/copy`,
        {
          from: args["source"],
          to: args["dest"],
          recursive: args["recursive"] === true,
        },
      );
      return ok(`Copied ${args["source"]} -> ${args["dest"]}`);
    }

    if (name === "computer_delete_file") {
      if (!cid) return err("computer_id is required");
      await client.apiDelete(
        `/api/v1/computers/${encodeURIComponent(cid)}/files?path=${encodeURIComponent(String(args["path"] ?? ""))}`,
      );
      return ok(`Deleted ${args["path"]}`);
    }

    if (name === "computer_upload_file") {
      if (!cid) return err("computer_id is required");
      // Read the local file and POST it as base64 via the write endpoint
      const fs = await import("node:fs/promises");
      const localBytes = await fs.readFile(String(args["local_path"]));
      await client.apiPost(
        `/api/v1/computers/${encodeURIComponent(cid)}/files/write`,
        {
          path: args["remote_path"],
          content: localBytes.toString("base64"),
          encoding: "base64",
        },
      );
      return ok(`Uploaded ${args["local_path"]} -> ${args["remote_path"]}`);
    }

    // ── Checkpoints ───────────────────────────────────────────────────────
    if (name === "computer_checkpoint_create") {
      if (!cid) return err("computer_id is required");
      const body: Record<string, unknown> = {};
      if (args["comment"]) body["comment"] = args["comment"];
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/snapshots`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const snap_id = String(data["id"] ?? "");
      const snap_status = String(data["status"] ?? "");
      const snap_comment = data["comment"]
        ? `  comment=${JSON.stringify(data["comment"])}`
        : "";
      return ok(
        `Checkpoint created: id=${snap_id}  status=${snap_status}${snap_comment}`,
      );
    }

    if (name === "computer_checkpoint_list") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/snapshots`,
      );
      const items = listOf(result);
      if (items.length === 0) return ok("No checkpoints found.");
      const lines = ["Checkpoints:"];
      for (const s of items) {
        const r = s as Record<string, unknown>;
        const c = r["comment"] ? `  ${JSON.stringify(r["comment"])}` : "";
        lines.push(
          `  ${r["id"]}  ${r["status"]}  ${r["created_at"] ?? ""}${c}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_checkpoint_restore") {
      if (!cid) return err("computer_id is required");
      const snapId = String(args["checkpoint_id"] ?? "");
      if (!snapId) return err("checkpoint_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/restore/${encodeURIComponent(snapId)}`,
        {},
      );
      const raw = unwrapData(result) as Record<string, unknown>;
      const compData =
        (raw["computer"] as Record<string, unknown> | undefined) ?? raw;
      const newId = String(compData["id"] ?? "");
      const newStatus = String(compData["status"] ?? compData["state"] ?? "");
      return ok(
        `Restored checkpoint ${snapId} -> new computer id=${newId}  status=${newStatus}.`,
      );
    }

    if (name === "computer_checkpoint_delete") {
      if (!cid) return err("computer_id is required");
      const snapId = String(args["checkpoint_id"] ?? "");
      if (!snapId) return err("checkpoint_id is required");
      const result = await client.apiDelete(
        `/api/v1/computers/${encodeURIComponent(cid)}/snapshots/${encodeURIComponent(snapId)}`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Checkpoint ${data["id"] ?? snapId} deleted (status=${data["status"] ?? "deleted"}).`,
      );
    }

    // ── Services ──────────────────────────────────────────────────────────
    if (name === "computer_service_create") {
      if (!cid) return err("computer_id is required");
      const body: Record<string, unknown> = {
        name: args["name"],
        command: args["command"],
      };
      if (args["working_dir"]) body["working_dir"] = args["working_dir"];
      if (args["port"] !== undefined) body["port"] = args["port"];
      if (args["restart_policy"])
        body["restart_policy"] = args["restart_policy"];
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/services`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Service created: id=${data["id"]}  name=${JSON.stringify(data["name"])}  status=${data["status"] ?? data["state"] ?? ""}`,
      );
    }

    if (name === "computer_service_list") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/services`,
      );
      const items = listOf(result);
      if (items.length === 0) return ok("No services found.");
      const lines = ["Services:"];
      for (const s of items) {
        const r = s as Record<string, unknown>;
        lines.push(
          `  ${r["id"]}  ${JSON.stringify(r["name"])}  ${r["status"] ?? r["state"] ?? ""}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_service_start") {
      if (!cid) return err("computer_id is required");
      const sid = String(args["service_id"] ?? "");
      if (!sid) return err("service_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/services/${encodeURIComponent(sid)}/start`,
        {},
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Service ${data["id"] ?? sid} started (status=${data["status"] ?? ""}).`,
      );
    }

    if (name === "computer_service_stop") {
      if (!cid) return err("computer_id is required");
      const sid = String(args["service_id"] ?? "");
      if (!sid) return err("service_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/services/${encodeURIComponent(sid)}/stop`,
        {},
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Service ${data["id"] ?? sid} stopped (status=${data["status"] ?? ""}).`,
      );
    }

    if (name === "computer_service_restart") {
      if (!cid) return err("computer_id is required");
      const sid = String(args["service_id"] ?? "");
      if (!sid) return err("service_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/services/${encodeURIComponent(sid)}/restart`,
        {},
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Service ${data["id"] ?? sid} restarted (status=${data["status"] ?? ""}).`,
      );
    }

    if (name === "computer_service_logs") {
      if (!cid) return err("computer_id is required");
      const sid = String(args["service_id"] ?? "");
      if (!sid) return err("service_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/services/${encodeURIComponent(sid)}/logs?follow=false`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const logLines = data["lines"] ?? data["logs"] ?? data["data"];
      if (Array.isArray(logLines) && logLines.length > 0) {
        return ok(logLines.map((l: unknown) => String(l)).join("\n"));
      }
      if (typeof logLines === "string") return ok(logLines);
      return ok("No log output.");
    }

    if (name === "computer_service_delete") {
      if (!cid) return err("computer_id is required");
      const sid = String(args["service_id"] ?? "");
      if (!sid) return err("service_id is required");
      await client.apiDelete(
        `/api/v1/computers/${encodeURIComponent(cid)}/services/${encodeURIComponent(sid)}`,
      );
      return ok(`Service ${sid} deleted.`);
    }

    // ── Env vars ──────────────────────────────────────────────────────────
    if (name === "computer_env_list") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/env`,
      );
      const items = Array.isArray(result)
        ? result
        : (() => {
            const d = unwrapData(result) as Record<string, unknown>;
            return (
              (Array.isArray(d["env"]) ? d["env"] : null) ??
              (Array.isArray(d["items"]) ? d["items"] : null) ??
              (Array.isArray(d["data"]) ? d["data"] : null) ??
              []
            );
          })();
      if ((items as unknown[]).length === 0)
        return ok("No environment variables set.");
      const lines = ["Environment variables:"];
      for (const e of items as unknown[]) {
        const r = e as Record<string, unknown>;
        const k = String(r["name"] ?? r["key"] ?? "");
        const v = String(r["value"] ?? "");
        lines.push(`  ${k}=${v}`);
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_env_set") {
      if (!cid) return err("computer_id is required");
      await client.apiPost(`/api/v1/computers/${encodeURIComponent(cid)}/env`, {
        name: args["name"],
        value: args["value"],
      });
      return ok(`Set env var ${args["name"]}.`);
    }

    if (name === "computer_env_delete") {
      if (!cid) return err("computer_id is required");
      const varName = String(args["name"] ?? "");
      if (!varName) return err("name is required");
      await client.apiDelete(
        `/api/v1/computers/${encodeURIComponent(cid)}/env/${encodeURIComponent(varName)}`,
      );
      return ok(`Deleted env var ${varName}.`);
    }

    // ── Logs ──────────────────────────────────────────────────────────────
    if (name === "computer_logs") {
      if (!cid) return err("computer_id is required");
      const qs =
        args["lines"] !== undefined
          ? `?lines=${encodeURIComponent(String(args["lines"]))}`
          : "";
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/logs${qs}`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const logLines = data["lines"] ?? data["logs"] ?? data["data"];
      if (Array.isArray(logLines) && logLines.length > 0) {
        return ok(logLines.map((l: unknown) => String(l)).join("\n"));
      }
      if (typeof logLines === "string") return ok(logLines);
      if (typeof result === "string") return ok(result);
      return ok("No logs.");
    }

    // ── Domains ───────────────────────────────────────────────────────────
    if (name === "computer_domain_add") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/domains`,
        { fqdn: args["fqdn"] },
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const lines = [
        `Domain registered: id=${data["id"]}  fqdn=${data["fqdn"]}  status=${data["status"] ?? ""}`,
      ];
      if (data["verification_target"])
        lines.push(`  CNAME target: ${data["verification_target"]}`);
      if (data["instructions"])
        lines.push(`  Instructions: ${data["instructions"]}`);
      return ok(lines.join("\n"));
    }

    if (name === "computer_domain_list") {
      if (!cid) return err("computer_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/computers/${encodeURIComponent(cid)}/domains`,
      );
      const items = listOf(result);
      if (items.length === 0) return ok("No custom domains registered.");
      const lines = ["Custom domains:"];
      for (const d of items) {
        const r = d as Record<string, unknown>;
        lines.push(`  ${r["id"]}  ${r["fqdn"]}  ${r["status"] ?? ""}`);
      }
      return ok(lines.join("\n"));
    }

    if (name === "computer_domain_delete") {
      if (!cid) return err("computer_id is required");
      const domainId = String(args["domain_id"] ?? "");
      if (!domainId) return err("domain_id is required");
      await client.apiDelete(
        `/api/v1/computers/${encodeURIComponent(cid)}/domains/${encodeURIComponent(domainId)}`,
      );
      return ok(`Domain ${domainId} deleted.`);
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
      const cwd = args["cwd"] ? String(args["cwd"]) : undefined;
      const body: Record<string, unknown> = {
        command: commandInCwd(String(args["command"] ?? ""), cwd),
      };
      if (cwd) {
        body["cwd"] = cwd;
        body["dir"] = cwd;
      }
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

    // ── Sandbox list/get/pause/resume ─────────────────────────────────────
    if (name === "sandbox_list") {
      const params = new URLSearchParams();
      if (args["state"]) params.set("state", String(args["state"]));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const result = await client.apiGet<unknown>(`/api/v1/sandboxes${qs}`);
      const items = listOf(result);
      if (items.length === 0) return ok("No sandboxes found.");
      const lines = ["Sandboxes:"];
      for (const s of items) {
        const r = s as Record<string, unknown>;
        lines.push(
          `  ${r["id"]}  ${r["name"] ?? ""}  ${r["state"] ?? r["status"] ?? ""}  template=${r["template_id"] ?? ""}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "sandbox_get") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const lines = [
        `id: ${data["id"]}`,
        `state: ${data["state"] ?? data["status"] ?? ""}`,
        `template_id: ${data["template_id"] ?? ""}`,
        `ready: ${data["ready"] ?? ""}`,
      ];
      if (data["name"]) lines.splice(1, 0, `name: ${data["name"]}`);
      if (data["preview_url"])
        lines.push(`preview_url: ${data["preview_url"]}`);
      if (data["boot_ms"] !== undefined)
        lines.push(`boot_ms: ${data["boot_ms"]}`);
      return ok(lines.join("\n"));
    }

    if (name === "sandbox_pause") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      await client.apiPost(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/pause`,
        {},
      );
      return ok(`Sandbox ${sid} paused.`);
    }

    if (name === "sandbox_resume") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      await client.apiPost(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/resume`,
        {},
      );
      return ok(`Sandbox ${sid} resumed.`);
    }

    // ── Sandbox files ─────────────────────────────────────────────────────
    if (name === "sandbox_write_file") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      await client.apiPost(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/files`,
        {
          path: args["path"],
          content: Buffer.from(
            typeof args["content"] === "string" ? args["content"] : "",
            "utf8",
          ).toString("base64"),
        },
      );
      const len =
        typeof args["content"] === "string" ? args["content"].length : 0;
      return ok(`Wrote ${len} bytes to ${args["path"]}`);
    }

    if (name === "sandbox_read_file") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const path = String(args["path"] ?? "").replace(/^\//, "");
      const result = await client.apiGet<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/files/${encodeURIComponent(path)}`,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      if (typeof data["content"] === "string") {
        try {
          return ok(Buffer.from(data["content"], "base64").toString("utf8"));
        } catch {
          return ok(data["content"]);
        }
      }
      if (typeof data["text"] === "string") return ok(data["text"]);
      return ok(JSON.stringify(data));
    }

    if (name === "sandbox_list_files") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const path = String(args["path"] ?? "/workspace");
      const params = new URLSearchParams({ path });
      if (args["depth"] !== undefined)
        params.set("depth", String(args["depth"]));
      const result = await client.apiGet<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/files?${params.toString()}`,
      );
      const data = unwrapData(result);
      return ok(JSON.stringify(data, null, 2));
    }

    if (name === "sandbox_upload") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      await client.apiPost(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/files`,
        {
          path: args["path"],
          content: Buffer.from(
            typeof args["content"] === "string" ? args["content"] : "",
            "utf8",
          ).toString("base64"),
        },
      );
      return ok(`Uploaded ${args["path"]} to sandbox ${sid}.`);
    }

    // ── Sandbox python ────────────────────────────────────────────────────
    if (name === "sandbox_python") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const code = String(args["code"] ?? "");
      const tmpPath = "/tmp/_mcp_run.py";
      // Write code file
      await client.apiPost(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/files`,
        {
          path: tmpPath,
          content: Buffer.from(code, "utf8").toString("base64"),
        },
      );
      // Execute it
      const execBody: Record<string, unknown> = {
        command: `python3 ${tmpPath}`,
      };
      if (args["timeout"] !== undefined) execBody["timeout"] = args["timeout"];
      const result = await client.apiPost<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/exec`,
        execBody,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const parts: string[] = [];
      if (data["stdout"] ?? data["output"])
        parts.push(`stdout:\n${data["stdout"] ?? data["output"]}`);
      if (data["stderr"]) parts.push(`stderr:\n${data["stderr"]}`);
      parts.push(`exit_code: ${data["exit_code"] ?? 0}`);
      return ok(parts.join("\n"));
    }

    // ── Sandbox snapshots ─────────────────────────────────────────────────
    if (name === "sandbox_snapshot_create") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const body: Record<string, unknown> = {};
      if (args["comment"]) body["comment"] = args["comment"];
      const result = await client.apiPost<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/snapshots`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const snapId = data["id"] ?? data["snapshot_id"] ?? "unknown";
      return ok(`Snapshot created: id=${snapId}`);
    }

    if (name === "sandbox_snapshot_list") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const result = await client.apiGet<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/snapshots`,
      );
      const items = listOf(result);
      if (items.length === 0) return ok("No snapshots found.");
      const lines = ["Snapshots:"];
      for (const s of items) {
        const r = s as Record<string, unknown>;
        lines.push(
          `  ${r["id"]}  ${r["created_at"] ?? ""}  ${r["comment"] ?? ""}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "sandbox_snapshot_restore") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const snapId = String(args["snapshot_id"] ?? "");
      if (!snapId) return err("snapshot_id is required");
      const result = await client.apiPost<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/restore/${encodeURIComponent(snapId)}`,
        {},
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const state = data["state"] ?? data["status"] ?? "unknown";
      return ok(
        `Sandbox ${sid} restored from snapshot ${snapId} (state=${state}).`,
      );
    }

    // ── Sandbox logs ──────────────────────────────────────────────────────
    if (name === "sandbox_logs") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const params = new URLSearchParams();
      if (args["lines"] !== undefined)
        params.set("lines", String(args["lines"]));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const result = await client.apiGet<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/logs${qs}`,
      );
      const data = unwrapData(result);
      if (Array.isArray(data)) {
        return ok(data.length > 0 ? data.join("\n") : "No logs.");
      }
      return ok(JSON.stringify(data, null, 2));
    }

    // ── Sandbox expose ────────────────────────────────────────────────────
    if (name === "sandbox_expose") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const body: Record<string, unknown> = {};
      if (args["port"] !== undefined) body["port"] = args["port"];
      const result = await client.apiPost<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/expose`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const url = data["url"] ?? data["preview_url"] ?? "";
      const urlClass = data["url_class"] ?? data["class"] ?? "temporary_preview";
      const stable = data["stable_for_embedding"] === true;
      const nextAction =
        data["recommended_next_action"] ?? "create_alias_or_publish";
      return ok(
        [
          `preview_url: ${url}`,
          `url_class: ${urlClass}`,
          `stable_for_embedding: ${stable}`,
          `recommended_next_action: ${nextAction}`,
        ].join("\n"),
      );
    }

    // ── Sandbox deploy ────────────────────────────────────────────────────
    if (name === "sandbox_deploy") {
      const sid = String(args["sandbox_id"] ?? "");
      if (!sid) return err("sandbox_id is required");
      const body: Record<string, unknown> = {};
      if (args["name"]) body["name"] = args["name"];
      if (args["output_path"]) body["output_path"] = args["output_path"];
      if (args["entrypoint"]) body["entrypoint"] = args["entrypoint"];
      if (args["domain"]) body["domain"] = args["domain"];
      const result = await client.apiPost<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sid)}/deploy`,
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      const deployId = data["id"] ?? data["deployment_id"] ?? "unknown";
      const url = data["url"] ?? data["preview_url"] ?? "";
      const urlClass =
        data["url_class"] ?? data["class"] ?? "durable_deployment";
      const stable = data["stable_for_embedding"] !== false;
      const nextAction =
        data["recommended_next_action"] ?? "attach_custom_domain";
      return ok(
        [
          `deployment_id: ${deployId}`,
          `url: ${url}`,
          `url_class: ${urlClass}`,
          `stable_for_embedding: ${stable}`,
          `recommended_next_action: ${nextAction}`,
        ].join("\n"),
      );
    }

    // ── Sandbox templates ─────────────────────────────────────────────────
    if (name === "sandbox_template_list") {
      const result = await client.apiGet<unknown>("/api/v1/sandbox-templates");
      const data = unwrapData(result);
      const items = Array.isArray(data)
        ? data
        : (() => {
            const r = data as Record<string, unknown>;
            for (const key of ["templates", "data", "items"]) {
              if (Array.isArray(r[key])) return r[key] as unknown[];
            }
            return Object.values(r);
          })();
      if (items.length === 0) return ok("No templates found.");
      const lines = ["Templates:"];
      for (const t of items) {
        const r = t as Record<string, unknown>;
        lines.push(
          `  ${r["id"] ?? r["slug"]}  ${r["name"]}  ${r["description"] ?? ""}`,
        );
      }
      return ok(lines.join("\n"));
    }

    if (name === "sandbox_template_create") {
      const body: Record<string, unknown> = {
        name: args["name"],
        build_spec: args["build_spec"],
      };
      if (args["slug"]) body["slug"] = args["slug"];
      if (args["description"]) body["description"] = args["description"];
      const result = await client.apiPost<unknown>(
        "/api/v1/sandbox-templates",
        body,
      );
      const data = unwrapData(result) as Record<string, unknown>;
      return ok(
        `Created template '${data["name"] ?? args["name"]}' (id=${data["id"]}).`,
      );
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

    // ── Deployments ──────────────────────────────────────────────────────
    if (name === "deployment_list") {
      const result = await client.apiGet<unknown>("/api/v1/deployments");
      const items = listOf(result);
      if (items.length === 0) return ok("No deployments found.");
      const lines = ["Deployments:"];
      for (const d of items) {
        const r = d as Record<string, unknown>;
        lines.push("  " + r["id"] + "  " + r["name"] + "  " + (r["status"] ?? r["state"] ?? ""));
      }
      return ok(lines.join("\n"));
    }

    if (name === "deployment_get") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      const result = await client.apiGet<unknown>("/api/v1/deployments/" + encodeURIComponent(did));
      return ok(JSON.stringify(unwrapData(result), null, 2));
    }

    if (name === "deployment_create") {
      const body: Record<string, unknown> = { name: args["name"] };
      if (args["type"]) body["type"] = args["type"];
      if (args["source"]) body["source"] = args["source"];
      if (args["env_vars"]) body["env_vars"] = args["env_vars"];
      if (args["region"]) body["region"] = args["region"];
      const result = await client.apiPost<unknown>("/api/v1/deployments", body);
      const data = unwrapData(result) as Record<string, unknown>;
      return ok("Created deployment '" + String(data["name"] ?? args["name"]) + "' (id=" + data["id"] + ")");
    }

    if (name === "deployment_delete") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      await client.apiDelete("/api/v1/deployments/" + encodeURIComponent(did));
      return ok("Deployment " + did + " deleted.");
    }

    if (name === "deployment_publish") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      const body: Record<string, unknown> = {};
      if (args["source"]) body["source"] = args["source"];
      const result = await client.apiPost<unknown>("/api/v1/deployments/" + encodeURIComponent(did) + "/publish", body);
      const data = unwrapData(result) as Record<string, unknown>;
      return ok("Published deployment " + did + " (version id=" + (data["id"] ?? "unknown") + ")");
    }

    if (name === "deployment_rollback") {
      const did = String(args["deployment_id"] ?? "");
      const vid = String(args["version_id"] ?? "");
      if (!did) return err("deployment_id is required");
      if (!vid) return err("version_id is required");
      await client.apiPost("/api/v1/deployments/" + encodeURIComponent(did) + "/rollback", { version_id: vid });
      return ok("Deployment " + did + " rolled back to version " + vid + ".");
    }

    if (name === "deployment_env_list") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      const result = await client.apiGet<unknown>("/api/v1/deployments/" + encodeURIComponent(did) + "/env");
      const envVars = unwrapData(result);
      if (!envVars || (Array.isArray(envVars) && (envVars as unknown[]).length === 0)) return ok("No environment variables set.");
      const lines = ["Environment variables:"];
      if (typeof envVars === "object" && !Array.isArray(envVars)) {
        for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
          lines.push("  " + k + "=" + String(v));
        }
      } else if (Array.isArray(envVars)) {
        for (const e of envVars as Record<string, unknown>[]) {
          lines.push("  " + e["key"] + "=" + e["value"]);
        }
      }
      return ok(lines.join("\n"));
    }

    if (name === "deployment_env_set") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      await client.apiPost("/api/v1/deployments/" + encodeURIComponent(did) + "/env", { key: args["key"], value: args["value"] });
      return ok("Set " + String(args["key"]) + " on deployment " + did + ".");
    }

    if (name === "deployment_logs") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      const params = new URLSearchParams({ lines: String(args["lines"] ?? 100) });
      if (args["since"]) params.set("since", String(args["since"]));
      const result = await client.apiGet<unknown>("/api/v1/deployments/" + encodeURIComponent(did) + "/logs?" + params.toString());
      const logs = unwrapData(result);
      if (Array.isArray(logs)) return ok((logs as unknown[]).length ? (logs as unknown[]).map(String).join("\n") : "No logs.");
      return ok(String(logs));
    }

    if (name === "deployment_version_list") {
      const did = String(args["deployment_id"] ?? "");
      if (!did) return err("deployment_id is required");
      const result = await client.apiGet<unknown>("/api/v1/deployments/" + encodeURIComponent(did) + "/versions");
      const versions = listOf(result);
      if (versions.length === 0) return ok("No versions found.");
      const lines = ["Versions:"];
      for (const v of versions) {
        const r = v as Record<string, unknown>;
        lines.push("  " + r["id"] + "  " + (r["created_at"] ?? "") + "  " + (r["status"] ?? ""));
      }
      return ok(lines.join("\n"));
    }

    if (name === "deployment_version_promote") {
      const did = String(args["deployment_id"] ?? "");
      const vid = String(args["version_id"] ?? "");
      if (!did) return err("deployment_id is required");
      if (!vid) return err("version_id is required");
      await client.apiPost("/api/v1/deployments/" + encodeURIComponent(did) + "/versions/" + encodeURIComponent(vid) + "/promote", {});
      return ok("Version " + vid + " promoted on deployment " + did + ".");
    }

    // ── Storage ───────────────────────────────────────────────────────────
    if (name === "storage_bucket_list") {
      const result = await client.apiGet<unknown>("/api/v1/storage/buckets");
      const items = listOf(result);
      if (items.length === 0) return ok("No buckets found.");
      const lines = ["Buckets:"];
      for (const b of items) {
        const r = b as Record<string, unknown>;
        lines.push("  " + r["id"] + "  " + r["name"] + "  " + (r["region"] ?? ""));
      }
      return ok(lines.join("\n"));
    }

    if (name === "storage_bucket_create") {
      const body: Record<string, unknown> = { name: args["name"] };
      if (args["region"]) body["region"] = args["region"];
      if (args["public"] !== undefined) body["public"] = args["public"];
      const result = await client.apiPost<unknown>("/api/v1/storage/buckets", body);
      const data = unwrapData(result) as Record<string, unknown>;
      return ok("Created bucket '" + String(data["name"] ?? args["name"]) + "' (id=" + data["id"] + ")");
    }

    if (name === "storage_bucket_delete") {
      const bid = String(args["bucket_id"] ?? "");
      if (!bid) return err("bucket_id is required");
      await client.apiDelete("/api/v1/storage/buckets/" + encodeURIComponent(bid));
      return ok("Bucket " + bid + " deleted.");
    }

    if (name === "storage_object_list") {
      const bid = String(args["bucket_id"] ?? "");
      if (!bid) return err("bucket_id is required");
      const params = new URLSearchParams();
      if (args["prefix"]) params.set("prefix", String(args["prefix"]));
      const qs = params.toString() ? "?" + params.toString() : "";
      const result = await client.apiGet<unknown>("/api/v1/storage/buckets/" + encodeURIComponent(bid) + "/objects" + qs);
      const items = listOf(result);
      if (items.length === 0) return ok("No objects found.");
      const lines = ["Objects:"];
      for (const o of items) {
        const r = o as Record<string, unknown>;
        lines.push("  " + r["key"] + "  " + (r["size"] ?? "") + "  " + (r["last_modified"] ?? ""));
      }
      return ok(lines.join("\n"));
    }

    if (name === "storage_object_upload") {
      const bid = String(args["bucket_id"] ?? "");
      if (!bid) return err("bucket_id is required");
      await client.apiPost("/api/v1/storage/buckets/" + encodeURIComponent(bid) + "/objects", {
        key: args["key"],
        content: args["content"],
        content_type: args["content_type"] ?? "application/octet-stream",
      });
      return ok("Uploaded " + String(args["key"]) + " to bucket " + bid + ".");
    }

    if (name === "storage_object_download") {
      const bid = String(args["bucket_id"] ?? "");
      if (!bid) return err("bucket_id is required");
      const result = await client.apiGet<unknown>("/api/v1/storage/buckets/" + encodeURIComponent(bid) + "/objects/" + encodeURIComponent(String(args["key"] ?? "")));
      const data = unwrapData(result) as Record<string, unknown>;
      const content =
        typeof data["content"] === "string"
          ? Buffer.from(data["content"], "base64").toString("utf8")
          : typeof data["text"] === "string"
          ? data["text"]
          : JSON.stringify(data);
      return ok(content);
    }

    if (name === "storage_object_delete") {
      const bid = String(args["bucket_id"] ?? "");
      if (!bid) return err("bucket_id is required");
      await client.apiDelete("/api/v1/storage/buckets/" + encodeURIComponent(bid) + "/objects/" + encodeURIComponent(String(args["key"] ?? "")));
      return ok("Deleted " + String(args["key"]) + " from bucket " + bid + ".");
    }

    if (name === "storage_presign") {
      const bid = String(args["bucket_id"] ?? "");
      if (!bid) return err("bucket_id is required");
      const result = await client.apiPost<unknown>("/api/v1/storage/buckets/" + encodeURIComponent(bid) + "/presign", {
        key: args["key"],
        expires_in: args["expires_in"] ?? 3600,
        method: args["method"] ?? "GET",
      });
      const data = unwrapData(result) as Record<string, unknown>;
      return ok("Presigned URL: " + (data["url"] ?? JSON.stringify(data)));
    }

    // ── Databases ─────────────────────────────────────────────────────────
    if (name === "database_list") {
      const result = await client.apiGet<unknown>("/api/v1/databases");
      const items = listOf(result);
      if (items.length === 0) return ok("No databases found.");
      const lines = ["Databases:"];
      for (const d of items) {
        const r = d as Record<string, unknown>;
        lines.push("  " + r["id"] + "  " + r["name"] + "  " + (r["engine"] ?? "") + "  " + (r["status"] ?? ""));
      }
      return ok(lines.join("\n"));
    }

    if (name === "database_create") {
      const engine = normalizeDatabaseEngine(args["engine"]);
      const body: Record<string, unknown> = { name: args["name"], engine };
      if (engine === "postgresql" && !args["version"]) body["engine_version"] = "15";
      for (const key of ["size", "region"]) {
        if (args[key]) body[key] = args[key];
      }
      if (args["version"]) body["engine_version"] = args["version"];
      const result = await client.apiPost<unknown>("/api/v1/databases", body);
      const data = unwrapData(result) as Record<string, unknown>;
      return ok("Created database '" + String(data["name"] ?? args["name"]) + "' (id=" + data["id"] + ")");
    }

    if (name === "database_get") {
      const dbid = String(args["database_id"] ?? "");
      if (!dbid) return err("database_id is required");
      const result = await client.apiGet<unknown>("/api/v1/databases/" + encodeURIComponent(dbid));
      return ok(JSON.stringify(unwrapData(result), null, 2));
    }

    if (name === "database_delete") {
      const dbid = String(args["database_id"] ?? "");
      if (!dbid) return err("database_id is required");
      await client.apiDelete("/api/v1/databases/" + encodeURIComponent(dbid));
      return ok("Database " + dbid + " deleted.");
    }

    if (name === "database_credentials") {
      const dbid = String(args["database_id"] ?? "");
      if (!dbid) return err("database_id is required");
      const result = await client.apiGet<unknown>("/api/v1/databases/" + encodeURIComponent(dbid) + "/credentials");
      const data = unwrapData(result) as Record<string, unknown>;
      const lines = ["Database credentials:"];
      for (const field of ["connection_string", "host", "port", "database", "username", "password"]) {
        if (data[field]) lines.push("  " + field + ": " + data[field]);
      }
      return ok(lines.join("\n"));
    }

    if (name === "database_logs") {
      const dbid = String(args["database_id"] ?? "");
      if (!dbid) return err("database_id is required");
      const params = new URLSearchParams({ lines: String(args["lines"] ?? 100) });
      if (args["since"]) params.set("since", String(args["since"]));
      const result = await client.apiGet<unknown>("/api/v1/databases/" + encodeURIComponent(dbid) + "/logs?" + params.toString());
      const logs = unwrapData(result);
      if (Array.isArray(logs)) return ok((logs as unknown[]).length ? (logs as unknown[]).map(String).join("\n") : "No logs.");
      return ok(String(logs));
    }

    // ── Workspaces ────────────────────────────────────────────────────────
    if (name === "workspace_list") {
      const result = await client.apiGet<unknown>("/api/v1/workspaces");
      const items = listOf(result);
      if (items.length === 0) return ok("No workspaces found.");
      const lines = ["Workspaces:"];
      for (const w of items) {
        const r = w as Record<string, unknown>;
        lines.push("  " + r["id"] + "  " + r["name"]);
      }
      return ok(lines.join("\n"));
    }

    if (name === "workspace_create") {
      const body: Record<string, unknown> = { name: args["name"] };
      if (args["description"]) body["description"] = args["description"];
      const result = await client.apiPost<unknown>("/api/v1/workspaces", body);
      const data = unwrapData(result) as Record<string, unknown>;
      return ok("Created workspace '" + String(data["name"] ?? args["name"]) + "' (id=" + data["id"] + ")");
    }

    if (name === "workspace_get") {
      const wid = String(args["workspace_id"] ?? "");
      if (!wid) return err("workspace_id is required");
      const result = await client.apiGet<unknown>("/api/v1/workspaces/" + encodeURIComponent(wid));
      return ok(JSON.stringify(unwrapData(result), null, 2));
    }

    if (name === "workspace_update") {
      const wid = String(args["workspace_id"] ?? "");
      if (!wid) return err("workspace_id is required");
      const body: Record<string, unknown> = {};
      if (args["name"]) body["name"] = args["name"];
      if (args["description"]) body["description"] = args["description"];
      await client.apiPost("/api/v1/workspaces/" + encodeURIComponent(wid), body);
      return ok("Workspace " + wid + " updated.");
    }

    if (name === "workspace_stats") {
      const wid = String(args["workspace_id"] ?? "");
      if (!wid) return err("workspace_id is required");
      const result = await client.apiGet<unknown>("/api/v1/workspaces/" + encodeURIComponent(wid) + "/stats");
      return ok(JSON.stringify(unwrapData(result), null, 2));
    }

    if (name === "workspace_usage") {
      const wid = String(args["workspace_id"] ?? "");
      if (!wid) return err("workspace_id is required");
      const params = new URLSearchParams();
      if (args["period"]) params.set("period", String(args["period"]));
      const qs = params.toString() ? "?" + params.toString() : "";
      const result = await client.apiGet<unknown>("/api/v1/workspaces/" + encodeURIComponent(wid) + "/usage" + qs);
      return ok(JSON.stringify(unwrapData(result), null, 2));
    }

    // ── Billing ───────────────────────────────────────────────────────────
    if (name === "billing_usage") {
      const result = await client.apiGet<unknown>("/api/v1/billing/overview");
      return ok(JSON.stringify(unwrapData(result), null, 2));
    }

    if (name === "billing_plan") {
      const result = await client.apiGet<unknown>("/api/v1/billing/overview");
      return ok(JSON.stringify(unwrapData(result), null, 2));
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
type InstallMode = "local" | "remote";

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

function wireClaudeCodeLocal(
  scope: "local" | "user" | "project",
): { ok: true } | { ok: false; reason: string } {
  // `claude mcp remove` first so re-running install replaces cleanly.
  spawnSync("claude", ["mcp", "remove", MCP_SERVER_NAME, "--scope", scope], {
    stdio: "ignore",
  });

  const result = spawnSync(
    "claude",
    ["mcp", "add", "--scope", scope, MCP_SERVER_NAME, "miosa", "mcp", "serve"],
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

function printLocalSnippet(client: SupportedClient): void {
  console.log();
  console.log(chalk.bold("Manual local MCP install snippet"));
  console.log(chalk.dim("  Requires `miosa login` or MIOSA_API_KEY in the MCP environment."));
  console.log();

  if (client === "cursor") {
    console.log(chalk.dim("  Add to ~/.cursor/mcp.json:"));
    console.log();
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            miosa: {
              command: "miosa",
              args: ["mcp", "serve"],
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
    console.log(`  ${chalk.cyan(`gemini mcp add ${MCP_SERVER_NAME} miosa mcp serve`)}`);
    return;
  }

  // claude / manual
  console.log(`  ${chalk.cyan(`claude mcp add --scope user ${MCP_SERVER_NAME} miosa mcp serve`)}`);
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
  mode: InstallMode;
  remoteUrl: string;
}): Promise<void> {
  const config = loadConfig();
  const clientName = `MIOSA MCP (${opts.client === "manual" ? "manual" : opts.client})`;

  console.log(
    chalk.bold("MIOSA MCP installer"),
    chalk.dim(
      opts.mode === "local"
        ? `— wiring ${opts.client} → local miosa mcp serve`
        : `— wiring ${opts.client} → ${opts.remoteUrl}`,
    ),
  );

  if (opts.mode === "local") {
    if (opts.client === "claude") {
      const wired = wireClaudeCodeLocal(opts.scope);
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
      printLocalSnippet("claude");
      return;
    }

    printLocalSnippet(opts.client);
    return;
  }

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
      "Install MIOSA MCP into your AI client. Defaults to the local `miosa mcp serve` stdio server.",
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
      "Hosted MCP URL used with --remote (default: https://api.miosa.ai/api/v1/mcp)",
      MCP_REMOTE_URL,
    )
    .option(
      "--remote",
      "Install the hosted HTTP MCP server instead of the local stdio server",
      false,
    )
    .action(async (opts: { client: string; scope: string; url: string; remote?: boolean }) => {
      const client = (
        ["claude", "cursor", "gemini", "manual"].includes(opts.client)
          ? opts.client
          : "claude"
      ) as SupportedClient;
      const scope = (
        ["local", "user", "project"].includes(opts.scope) ? opts.scope : "user"
      ) as "local" | "user" | "project";
      try {
        await runInstall({
          client,
          scope,
          mode: opts.remote ? "remote" : "local",
          remoteUrl: opts.url,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(3);
      }
    });
}
