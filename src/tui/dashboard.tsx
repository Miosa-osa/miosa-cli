/**
 * `miosa watch` — live terminal dashboard.
 *
 * React component (rendered by ink) that polls the MIOSA API every few
 * seconds and shows a single-screen snapshot:
 *
 *   - Sign-in identity (tenant + plan)
 *   - Counts: running computers, sandboxes, deployments
 *   - Last fetch time + auto-refresh interval
 *   - Recent activity (most recent N rows from computers/sandboxes/deps)
 *   - Quit hint
 *
 * The component is self-contained — bin/miosa.ts is unchanged; the new
 * watch.ts command just mounts this with `ink.render()`.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { MiosaClient } from "../client.js";
import type { MiosaConfig } from "../types.js";

const POLL_INTERVAL_MS = 5_000;

interface DashboardProps {
  config: MiosaConfig;
}

interface ResourceRow {
  id: string;
  name?: string;
  status?: string;
  state?: string;
  template_type?: string;
  updated_at?: string;
  created_at?: string;
}

interface Snapshot {
  fetchedAt: number;
  tenant?: { name: string; plan: string; slug: string; credit_balance: number };
  computers: ResourceRow[];
  sandboxes: ResourceRow[];
  deployments: ResourceRow[];
  error?: string;
}

async function safeList<T extends ResourceRow>(
  client: MiosaClient,
  path: string,
): Promise<T[]> {
  try {
    const result = await client.apiGet<unknown>(path);
    if (Array.isArray(result)) return result as T[];
    if (result && typeof result === "object") {
      const rec = result as Record<string, unknown>;
      for (const key of [
        "data",
        "computers",
        "sandboxes",
        "deployments",
        "items",
      ]) {
        if (Array.isArray(rec[key])) return rec[key] as T[];
      }
    }
    return [];
  } catch {
    // Snapshot stays consistent even if one endpoint is flaky.
    return [];
  }
}

function isActive(row: ResourceRow): boolean {
  const s = (row.status ?? row.state ?? "").toLowerCase();
  return s === "active" || s === "running" || s === "ready";
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function sortRecent(rows: ResourceRow[]): ResourceRow[] {
  return [...rows].sort((a, b) => {
    const ta = new Date(a.updated_at ?? a.created_at ?? 0).getTime();
    const tb = new Date(b.updated_at ?? b.created_at ?? 0).getTime();
    return tb - ta;
  });
}

export const Dashboard: React.FC<DashboardProps> = ({ config }) => {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<Snapshot>({
    fetchedAt: 0,
    computers: [],
    sandboxes: [],
    deployments: [],
  });
  const [tick, setTick] = useState(0);

  // Quit handling
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  const client = useMemo(() => new MiosaClient(config), [config]);

  // Initial load + interval poll
  useEffect(() => {
    let cancelled = false;

    const fetch = async () => {
      try {
        const [computers, sandboxes, deployments, tenant] = await Promise.all([
          safeList<ResourceRow>(client, "/api/v1/computers"),
          safeList<ResourceRow>(client, "/api/v1/sandboxes"),
          safeList<ResourceRow>(client, "/api/v1/deployments"),
          client.getTenant().catch(() => null),
        ]);
        if (cancelled) return;
        setSnapshot({
          fetchedAt: Date.now(),
          tenant: tenant
            ? {
                name: tenant.name,
                plan: tenant.plan,
                slug: tenant.slug,
                credit_balance: tenant.credit_balance,
              }
            : undefined,
          computers,
          sandboxes,
          deployments,
        });
      } catch (err) {
        if (cancelled) return;
        setSnapshot((prev) => ({
          ...prev,
          fetchedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    void fetch();
    const id = setInterval(() => void fetch(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client]);

  // Local clock tick so "1s ago" labels stay fresh between polls
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const computeActive = snapshot.computers.filter(isActive).length;
  const sandboxActive = snapshot.sandboxes.filter(isActive).length;
  const deployActive = snapshot.deployments.filter(isActive).length;

  const recent = useMemo(
    () =>
      [
        ...snapshot.computers.map((r) => ({
          kind: "computer" as const,
          row: r,
        })),
        ...snapshot.sandboxes.map((r) => ({
          kind: "sandbox" as const,
          row: r,
        })),
        ...snapshot.deployments.map((r) => ({
          kind: "deployment" as const,
          row: r,
        })),
      ]
        .sort((a, b) => {
          const ta = new Date(
            a.row.updated_at ?? a.row.created_at ?? 0,
          ).getTime();
          const tb = new Date(
            b.row.updated_at ?? b.row.created_at ?? 0,
          ).getTime();
          return tb - ta;
        })
        .slice(0, 6),
    [snapshot, tick],
  );

  const lastFetchAgo =
    snapshot.fetchedAt === 0
      ? "—"
      : `${Math.max(0, Math.floor((Date.now() - snapshot.fetchedAt) / 1000))}s ago`;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* ── Header ─────────────────────────────────────────── */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text>
          <Text color="cyan" bold>
            ▮▮▮ MIOSA ▮▮▮
          </Text>
          {snapshot.tenant ? (
            <>
              {"  "}
              <Text bold>{snapshot.tenant.name}</Text>
              <Text dimColor> · {snapshot.tenant.plan}</Text>
            </>
          ) : (
            <Text dimColor> (loading identity…)</Text>
          )}
        </Text>
        <Text dimColor>
          last fetch {lastFetchAgo} · refresh {POLL_INTERVAL_MS / 1000}s
        </Text>
      </Box>

      {/* ── Resource counts ───────────────────────────────── */}
      <Box flexDirection="row" marginBottom={1}>
        <CountTile
          label="COMPUTERS"
          total={snapshot.computers.length}
          active={computeActive}
          accent="green"
        />
        <Box marginLeft={2}>
          <CountTile
            label="SANDBOXES"
            total={snapshot.sandboxes.length}
            active={sandboxActive}
            accent="blue"
          />
        </Box>
        <Box marginLeft={2}>
          <CountTile
            label="DEPLOYMENTS"
            total={snapshot.deployments.length}
            active={deployActive}
            accent="magenta"
          />
        </Box>
        {snapshot.tenant && (
          <Box marginLeft={2}>
            <CountTile
              label="CREDITS"
              total={snapshot.tenant.credit_balance}
              active={null}
              accent={snapshot.tenant.credit_balance > 0 ? "yellow" : "red"}
            />
          </Box>
        )}
      </Box>

      {/* ── Recent activity ───────────────────────────────── */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor bold>
          RECENT
        </Text>
        {recent.length === 0 ? (
          <Text dimColor>
            {" "}
            (no resources yet — run `miosa login` then create a sandbox)
          </Text>
        ) : (
          recent.map((item, idx) => (
            <Box key={`${item.kind}-${item.row.id}-${idx}`}>
              <Text color="cyan">{kindGlyph(item.kind)}</Text>
              <Text> </Text>
              <Text>
                {(item.row.name ?? item.row.id).slice(0, 32).padEnd(32)}
              </Text>
              <Text> </Text>
              <Text color={statusColor(item.row)}>
                {(item.row.status ?? item.row.state ?? "—").padEnd(12)}
              </Text>
              <Text dimColor>
                {timeAgo(item.row.updated_at ?? item.row.created_at)}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* ── Error banner (only when present) ──────────────── */}
      {snapshot.error && (
        <Box marginBottom={1}>
          <Text color="red">✗ </Text>
          <Text color="red">{snapshot.error}</Text>
        </Box>
      )}

      {/* ── Footer ────────────────────────────────────────── */}
      <Box>
        <Text dimColor>
          press <Text bold>q</Text> to quit · <Text bold>r</Text> to refresh now
          (auto every {POLL_INTERVAL_MS / 1000}s)
        </Text>
      </Box>
    </Box>
  );
};

// ── Subcomponents ──────────────────────────────────────────────────────────

interface CountTileProps {
  label: string;
  total: number;
  active: number | null;
  accent: "green" | "blue" | "magenta" | "yellow" | "red";
}

const CountTile: React.FC<CountTileProps> = ({
  label,
  total,
  active,
  accent,
}) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      minWidth={18}
    >
      <Text dimColor bold>
        {label}
      </Text>
      <Text>
        <Text color={accent} bold>
          {total}
        </Text>
        {active !== null && (
          <>
            <Text dimColor> total · </Text>
            <Text color={accent}>{active}</Text>
            <Text dimColor> active</Text>
          </>
        )}
      </Text>
    </Box>
  );
};

// ── Helpers ────────────────────────────────────────────────────────────────

function kindGlyph(kind: "computer" | "sandbox" | "deployment"): string {
  switch (kind) {
    case "computer":
      return "◆";
    case "sandbox":
      return "□";
    case "deployment":
      return "▲";
  }
}

function statusColor(row: ResourceRow): string {
  const s = (row.status ?? row.state ?? "").toLowerCase();
  if (s === "active" || s === "running" || s === "ready") return "green";
  if (s === "provisioning" || s === "building" || s === "pending")
    return "yellow";
  if (s === "error" || s === "failed") return "red";
  return "gray";
}

// Re-export for any future TUI command that wants to reuse helpers.
export { sortRecent, timeAgo, isActive };
