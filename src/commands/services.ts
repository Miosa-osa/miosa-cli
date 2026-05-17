import type { Command } from "commander";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  const services = program
    .command("services")
    .description("Manage long-running services on Computers");

  // services list <computer-id>
  services
    .command("list <computer-id>")
    .description("List all services on a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/computers/${enc(id)}/services`, opts)),
    );

  // services create <computer-id> --name X --command "..."
  addDataOption(
    services
      .command("create <computer-id>")
      .description("Create a service on a Computer")
      .option("--name <name>", "Service name")
      .option("--command <cmd>", "Command to run")
      .option("--working-dir <dir>", "Working directory")
      .option("--port <port>", "Port the service listens on"),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: DataOptions & {
          name?: string;
          command?: string;
          workingDir?: string;
          port?: string;
        },
      ) =>
        runAction(() => {
          const flagBody: Record<string, unknown> = {};
          if (opts.name) flagBody["name"] = opts.name;
          if (opts.command) flagBody["command"] = opts.command;
          if (opts.workingDir) flagBody["working_dir"] = opts.workingDir;
          if (opts.port) flagBody["port"] = Number(opts.port);
          return postAndPrint(`/computers/${enc(id)}/services`, opts, flagBody);
        }),
    );

  // services show <computer-id> <service-id>
  services
    .command("show <computer-id> <service-id>")
    .description("Show a service")
    .option("--json", "Output as JSON")
    .action((id: string, serviceId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/computers/${enc(id)}/services/${enc(serviceId)}`, opts),
      ),
    );

  // services start <computer-id> <service-id>
  services
    .command("start <computer-id> <service-id>")
    .description("Start a stopped service")
    .option("--json", "Output as JSON")
    .action((id: string, serviceId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(id)}/services/${enc(serviceId)}/start`,
          opts,
        ),
      ),
    );

  // services stop <computer-id> <service-id>
  services
    .command("stop <computer-id> <service-id>")
    .description("Stop a running service")
    .option("--json", "Output as JSON")
    .action((id: string, serviceId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(id)}/services/${enc(serviceId)}/stop`,
          opts,
        ),
      ),
    );

  // services restart <computer-id> <service-id>
  services
    .command("restart <computer-id> <service-id>")
    .description("Restart a service")
    .option("--json", "Output as JSON")
    .action((id: string, serviceId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(id)}/services/${enc(serviceId)}/restart`,
          opts,
        ),
      ),
    );

  // services logs <computer-id> <service-id>
  services
    .command("logs <computer-id> <service-id>")
    .description("Show service logs")
    .option("--json", "Output as JSON")
    .action((id: string, serviceId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          `/computers/${enc(id)}/services/${enc(serviceId)}/logs`,
          opts,
        ),
      ),
    );

  // services delete <computer-id> <service-id>
  services
    .command("delete <computer-id> <service-id>")
    .description("Delete a service (stops it first if running)")
    .option("--json", "Output as JSON")
    .action((id: string, serviceId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(
          `/computers/${enc(id)}/services/${enc(serviceId)}`,
          opts,
        ),
      ),
    );
}
