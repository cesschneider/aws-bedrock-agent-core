import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";
import { TokenVerifier } from "../common/token-verifier";

/**
 * API Gateway Lambda authorizer (dual-issuer). Validates a Cognito (RS256) or
 * Supabase/Lovable Cloud (ES256) bearer token and returns a normalized
 * authorization context that the downstream handlers consume.
 *
 * The context keys are surfaced to the integration as
 * `requestContext.authorizer.lambda.<key>` (string values only). We emit:
 *   - tenantId     — the resolved tenant (from custom:tenantId or membership)
 *   - email        — the caller's email (lowercased; may be empty for Cognito)
 *   - departments  — comma-separated tenant-namespaced departments
 *   - userId       — stable subject (Cognito sub / Supabase sub)
 *
 * On failure the authorizer returns an explicit Deny (401) so the gateway
 * never forwards the request to the integration.
 */

const verifier = new TokenVerifier({
  region: process.env.AWS_REGION ?? "us-east-1",
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_CLIENT_ID ?? "",
  supabaseProjectRef: process.env.SUPABASE_PROJECT_REF || undefined,
  membershipTableName: process.env.TENANT_MEMBERSHIP_TABLE_NAME || undefined,
  dynamo: new DynamoDBClient({}),
});

export async function handler(
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewaySimpleAuthorizerWithContextResult<Record<string, string>>> {
  const deny = (): APIGatewaySimpleAuthorizerWithContextResult<Record<string, string>> => ({
    isAuthorized: false,
    context: {},
  });

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader) return deny();

  try {
    const identity = await verifier.verify(authHeader);
    return {
      isAuthorized: true,
      context: {
        tenantId: identity.tenantId,
        email: identity.email ?? "",
        departments: identity.departments.join(","),
        userId: identity.userId,
      },
    };
  } catch (err) {
    console.error("Authorizer rejected token:", (err as Error).message);
    return deny();
  }
}
