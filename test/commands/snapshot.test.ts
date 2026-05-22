import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
  }),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
  ora: vi.fn(),
}));

const { register } = await import("../../src/commands/snapshot.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const mockCheckpoint = {
  id: "snap-abc123",
  computer_id: "comp-xyz",
  comment: "after-setup",
  size_bytes: 2_469_606_195, // ~2.3 GB
  state: "ready",
  inserted_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
  updated_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
};

describe("miosa snapshot", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("ls", () => {
    it("should render a table of checkpoints", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots",
          method: "GET",
        })
        .reply(200, JSON.stringify({ data: [mockCheckpoint] }), {
          headers: { "content-type": "application/json" },
        });

      const logged: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

      const program = buildProgram();
      await program.parseAsync(["node", "miosa", "snapshot", "ls", "comp-xyz"]);

      const output = logged.join("\n");
      expect(output).toContain("after-setup");
      expect(output).toContain("snap-abc123");
    });

    it("should output JSON with --json flag", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots",
          method: "GET",
        })
        .reply(200, JSON.stringify({ data: [mockCheckpoint] }), {
          headers: { "content-type": "application/json" },
        });

      const logged: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "snapshot",
        "ls",
        "comp-xyz",
        "--json",
      ]);

      const parsed = JSON.parse(logged.join("")) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it("should print dim message when no snapshots exist", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots",
          method: "GET",
        })
        .reply(200, JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        });

      const logged: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

      const program = buildProgram();
      await program.parseAsync(["node", "miosa", "snapshot", "ls", "comp-xyz"]);

      expect(logged.join(" ")).toContain("No snapshots");
    });
  });

  describe("create", () => {
    it("should POST to checkpoints and succeed", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots",
          method: "POST",
        })
        .reply(200, JSON.stringify({ data: mockCheckpoint }), {
          headers: { "content-type": "application/json" },
        });

      const program = buildProgram();
      // Should not throw
      await expect(
        program.parseAsync([
          "node",
          "miosa",
          "snapshot",
          "create",
          "comp-xyz",
          "--name",
          "after-setup",
        ]),
      ).resolves.not.toThrow();
    });

    it("should output JSON with --json flag", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots",
          method: "POST",
        })
        .reply(200, JSON.stringify({ data: mockCheckpoint }), {
          headers: { "content-type": "application/json" },
        });

      const logged: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "snapshot",
        "create",
        "comp-xyz",
        "--json",
      ]);

      const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
      expect(parsed["id"]).toBe("snap-abc123");
    });
  });

  describe("restore", () => {
    it("should POST to restore endpoint", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");

      // GET checkpoint for name resolution
      pool
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots/snap-abc123",
          method: "GET",
        })
        .reply(200, JSON.stringify({ data: mockCheckpoint }), {
          headers: { "content-type": "application/json" },
        });

      // POST restore
      pool
        .intercept({
          path: "/api/v1/computers/comp-xyz/restore/snap-abc123",
          method: "POST",
        })
        .reply(200, JSON.stringify({ data: mockCheckpoint }), {
          headers: { "content-type": "application/json" },
        });

      const program = buildProgram();
      await expect(
        program.parseAsync([
          "node",
          "miosa",
          "snapshot",
          "restore",
          "comp-xyz",
          "snap-abc123",
        ]),
      ).resolves.not.toThrow();
    });
  });

  describe("delete", () => {
    it("should DELETE the checkpoint and print name", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");

      // GET for name resolution
      pool
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots/snap-abc123",
          method: "GET",
        })
        .reply(200, JSON.stringify({ data: mockCheckpoint }), {
          headers: { "content-type": "application/json" },
        });

      // DELETE
      pool
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots/snap-abc123",
          method: "DELETE",
        })
        .reply(204, "", { headers: {} });

      const logged: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "snapshot",
        "delete",
        "comp-xyz",
        "snap-abc123",
      ]);

      expect(logged.join(" ")).toContain("after-setup");
    });

    it("should output JSON with --json flag", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");

      pool
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots/snap-abc123",
          method: "GET",
        })
        .reply(200, JSON.stringify({ data: mockCheckpoint }), {
          headers: { "content-type": "application/json" },
        });

      pool
        .intercept({
          path: "/api/v1/computers/comp-xyz/snapshots/snap-abc123",
          method: "DELETE",
        })
        .reply(204, "", { headers: {} });

      const logged: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });

      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "snapshot",
        "delete",
        "comp-xyz",
        "snap-abc123",
        "--json",
      ]);

      const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
      expect(parsed["deleted"]).toBe(true);
      expect(parsed["id"]).toBe("snap-abc123");
    });
  });

  describe("404 error handling", () => {
    it("should call process.exit(1) on 404 for ls", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/computers/bad-id/snapshots",
          method: "GET",
        })
        .reply(404, JSON.stringify({ message: "Not found" }), {
          headers: { "content-type": "application/json" },
        });

      const program = buildProgram();
      await program.parseAsync(["node", "miosa", "snapshot", "ls", "bad-id"]);

      expect(process.exit).toHaveBeenCalledWith(expect.any(Number));
    });
  });
});
