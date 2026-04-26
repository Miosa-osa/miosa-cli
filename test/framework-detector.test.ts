import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectFramework,
  detectFrameworkAll,
} from "../src/framework-detector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  path.join(__dirname, "fixtures", name);

describe("framework-detector", () => {
  // ── individual detectors ──────────────────────────────────────────────────

  describe("Next.js", () => {
    it("should detect nextjs with high confidence when next.config.* present", () => {
      const result = detectFramework(fixture("nextjs"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("nextjs");
      expect(result?.confidence).toBeGreaterThanOrEqual(90);
      expect(result?.buildCommand).toBe("npm run build");
      expect(result?.runCommand).toBe("npm start");
    });

    it("should include next.config.* in filesExamined", () => {
      const result = detectFramework(fixture("nextjs"));
      expect(result?.filesExamined).toContain("next.config.*");
    });
  });

  describe("SvelteKit", () => {
    it("should detect sveltekit with high confidence when svelte.config present", () => {
      const result = detectFramework(fixture("sveltekit"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("sveltekit");
      expect(result?.confidence).toBeGreaterThanOrEqual(90);
      expect(result?.buildCommand).toBe("npm run build");
      expect(result?.runCommand).toBe("node build");
    });
  });

  describe("Vite + React", () => {
    it("should detect vite-react with high confidence when vite.config present", () => {
      const result = detectFramework(fixture("vite-react"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("vite-react");
      expect(result?.confidence).toBeGreaterThanOrEqual(85);
      expect(result?.buildCommand).toBe("npm run build");
      expect(result?.runCommand).toContain("serve dist");
    });
  });

  describe("Phoenix", () => {
    it("should detect phoenix with app name from mix.exs", () => {
      const result = detectFramework(fixture("phoenix"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("phoenix");
      expect(result?.confidence).toBeGreaterThanOrEqual(85);
      expect(result?.buildCommand).toContain("mix release");
      expect(result?.runCommand).toContain("my_app");
      expect(result?.envKeysNeeded).toContain("SECRET_KEY_BASE");
    });

    it("should include mix.exs in filesExamined", () => {
      const result = detectFramework(fixture("phoenix"));
      expect(result?.filesExamined).toContain("mix.exs");
    });
  });

  describe("Django", () => {
    it("should detect django from manage.py + requirements.txt containing Django", () => {
      const result = detectFramework(fixture("django"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("django");
      expect(result?.confidence).toBeGreaterThanOrEqual(80);
      expect(result?.buildCommand).toContain("pip install");
      expect(result?.runCommand).toContain("gunicorn");
      expect(result?.envKeysNeeded).toContain("DATABASE_URL");
    });
  });

  describe("Flask", () => {
    it("should detect flask from requirements.txt containing flask + app.py", () => {
      const result = detectFramework(fixture("flask"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("flask");
      expect(result?.confidence).toBeGreaterThanOrEqual(80);
      expect(result?.buildCommand).toContain("pip install");
      expect(result?.runCommand).toContain("gunicorn app:app");
    });
  });

  describe("Rails", () => {
    it("should detect rails from Gemfile + config/application.rb", () => {
      const result = detectFramework(fixture("rails"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("rails");
      expect(result?.confidence).toBeGreaterThanOrEqual(88);
      expect(result?.buildCommand).toContain("bundle install");
      expect(result?.runCommand).toContain("rails server");
      expect(result?.envKeysNeeded).toContain("SECRET_KEY_BASE");
    });
  });

  describe("Go", () => {
    it("should detect go from go.mod + main.go", () => {
      const result = detectFramework(fixture("go"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("go");
      expect(result?.confidence).toBeGreaterThanOrEqual(88);
      expect(result?.buildCommand).toBe("go build -o app .");
      expect(result?.runCommand).toContain("my-go-app");
    });
  });

  describe("Rust", () => {
    it("should detect rust from Cargo.toml + src/main.rs with binary name", () => {
      const result = detectFramework(fixture("rust"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("rust");
      expect(result?.confidence).toBeGreaterThanOrEqual(88);
      expect(result?.buildCommand).toBe("cargo build --release");
      expect(result?.runCommand).toBe("./target/release/my-rust-app");
    });
  });

  describe("Static HTML", () => {
    it("should detect static when only index.html present with no build system", () => {
      const result = detectFramework(fixture("static"));
      expect(result).not.toBeNull();
      expect(result?.framework).toBe("static");
      expect(result?.buildCommand).toBe("");
      expect(result?.runCommand).toContain("serve");
    });
  });

  // ── ranking ───────────────────────────────────────────────────────────────

  describe("detectFrameworkAll — ranking", () => {
    it("should rank Next.js above vite-react for a nextjs project", () => {
      const all = detectFrameworkAll(fixture("nextjs"));
      // Next.js has both "next" and "react" in deps, so vite-react might also
      // fire (no vite dep here, so it won't — but confirm nextjs is first)
      expect(all[0]?.framework).toBe("nextjs");
    });

    it("should return multiple results for vite-react fixture (react present)", () => {
      const all = detectFrameworkAll(fixture("vite-react"));
      const frameworks = all.map((r) => r.framework);
      expect(frameworks).toContain("vite-react");
      // vite-react should be first (highest confidence)
      expect(all[0]?.framework).toBe("vite-react");
    });
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  describe("empty / unknown directory", () => {
    it("should return null for a directory with no recognizable files", () => {
      // Use test/fixtures itself — has no build system files at root
      const result = detectFramework(path.join(__dirname, "fixtures"));
      // fixtures/ has subdirs but no package.json/mix.exs/etc at root
      expect(result).toBeNull();
    });
  });

  describe("confidence threshold", () => {
    it("should return null when best confidence is below 50", () => {
      // Non-existent dir — all detectors return null
      const result = detectFramework("/tmp/__miosa_nonexistent_fixture__");
      expect(result).toBeNull();
    });
  });
});
