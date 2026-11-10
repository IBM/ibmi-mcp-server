/**
 * @fileoverview Shared types for IBM i HTTP authentication flow.
 * @deprecated IBM i HTTP token authentication will be removed in a future
 * major release. Use `MCP_AUTH_MODE=oauth`.
 */

export interface AuthRequest {
  host: string;
  duration?: number;
  poolstart?: number;
  poolmax?: number;
}

export interface AuthResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  expires_at: string;
}

export interface AuthCredentials {
  username: string;
  password: string;
}

export interface EncryptedAuthEnvelope {
  keyId: string;
  encryptedSessionKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface DecryptedAuthPayload {
  credentials: AuthCredentials;
  request: unknown;
}
