import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We'll test the config module with a temp dir override
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-cli-test-"));
const TEST_CONFIG = path.join(TEST_HOME, ".miosa", "config.json");

// Override homedir before importing config
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, default: { ...actual, homedir: () => TEST_HOME } };
});

// Now import after mock is set up
const { loadConfig, saveConfig, clearApiKey, redactKey } =
  await import("../src/config.js");

describe("config", () => {
  beforeEach(() => {
    // Clean config dir before each test
    if (fs.existsSync(path.join(TEST_HOME, ".miosa"))) {
      fs.rmSync(path.join(TEST_HOME, ".miosa"), { recursive: true });
    }
    // Clear env overrides
    delete process.env["MIOSA_API_KEY"];
    delete process.env["MIOSA_ENDPOINT"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadConfig", () => {
    it("should return defaults when no config file exists", () => {
      const config = loadConfig();
      expect(config.endpoint).toBe("https://api.miosa.ai");
      expect(config.api_key).toBeNull();
      expect(config.default_host).toBeNull();
    });

    it("should load values from config file", () => {
      fs.mkdirSync(path.join(TEST_HOME, ".miosa"), { recursive: true });
      fs.writeFileSync(
        TEST_CONFIG,
        JSON.stringify({
          endpoint: "https://custom.endpoint.ai",
          api_key: "msk_u_testkey123",
          default_host: "my-mac",
        }),
      );
      const config = loadConfig();
      expect(config.endpoint).toBe("https://custom.endpoint.ai");
      expect(config.api_key).toBe("msk_u_testkey123");
      expect(config.default_host).toBe("my-mac");
    });

    it("should prefer env vars over config file", () => {
      fs.mkdirSync(path.join(TEST_HOME, ".miosa"), { recursive: true });
      fs.writeFileSync(
        TEST_CONFIG,
        JSON.stringify({ api_key: "msk_u_fromfile" }),
      );
      process.env["MIOSA_API_KEY"] = "msk_u_fromenv";
      process.env["MIOSA_ENDPOINT"] = "https://env.endpoint.ai";

      const config = loadConfig();
      expect(config.api_key).toBe("msk_u_fromenv");
      expect(config.endpoint).toBe("https://env.endpoint.ai");
    });

    it("should handle corrupt config file gracefully", () => {
      fs.mkdirSync(path.join(TEST_HOME, ".miosa"), { recursive: true });
      fs.writeFileSync(TEST_CONFIG, "{ not valid json }}}");
      const config = loadConfig();
      expect(config.endpoint).toBe("https://api.miosa.ai");
      expect(config.api_key).toBeNull();
    });
  });

  describe("saveConfig", () => {
    it("should create config dir and write file", () => {
      saveConfig({
        api_key: "msk_u_saved" as import("../src/types.js").ApiKey,
      });
      expect(fs.existsSync(TEST_CONFIG)).toBe(true);
      const written = JSON.parse(fs.readFileSync(TEST_CONFIG, "utf8")) as {
        api_key: string;
      };
      expect(written.api_key).toBe("msk_u_saved");
    });

    it("should merge with existing config", () => {
      saveConfig({ endpoint: "https://first.ai" });
      saveConfig({
        api_key: "msk_u_second" as import("../src/types.js").ApiKey,
      });
      const written = JSON.parse(fs.readFileSync(TEST_CONFIG, "utf8")) as {
        endpoint: string;
        api_key: string;
      };
      expect(written.endpoint).toBe("https://first.ai");
      expect(written.api_key).toBe("msk_u_second");
    });

    it("should write config with restricted permissions", () => {
      saveConfig({
        api_key: "msk_u_perms" as import("../src/types.js").ApiKey,
      });
      const stat = fs.statSync(TEST_CONFIG);
      // mode & 0o777 should be 0o600 (owner read/write only)
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("clearApiKey", () => {
    it("should set api_key to null in config", () => {
      saveConfig({
        api_key: "msk_u_todelete" as import("../src/types.js").ApiKey,
      });
      clearApiKey();
      const written = JSON.parse(fs.readFileSync(TEST_CONFIG, "utf8")) as {
        api_key: unknown;
      };
      expect(written.api_key).toBeNull();
    });
  });

  describe("redactKey", () => {
    it("should return (none) for null", () => {
      expect(redactKey(null)).toBe("(none)");
    });

    it("should return *** for very short keys", () => {
      expect(redactKey("abc")).toBe("***");
    });

    it("should redact middle of a normal key", () => {
      const result = redactKey("msk_u_abcdefghijklmnop");
      expect(result).toMatch(/^msk_u_ab\.\.\./);
      expect(result.endsWith("mnop")).toBe(true);
      expect(result).not.toContain("abcdefghijklmnop");
    });
  });
});
