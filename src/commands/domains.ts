import type { Command } from "commander";
import {
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  runAction,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  const domains = program
    .command("domains")
    .description("Manage custom domains on Computers");

  // domains list <computer-id>
  domains
    .command("list <computer-id>")
    .description("List all custom domains for a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/computers/${enc(id)}/domains`, opts)),
    );

  // domains add <computer-id> <fqdn>
  domains
    .command("add <computer-id> <fqdn>")
    .description("Register a custom FQDN for a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, fqdn: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(`/computers/${enc(id)}/domains`, opts, { fqdn }),
      ),
    );

  // domains verify <computer-id> <domain-id>
  domains
    .command("verify <computer-id> <domain-id>")
    .description("Verify DNS ownership of a registered domain")
    .option("--json", "Output as JSON")
    .action((id: string, domainId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(id)}/domains/${enc(domainId)}/verify`,
          opts,
        ),
      ),
    );

  // domains delete <computer-id> <domain-id>
  domains
    .command("delete <computer-id> <domain-id>")
    .description("Delete a custom domain mapping")
    .option("--json", "Output as JSON")
    .action((id: string, domainId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/computers/${enc(id)}/domains/${enc(domainId)}`, opts),
      ),
    );
}
