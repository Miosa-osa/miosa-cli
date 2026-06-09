import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { isJsonMode } from "./util.js";
import { UserError } from "../errors.js";

interface NewOptions {
  json?: boolean;
  force?: boolean;
}

interface StarterFile {
  path: string;
  content: string;
}

interface Starter {
  id: string;
  name: string;
  description: string;
  files: StarterFile[];
  next: string[];
}

const STARTERS: Record<string, Starter> = {
  nextjs: {
    id: "nextjs",
    name: "Next.js App",
    description: "App Router starter for page/template based apps",
    files: [
      {
        path: "miosa.app.yml",
        content: `template: nextjs
workdir: /workspace
install: npm install
dev: npm run dev -- -H 0.0.0.0 -p 3000
build: npm run build
start: npm start
port: 3000
readiness:
  path: /
`,
      },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            scripts: {
              dev: "next dev",
              build: "next build",
              start: "next start -H 0.0.0.0 -p 3000",
            },
            dependencies: {
              "@types/node": "latest",
              "@types/react": "latest",
              "@types/react-dom": "latest",
              next: "latest",
              react: "latest",
              "react-dom": "latest",
              typescript: "latest",
            },
            devDependencies: {},
          },
          null,
          2,
        ) + "\n",
      },
      {
        path: "app/page.tsx",
        content: `export default function Page() {
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 40 }}>
      <h1>MIOSA app</h1>
      <p>Build in a sandbox, preview instantly, publish when ready.</p>
    </main>
  );
}
`,
      },
      {
        path: "app/layout.tsx",
        content: `export const metadata = { title: "MIOSA app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      },
      { path: "tsconfig.json", content: "{}\n" },
    ],
    next: [
      "miosa sandbox deploy . --wait",
      "miosa sandbox publish <sandbox-id> --slug my-app --docker-deploy --wait",
    ],
  },
  "nextjs-postgres": {
    id: "nextjs-postgres",
    name: "Next.js + Postgres App",
    description: "Next.js starter that expects DATABASE_URL at runtime",
    files: [
      {
        path: "miosa.app.yml",
        content: `template: nextjs-postgres
workdir: /workspace
install: npm install
dev: npm run dev -- -H 0.0.0.0 -p 3000
build: npm run build
start: npm start
port: 3000
readiness:
  path: /
`,
      },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            scripts: {
              dev: "next dev",
              build: "next build",
              start: "next start -H 0.0.0.0 -p 3000",
            },
            dependencies: {
              "@types/node": "latest",
              "@types/react": "latest",
              "@types/react-dom": "latest",
              next: "latest",
              pg: "latest",
              react: "latest",
              "react-dom": "latest",
              typescript: "latest",
            },
            devDependencies: {},
          },
          null,
          2,
        ) + "\n",
      },
      {
        path: "app/page.tsx",
        content: `export default function Page() {
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 40 }}>
      <h1>MIOSA Next.js + Postgres</h1>
      <p>DATABASE_URL is {process.env.DATABASE_URL ? "configured" : "not configured"}.</p>
    </main>
  );
}
`,
      },
      {
        path: "app/layout.tsx",
        content: `export const metadata = { title: "MIOSA Postgres app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      },
      { path: "tsconfig.json", content: "{}\n" },
    ],
    next: [
      "miosa databases create --engine postgres --wait",
      "miosa sandbox deploy . --template nextjs-postgres --wait",
      "miosa sandbox publish <sandbox-id> --database existing:<db-id> --slug my-app --docker-deploy --wait",
    ],
  },
  "vite-react": {
    id: "vite-react",
    name: "Vite React App",
    description: "Fast frontend app starter",
    files: [
      {
        path: "miosa.app.yml",
        content: `template: vite-react
workdir: /workspace
install: npm install
dev: npm run dev -- --host 0.0.0.0 --port 5173
build: npm run build
output: dist
port: 5173
readiness:
  path: /
`,
      },
      {
        path: "package.json",
        content: JSON.stringify(
          {
            scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
            dependencies: {
              "@vitejs/plugin-react": "latest",
              vite: "latest",
              react: "latest",
              "react-dom": "latest",
              typescript: "latest",
            },
            devDependencies: {},
          },
          null,
          2,
        ) + "\n",
      },
      { path: "index.html", content: `<div id="root"></div><script type="module" src="/src/App.tsx"></script>\n` },
      {
        path: "src/App.tsx",
        content: `import { createRoot } from "react-dom/client";

function App() {
  return <main style={{ padding: 40, fontFamily: "system-ui" }}>MIOSA Vite app</main>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
      },
    ],
    next: ["miosa sandbox deploy . --wait"],
  },
  fastapi: {
    id: "fastapi",
    name: "FastAPI App",
    description: "Python API starter",
    files: [
      {
        path: "miosa.app.yml",
        content: `template: fastapi
workdir: /workspace
install: pip install -r requirements.txt
dev: uvicorn main:app --host 0.0.0.0 --port 8000
build: "true"
start: uvicorn main:app --host 0.0.0.0 --port 8000
port: 8000
readiness:
  path: /
`,
      },
      { path: "requirements.txt", content: "fastapi\nuvicorn[standard]\n" },
      {
        path: "main.py",
        content: `from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def read_root():
    return {"ok": True, "app": "miosa-fastapi"}
`,
      },
    ],
    next: ["miosa sandbox deploy . --wait"],
  },
  static: {
    id: "static",
    name: "Static Site",
    description: "Plain HTML/CSS/JS starter",
    files: [
      {
        path: "miosa.app.yml",
        content: `template: static-site
workdir: /workspace
dev: python3 -m http.server 5173 --bind 0.0.0.0
output: /workspace
port: 5173
readiness:
  path: /
`,
      },
      { path: "index.html", content: "<h1>MIOSA static site</h1>\n" },
    ],
    next: ["miosa sandbox deploy . --wait"],
  },
};

export function register(program: Command): void {
  program
    .command("new <template> [dir]")
    .description("Create a MIOSA app starter with miosa.app.yml defaults")
    .option("--force", "Write into a non-empty directory")
    .option("--json", "Output as JSON")
    .action((template: string, dir = template, opts: NewOptions) => {
      const starter = STARTERS[template];
      if (!starter) {
        throw new UserError(
          `Unknown app starter: ${template}`,
          `Use one of: ${Object.keys(STARTERS).join(", ")}`,
        );
      }

      const target = path.resolve(dir);
      if (fs.existsSync(target) && fs.readdirSync(target).length > 0 && !opts.force) {
        throw new UserError(
          `Directory is not empty: ${target}`,
          "Pass --force to write starter files anyway.",
        );
      }

      for (const file of starter.files) {
        const fullPath = path.join(target, file.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        if (fs.existsSync(fullPath) && !opts.force) {
          throw new UserError(`File already exists: ${fullPath}`);
        }
        fs.writeFileSync(fullPath, file.content);
      }

      const result = {
        ok: true,
        data: {
          template: starter.id,
          name: starter.name,
          dir: target,
          files: starter.files.map((file) => file.path),
          next: starter.next,
        },
      };

      if (isJsonMode(opts)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      console.log(chalk.green(`Created ${starter.name}`));
      console.log(chalk.dim(target));
      console.log();
      for (const cmd of starter.next) console.log(`  ${chalk.cyan(cmd)}`);
      console.log();
    });
}
