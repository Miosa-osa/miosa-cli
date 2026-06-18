import type { Command } from "commander";

type Shell = "bash" | "zsh" | "fish";

const COMMANDS = [
  "agent",
  "apps",
  "audit",
  "auth",
  "backups",
  "billing",
  "builds",
  "capabilities",
  "checkpoints",
  "cleanup",
  "completion",
  "computers",
  "config",
  "connect",
  "connectors",
  "containers",
  "cp",
  "cron",
  "dashboard",
  "databases",
  "db",
  "deploy",
  "dev",
  "doctor",
  "domains",
  "env",
  "exec",
  "functions",
  "groups",
  "hosts",
  "link",
  "login",
  "logout",
  "logs",
  "mcp",
  "meshes",
  "pull",
  "regions",
  "releases",
  "rollback",
  "run",
  "sandbox",
  "scale",
  "secrets",
  "services",
  "shell",
  "snapshot",
  "ssh",
  "status",
  "storage",
  "teams",
  "templates",
  "tenant",
  "tunnel",
  "up",
  "update",
  "version",
  "watch",
  "webhooks",
  "whoami",
  "workspaces",
];

const SUBCOMMANDS: Record<string, string[]> = {
  agent: ["start", "ls", "get", "task", "pause", "resume", "stop", "history"],
  apps: ["list", "ls", "create", "show", "open", "destroy", "delete"],
  domains: ["status", "list", "add", "verify", "assign", "delete"],
  cleanup: [
    "sandboxes",
    "deployments",
    "apps",
    "domains",
    "databases",
    "storage",
    "secrets",
    "snapshots",
    "checkpoints",
  ],
  sandbox: [
    "list",
    "ls",
    "show",
    "create",
    "exec",
    "ssh",
    "shell",
    "publish",
    "deploy",
    "connectors",
  ],
  computers: ["list", "show", "create", "connectors", "exec", "start", "stop", "restart"],
  connectors: [
    "list",
    "show",
    "create",
    "token",
    "installations",
    "oauth",
    "project-links",
    "triggers",
    "defaults",
  ],
  releases: ["list", "show", "get", "promote", "rollback"],
  workspaces: [
    "list",
    "create",
    "show",
    "update",
    "delete",
    "inventory",
    "cleanup",
  ],
};

function words(values: string[]): string {
  return values.join(" ");
}

function bashCompletion(): string {
  return `# miosa bash completion
_miosa_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${words(COMMANDS)}" -- "$cur") )
    return 0
  fi

  case "$prev" in
${Object.entries(SUBCOMMANDS)
  .map(
    ([cmd, subs]) =>
      `    ${cmd}) COMPREPLY=( $(compgen -W "${words(subs)}" -- "$cur") ) ;;`,
  )
  .join("\n")}
  esac
}
complete -F _miosa_completion miosa
`;
}

function zshCompletion(): string {
  return `#compdef miosa
# miosa zsh completion

local -a commands
commands=(${COMMANDS.map((cmd) => `${cmd}:'miosa ${cmd}'`).join(" ")})

if (( CURRENT == 2 )); then
  _describe 'command' commands
  return
fi

case $words[2] in
${Object.entries(SUBCOMMANDS)
  .map(
    ([cmd, subs]) =>
      `  ${cmd}) _values '${cmd} command' ${subs.map((sub) => `${sub}:'${sub}'`).join(" ")} ;;`,
  )
  .join("\n")}
esac
`;
}

function fishCompletion(): string {
  const lines = [
    "# miosa fish completion",
    ...COMMANDS.map(
      (cmd) => `complete -c miosa -f -n "__fish_use_subcommand" -a "${cmd}"`,
    ),
  ];

  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    for (const sub of subs) {
      lines.push(
        `complete -c miosa -f -n "__fish_seen_subcommand_from ${cmd}" -a "${sub}"`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function script(shell: Shell): string {
  switch (shell) {
    case "bash":
      return bashCompletion();
    case "zsh":
      return zshCompletion();
    case "fish":
      return fishCompletion();
  }
}

export function register(program: Command): void {
  program
    .command("completion <shell>")
    .description("Print shell completion script for bash, zsh, or fish")
    .action((shell: string) => {
      if (!["bash", "zsh", "fish"].includes(shell)) {
        console.error("Unsupported shell. Use: bash, zsh, fish");
        process.exit(1);
      }

      process.stdout.write(script(shell as Shell));
    });
}
