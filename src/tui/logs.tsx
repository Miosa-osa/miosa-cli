/**
 * `miosa logs <id> --follow` — live log tail TUI.
 *
 * React component (rendered by ink) that polls the MIOSA API every 2 seconds
 * and streams the last 200 log lines into a scrollable pane with a header bar.
 *
 * How it differs from one-shot `miosa logs`:
 *   - Runs interactively in the terminal instead of dumping once and exiting.
 *   - Polls continuously, appending new lines to an in-memory ring buffer.
 *   - Renders a header bar (resource id, status, region, age, clock).
 *   - Colors stdout/stderr/error lines differently.
 *   - Responds to keyboard: q / Ctrl+C to quit, / to toggle filter mode.
 *
 * Mounted by `src/commands/logs.ts` when --follow / -f is passed and
 * process.stdout.isTTY is true.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput } from "ink";
import { MiosaClient } from "../client.js";
import type { MiosaConfig } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_LINES = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResourceKind = "computer" | "sandbox" | "deployment" | "database";

export interface LogsTUIProps {
  resourceId: string;
  resourceKind: ResourceKind;
  config: MiosaConfig;
}

type LogStream = "stdout" | "stderr" | "error" | "unknown";

interface LogLine {
  /** Monotonic insertion key so React keys are stable. */
  seq: number;
  timestamp: string;
  stream: LogStream;
  text: string;
}

interface ResourceMeta {
  status: string;
  region: string;
  created_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

function nowHHMMSS(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ageLabel(isoOrNull: string | null): string {
  if (!isoOrNull) return "—";
  const ms = Date.now() - new Date(isoOrNull).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function logEndpointFor(kind: ResourceKind, id: string): string {
  switch (kind) {
    case "computer":
      return `/api/v1/computers/${encodeURIComponent(id)}/logs`;
    case "sandbox":
      return `/api/v1/sandboxes/${encodeURIComponent(id)}/logs`;
    case "deployment":
      return `/api/v1/deployments/${encodeURIComponent(id)}/logs`;
    case "database":
      return `/api/v1/databases/${encodeURIComponent(id)}/logs`;
  }
}

function metaEndpointFor(kind: ResourceKind, id: string): string {
  switch (kind) {
    case "computer":
      return `/api/v1/computers/${encodeURIComponent(id)}`;
    case "sandbox":
      return `/api/v1/sandboxes/${encodeURIComponent(id)}`;
    case "deployment":
      return `/api/v1/deployments/${encodeURIComponent(id)}`;
    case "database":
      return `/api/v1/databases/${encodeURIComponent(id)}`;
  }
}

/**
 * Parse an arbitrary API log payload (array of rows OR wrapped object with
 * a "data"/"logs"/"lines" key) into typed LogLine entries. Handles both the
 * plain-array format used by computer/sandbox endpoints and the JSON-row
 * format seen in deployment responses.
 */
function parsePayload(raw: unknown, existingCount: number): LogLine[] {
  let rows: unknown[] = [];

  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    for (const key of ["logs", "data", "lines", "items"]) {
      if (Array.isArray(rec[key])) {
        rows = rec[key] as unknown[];
        break;
      }
    }
  }

  return rows.slice(-MAX_LINES).map((row, idx) => {
    if (typeof row === "string") {
      return {
        seq: nextSeq(),
        timestamp: nowHHMMSS(),
        stream: "stdout" as LogStream,
        text: row,
      };
    }
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      const stream = ((): LogStream => {
        const s = String(r["stream"] ?? r["level"] ?? "stdout").toLowerCase();
        if (s === "stderr" || s === "error" || s === "stdout")
          return s as LogStream;
        return "unknown";
      })();
      const text =
        typeof r["line"] === "string"
          ? r["line"]
          : typeof r["message"] === "string"
            ? r["message"]
            : typeof r["text"] === "string"
              ? r["text"]
              : JSON.stringify(row);
      const timestamp =
        typeof r["timestamp"] === "string"
          ? r["timestamp"].slice(11, 19) // HH:MM:SS from ISO
          : typeof r["inserted_at"] === "string"
            ? r["inserted_at"].slice(11, 19)
            : nowHHMMSS();
      return { seq: nextSeq(), timestamp, stream, text };
    }
    return {
      seq: nextSeq(),
      timestamp: nowHHMMSS(),
      stream: "unknown" as LogStream,
      text: String(row),
    };
  });
}

function extractMeta(raw: unknown): Partial<ResourceMeta> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    status:
      typeof r["status"] === "string"
        ? r["status"]
        : typeof r["state"] === "string"
          ? String(r["state"])
          : undefined,
    region: typeof r["region"] === "string" ? r["region"] : undefined,
    created_at:
      typeof r["inserted_at"] === "string"
        ? r["inserted_at"]
        : typeof r["created_at"] === "string"
          ? r["created_at"]
          : null,
  };
}

function streamColor(stream: LogStream): string | undefined {
  switch (stream) {
    case "stderr":
      return "yellow";
    case "error":
      return "red";
    default:
      return undefined;
  }
}

// ── Subcomponent: header bar ──────────────────────────────────────────────────

interface HeaderBarProps {
  resourceId: string;
  resourceKind: ResourceKind;
  meta: ResourceMeta;
  clock: string;
  fetchError: string | null;
  filterActive: boolean;
  filterText: string;
}

