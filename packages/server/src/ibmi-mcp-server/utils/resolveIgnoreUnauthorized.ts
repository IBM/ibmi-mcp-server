/**
 * Resolve Mapepire TLS `ignore-unauthorized` with secure-by-default precedence:
 * YAML literal → DB2i_IGNORE_UNAUTHORIZED → false.
 *
 * When true, Mapepire skips certificate-chain and hostname verification
 * (allow insecure TLS). This is not application authentication.
 */

/**
 * @param yamlValue - Explicit YAML `ignore-unauthorized` when the key is present
 * @param envRaw - Raw `DB2i_IGNORE_UNAUTHORIZED` env value (defaults to process.env)
 */
export function resolveIgnoreUnauthorized(
  yamlValue: boolean | undefined,
  envRaw: string | undefined = process.env.DB2i_IGNORE_UNAUTHORIZED,
): boolean {
  if (yamlValue !== undefined) {
    return yamlValue;
  }
  if (envRaw == null || envRaw.trim() === "") {
    return false;
  }
  return envRaw === "true" || envRaw === "1";
}
