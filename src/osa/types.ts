export type DiagnosticSeverity = "error" | "warning";

export interface OsaDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface OsaSkill {
  name: string;
  path: string;
  source: "project" | "builtin";
  trust: "local" | "builtin" | "verified" | "workspace" | "third_party";
  description: string;
  permissions: string[];
}

export interface OsaConnection {
  name: string;
  path: string;
  type: string;
  description: string;
  hasAuth: boolean;
  url?: string;
}

export interface OsaChannel {
  name: string;
  path: string;
  type: string;
  description: string;
  entrypoint?: string;
}

export interface OsaSchedule {
  name: string;
  path: string;
  cron?: string;
  prompt?: string;
}

export interface OsaComputer {
  name: string;
  path: string;
  enabled: boolean;
  kind?: string;
  size?: string;
  capabilities: string[];
}

export interface OsaSubagent {
  name: string;
  path: string;
  description?: string;
  model?: string;
  config?: string;
  instructions?: string;
}

export interface OsaEval {
  name: string;
  path: string;
}

export type OsaRuntimeScalar = string | number | boolean | null;
export type OsaRuntimeRecord = {
  [key: string]: OsaRuntimeScalar | OsaRuntimeScalar[] | OsaRuntimeRecord | OsaRuntimeRecord[];
};

export interface OsaRuntimeProfile {
  model?: string | OsaRuntimeRecord;
  provider?: string;
  harness?: OsaRuntimeRecord;
  runtime?: OsaRuntimeRecord;
  sandbox?: OsaRuntimeRecord;
  policy?: OsaRuntimeRecord;
  capabilities?: OsaRuntimeRecord;
}

export interface OsaManifest {
  version: 1;
  projectRoot: string;
  osaRoot: string;
  sourceRoot: "agent" | "osa";
  agent: {
    name: string;
    description?: string;
    model?: string;
    config?: string;
  };
  runtimeProfile: OsaRuntimeProfile;
  context: {
    agentsMd?: string;
    instructions: string[];
    docs: string[];
  };
  skills: OsaSkill[];
  connections: OsaConnection[];
  channels: OsaChannel[];
  schedules: OsaSchedule[];
  computers: OsaComputer[];
  subagents: OsaSubagent[];
  hooks: string[];
  sandbox: {
    config?: string;
    workspace: string[];
  };
  evals: OsaEval[];
  diagnostics: {
    errors: number;
    warnings: number;
  };
}

export interface OsaDiscovery {
  manifest: OsaManifest;
  diagnostics: OsaDiagnostic[];
}

export interface OsaDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  warn?: boolean;
}

export interface OsaBuildArtifact {
  version: 1;
  builtAt: string;
  projectRoot: string;
  manifestPath: string;
  diagnosticsPath: string;
  errors: number;
  warnings: number;
}

export interface OsaEvalResult {
  name: string;
  path: string;
  status: "passed" | "failed";
  checks: Array<{
    name: string;
    status: "passed" | "failed";
    detail: string;
  }>;
}

export interface OsaEvalReport {
  ok: boolean;
  projectRoot: string;
  results: OsaEvalResult[];
  errors: number;
  warnings: number;
}

export interface OsaExecutionPlan {
  version: 1;
  kind: "run" | "dev" | "deploy";
  createdAt: string;
  projectRoot: string;
  agentName: string;
  target: string;
  task?: string;
  manifestPath: string;
  runtimeProfile: OsaRuntimeProfile;
  requiredRuntime: boolean;
  steps: Array<{
    id: string;
    description: string;
  }>;
}