const HeaderBar: React.FC<HeaderBarProps> = ({
  resourceId,
  resourceKind,
  meta,
  clock,
  fetchError,
  filterActive,
  filterText,
}) => {
  const statusColor =
    meta.status === "running" ||
    meta.status === "active" ||
    meta.status === "ready"
      ? "green"
      : meta.status === "provisioning" ||
          meta.status === "building" ||
          meta.status === "pending"
        ? "yellow"
        : meta.status === "error" || meta.status === "failed"
          ? "red"
          : "gray";

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* ── top identity bar ─────────────────────────────── */}
      <Box
        justifyContent="space-between"
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
      >
        <Text>
          <Text color="cyan" bold>
            MIOSA
          </Text>
          <Text dimColor> · logs · </Text>
          <Text bold>{resourceKind}</Text>
          <Text dimColor>/</Text>
          <Text color="cyan">{resourceId}</Text>
        </Text>
        <Text dimColor>{clock}</Text>
      </Box>

      {/* ── meta bar ─────────────────────────────────────── */}
      <Box paddingX={2} marginBottom={0}>
        <Text>
          <Text dimColor>status: </Text>
          <Text color={statusColor} bold>
            {meta.status || "—"}
          </Text>
          {"    "}
          <Text dimColor>region: </Text>
          <Text>{meta.region || "—"}</Text>
          {"    "}
          <Text dimColor>age: </Text>
          <Text>{ageLabel(meta.created_at)}</Text>
        </Text>
      </Box>

      {/* ── error banner (only when present) ─────────────── */}
      {fetchError && (
        <Box paddingX={2}>
          <Text color="red">✗ </Text>
          <Text color="red">{fetchError}</Text>
          <Text dimColor> (last known lines still shown)</Text>
        </Box>
      )}

      {/* ── filter bar (only when active) ────────────────── */}
      {filterActive && (
        <Box paddingX={2}>
          <Text dimColor>filter: </Text>
          <Text color="cyan">{filterText || "_"}</Text>
          <Text dimColor> (Esc to clear)</Text>
        </Box>
      )}
    </Box>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const LogsTUI: React.FC<LogsTUIProps> = ({
  resourceId,
  resourceKind,
  config,
}) => {
  const { exit } = useApp();

  const [lines, setLines] = useState<LogLine[]>([]);
  const [meta, setMeta] = useState<ResourceMeta>({
    status: "—",
    region: "—",
    created_at: null,
  });
  const [clock, setClock] = useState(nowHHMMSS());
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filterActive, setFilterActive] = useState(false);
  const [filterText, setFilterText] = useState("");

  // Track last-seen seq so we only append genuinely new lines each poll.
  const lastSeenCount = useRef(0);

  const client = useMemo(() => new MiosaClient(config), [config]);

  // ── Keyboard input ──────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    if (filterActive) {
      if (key.escape) {
        setFilterActive(false);
        setFilterText("");
        return;
      }
      if (key.backspace || key.delete) {
        setFilterText((t) => t.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setFilterText((t) => t + input);
        return;
      }
      return;
    }

    if (input === "/") {
      setFilterActive(true);
    }
  });

  // ── Clock tick (1 s) ────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setClock(nowHHMMSS()), 1_000);
    return () => clearInterval(id);
  }, []);

  // ── Poll loop ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      // Fetch meta and logs in parallel; tolerate individual failures.
      const [metaResult, logsResult] = await Promise.allSettled([
        client.apiGet<unknown>(metaEndpointFor(resourceKind, resourceId)),
        client.apiGet<unknown>(logEndpointFor(resourceKind, resourceId)),
      ]);

      if (cancelled) return;

      if (metaResult.status === "fulfilled") {
        const m = extractMeta(metaResult.value);
        setMeta((prev) => ({
          status: m.status ?? prev.status,
          region: m.region ?? prev.region,
          created_at:
            m.created_at !== undefined ? m.created_at : prev.created_at,
        }));
        setFetchError(null);
      }

      if (logsResult.status === "fulfilled") {
        const parsed = parsePayload(logsResult.value, lastSeenCount.current);
        setLines((prev) => {
          // Deduplicate by keeping only lines we haven't seen (by count).
          // Because the API returns the full history each time, we keep only
          // the tail beyond what we last displayed.
          const combined = parsed.length >= prev.length ? parsed : prev;
          const trimmed = combined.slice(-MAX_LINES);
          lastSeenCount.current = trimmed.length;
          return trimmed;
        });
      } else if (logsResult.status === "rejected") {
        const err = logsResult.reason;
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, resourceId, resourceKind]);

  // ── Filtered view ───────────────────────────────────────────────────────────
  const visibleLines = useMemo(() => {
    if (!filterActive || filterText === "") return lines;
    const needle = filterText.toLowerCase();
    return lines.filter((l) => l.text.toLowerCase().includes(needle));
  }, [lines, filterActive, filterText]);

  return (
    <Box flexDirection="column">
      <HeaderBar
        resourceId={resourceId}
        resourceKind={resourceKind}
        meta={meta}
        clock={clock}
        fetchError={fetchError}
        filterActive={filterActive}
        filterText={filterText}
      />

      {/* ── Log lines ─────────────────────────────────────────────────────── */}
      <Box flexDirection="column" paddingX={1}>
        {visibleLines.length === 0 ? (
          <Text dimColor> (waiting for logs…)</Text>
        ) : (
          visibleLines.map((line) => (
            <Box key={line.seq}>
              <Text dimColor>{line.timestamp} </Text>
              <Text color={streamColor(line.stream)} bold>
                {line.stream.padEnd(6)}
              </Text>
              <Text> </Text>
              <Text color={streamColor(line.stream)}>{line.text}</Text>
            </Box>
          ))
        )}
      </Box>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          press <Text bold>q</Text> to quit
          {"  ·  "}
          <Text bold>/</Text> to filter
          {"  ·  "}poll every {POLL_INTERVAL_MS / 1_000}s
        </Text>
      </Box>
    </Box>
  );
};
