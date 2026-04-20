import WebSocket from "ws";
import process from "node:process";
import { enterRawMode, exitRawMode, getTerminalSize } from "./raw-mode.js";

export interface WsPtyOptions {
  url: string;
  token: string;
  /** If set, send this command then exit when a shell prompt appears (best-effort) */
  oneShot?: string;
}

/**
 * Opens a WebSocket PTY session. Puts local terminal in raw mode,
 * pipes stdin → WS and WS messages → stdout. Returns exit code.
 */
export async function runWsPty(options: WsPtyOptions): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(options.url, {
      headers: { Authorization: `Bearer ${options.token}` },
    });

    let cleanedUp = false;

    function cleanup(code: number): void {
      if (cleanedUp) return;
      cleanedUp = true;
      exitRawMode();
      process.stdin.removeAllListeners("data");
      process.removeAllListeners("SIGWINCH");
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      resolve(code);
    }

    ws.on("open", () => {
      enterRawMode();

      // Send initial terminal size
      sendResize(ws);

      // Pipe stdin → WS
      process.stdin.on("data", (chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });

      // SIGWINCH → send resize frame
      process.on("SIGWINCH", () => {
        if (ws.readyState === WebSocket.OPEN) {
          sendResize(ws);
        }
      });

      // Send one-shot command if provided
      if (options.oneShot) {
        ws.send(Buffer.from(options.oneShot + "\n"));
      }
    });

    ws.on("message", (data: Buffer | string) => {
      process.stdout.write(typeof data === "string" ? data : data);
    });

    ws.on("close", (code) => {
      cleanup(code === 1000 ? 0 : 1);
    });

    ws.on("error", (err) => {
      process.stderr.write(`\r\nWebSocket error: ${err.message}\r\n`);
      cleanup(2);
    });

    // Ctrl+D on stdin closes the session
    process.stdin.on("end", () => {
      ws.close();
    });
  });
}

function sendResize(ws: WebSocket): void {
  const { cols, rows } = getTerminalSize();
  // Standard xterm resize sequence encoded as JSON control message
  const frame = JSON.stringify({ type: "resize", cols, rows });
  ws.send(frame);
}
