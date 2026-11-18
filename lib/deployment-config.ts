/**
 * Per-client deployment configuration.
 *
 * Loaded from a JSON file in `deployments/` (gitignored).
 * See `deployments.example/` for schema and example.
 */
export interface DeploymentConfig {
  /** Short identifier for the client/context (e.g. 'nery', 'al4n', 'eworks'). */
  clientSlug: string;
  /** Deployment environment: dev | stg | prd. */
  envName: "dev" | "stg" | "prd";
  /** 12-digit AWS account ID. */
  account: string;
  /** AWS region. */
  region: string;
  /** Prefix for all named AWS resources. Replaces hardcoded 'rag-knowledge-agent'. */
  resourcePrefix: string;
  /** CloudFormation stack name. Defaults to '{resourcePrefix}-{envName}'. */
  stackName?: string;
  /** Additional tags applied to all stack resources. */
  tags?: Record<string, string>;
  /** Supabase project ref for dual-issuer JWT (optional). */
  supabaseProjectRef?: string;
  /** Knowledge Base config. */
  knowledgeBase?: {
    existingKnowledgeBaseId?: string;
    existingKnowledgeBaseArn?: string;
    embeddingModelId?: string;
  };
  /** Bedrock Agent config. */
  agent?: {
    modelId?: string;
    instructionOverride?: string;
  };
  /** Cognito config. */
  cognito?: {
    domainPrefix?: string;
    googleClientId?: string;
  };
}

/**
 * Load a deployment config from a JSON file path.
 * @param configPath - Path to the JSON config file (e.g. 'deployments/nery.json')
 * @returns Parsed and validated DeploymentConfig
 * @throws If the file doesn't exist or fails basic validation
 */
export function loadDeploymentConfig(configPath: string): DeploymentConfig {
  const fs = require("fs");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Deployment config not found: ${configPath}\n` +
        `Copy deployments.example/ to deployments/ and create a config file.`
    );
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as DeploymentConfig;

  // Basic validation
  const required: (keyof DeploymentConfig)[] = [
    "clientSlug",
    "envName",
    "account",
    "region",
    "resourcePrefix",
  ];
  for (const key of required) {
    if (!config[key]) {
      throw new Error(`Deployment config missing required field: ${key}`);
    }
  }
  if (!/^\d{12}$/.test(config.account)) {
    throw new Error(`Invalid account ID: ${config.account} (expected 12 digits)`);
  }
  const validEnvs = ["dev", "stg", "prd"];
  if (!validEnvs.includes(config.envName)) {
    throw new Error(`Invalid envName: ${config.envName} (must be one of: ${validEnvs.join(", ")})`);
  }

  // Defaults
  if (!config.stackName) {
    config.stackName = `${config.resourcePrefix}-${config.envName}`;
  }

  return config;
}
