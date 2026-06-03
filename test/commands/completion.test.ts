import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { register } = await import("../../src/commands/completion.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa completion", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints zsh completion", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "completion", "zsh"]);

    expect(output).toContain("#compdef miosa");
    expect(output).toContain("agent");
    expect(output).toContain("sandbox");
  });

  it("prints fish completion", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "completion", "fish"]);

    expect(output).toContain("complete -c miosa");
    expect(output).toContain("agent");
  });
});

