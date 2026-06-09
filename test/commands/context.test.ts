import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-context-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, default: { ...actual, homedir: () => TEST_HOME } };
});

const { saveConfig, loadConfig, loadContextStore } = await import(
  "../../src/config.js"
);
const { register } = await import("../../src/commands/context.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json");
  register(program);
  return program;
}

async function runContextCommand(args: string[]): Promise<void> {
  await buildProgram().parseAsync(["node", "miosa", ...args]);
}

describe("miosa context", () => {
  beforeEach(() => {
    fs.rmSync(path.join(TEST_HOME, ".miosa"), {
      recursive: true,
      force: true,
    });
    delete process.env["MIOSA_JSON"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves and switches named contexts without exposing raw API keys", async () => {
    process.env["MIOSA_JSON"] = "1";
    saveConfig({
      endpoint: "https://api.one.test",
      api_key: "msk_u_first_secret" as never,
      tenant: "tenant-one",
      workspace: "workspace-one",
      region: "us-east",
    });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await runContextCommand(["context", "save", "one", "--json"]);

    saveConfig({
      endpoint: "https://api.two.test",
      api_key: "msk_u_second_secret" as never,
      tenant: "tenant-two",
      workspace: "workspace-two",
      region: "us-west",
    });
    await runContextCommand(["context", "save", "two", "--json"]);
    await runContextCommand(["context", "use", "one", "--json"]);
    await runContextCommand(["context", "ls", "--json"]);

    const outputs = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    const list = outputs.at(-1) as {
      active: string;
      contexts: Array<{ name: string; api_key: string }>;
    };

    expect(loadConfig()).toMatchObject({
      endpoint: "https://api.one.test",
      tenant: "tenant-one",
      workspace: "workspace-one",
      region: "us-east",
    });
    expect(loadContextStore().active).toBe("one");
    expect(list.active).toBe("one");
    expect(list.contexts.map((ctx) => ctx.name)).toEqual(["one", "two"]);
    expect(list.contexts[0]?.api_key).not.toContain("first_secret");
  });

  it("updates current config and active context scope", async () => {
    saveConfig({
      api_key: "msk_u_secret" as never,
      workspace: "old-workspace",
    });

    vi.spyOn(console, "log").mockImplementation(() => {});

    await runContextCommand(["context", "save", "dev", "--json"]);
    await runContextCommand([
      "context",
      "set",
      "workspace",
      "new-workspace",
      "--json",
    ]);

    expect(loadConfig().workspace).toBe("new-workspace");
    expect(loadContextStore().contexts["dev"]?.workspace).toBe("new-workspace");
  });
});
