import { TokenVerifier, type TokenVerifierConfig, type VerifiedIdentity } from "../common/token-verifier";

/**
 * JWT authentication for the chat-handler's Lambda Function URL
 * (spec Section 4.4). Function URLs have no built-in JWT authorizer, so
 * validation lives in application code — the Function URL auth type is
 * AWS_NONE and the Authorization header is checked here.
 *
 * This module is a thin wrapper over the shared `TokenVerifier` (dual-issuer:
 * Cognito RS256 + Supabase/Lovable Cloud ES256). The same verifier backs the
 * API Gateway Lambda authorizer, so there is exactly one validation
 * implementation across the whole stack.
 */

export type AuthResult = VerifiedIdentity;

let verifier: TokenVerifier | null = null;

export function init(opts: TokenVerifierConfig): void {
  verifier = new TokenVerifier(opts);
}

export async function authenticate(authHeader: string | undefined): Promise<AuthResult> {
  if (!verifier) {
    throw Object.assign(new Error("JWT verifier not initialized"), { statusCode: 500 });
  }
  return verifier.verify(authHeader);
}

// Re-export the config type for callers that import it from here.
export type { TokenVerifierConfig };
