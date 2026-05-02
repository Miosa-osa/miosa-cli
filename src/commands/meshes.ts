import type { Command } from "commander";
import {
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  resourceCommands,
  runAction,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  resourceCommands({
    program,
    command: "meshes",
    description: "Manage WireGuard mesh networks",
    route: "/opencomputers/meshes",
    itemName: "mesh-id",
  });

  const meshes = program.commands.find((cmd) => cmd.name() === "meshes");
  meshes!
    .command("events <mesh-id>")
    .description("Show mesh events")
    .option("--json", "Output as JSON")
    .action((meshId: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/opencomputers/meshes/${enc(meshId)}/events`, opts)),
    );

  meshes!
    .command("add-host <mesh-id> <host-id>")
    .description("Add a host to a mesh")
    .option("--json", "Output as JSON")
    .action((meshId: string, hostId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/meshes/${enc(meshId)}/hosts/${enc(hostId)}`, opts),
      ),
    );

  meshes!
    .command("remove-host <mesh-id> <host-id>")
    .description("Remove a host from a mesh")
    .option("--json", "Output as JSON")
    .action((meshId: string, hostId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/opencomputers/meshes/${enc(meshId)}/hosts/${enc(hostId)}`, opts),
      ),
    );
}
