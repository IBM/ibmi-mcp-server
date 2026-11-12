/**
 * @fileoverview The one place a tool's SQL leaves from. Every built-in tool
 * and the YAML tool factory call `executeQuery` or
 * `executeQueryWithPagination` here, never a connection pool.
 *
 * - Built-in OAuth mode (`config.oauth.builtin`): the statement runs on the
 *   connection of the caller's own IBM i sign-on, named by the grant in the
 *   auth context. Without one it throws. No pool is looked up, so none is
 *   ever constructed.
 * - Every other mode: a statement without a `source` runs on the `DB2i_*`
 *   service pool; one with a `source` runs on the caller's authenticated pool
 *   when the auth context carries an IBM i token, else on that source's pool.
 *
 * @module src/ibmi-mcp-server/services/queryRouter
 */

import type { BindingValue, QueryResult } from "@ibm/mapepire-js";
import { config } from "@/config/index.js";
// Not the auth barrel: that also loads every authentication strategy.
import { authContext } from "@/mcp-server/transports/auth/lib/authContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import {
  requestContextService,
  type RequestContext,
} from "@/utils/internal/requestContext.js";
import type {
  GrantId,
  GrantQueryExecutor,
  PaginatedQueryResult,
  QueryRouteOptions,
} from "../oauth/contracts.js";
import { SqlSecurityValidator } from "../utils/security/sqlSecurityValidator.js";
import { AuthenticatedPoolManager } from "./authenticatedPoolManager.js";
import { IBMiConnectionPool } from "./connectionPool.js";
import { SourceManager } from "./sourceManager.js";

/** `QueryRouteOptions`, and where the pools of the YAML sources are. */
export interface PoolRouteOptions extends QueryRouteOptions {
  /**
   * The pools `source` names: the YAML tool factory passes the manager it
   * was initialized with. Default: the `SourceManager` singleton.
   */
  sourceManager?: SourceManager;
}

/** The grant manager, in built-in OAuth mode once the transport has started. */
let grantExecutor: GrantQueryExecutor | undefined;

/** Registers the grant manager at startup; `undefined` removes it. */
export function setGrantQueryExecutor(
  executor: GrantQueryExecutor | undefined,
): void {
  grantExecutor = executor;
}

/**
 * Built-in OAuth mode: the caller's grant and what runs statements on it.
 *
 * @throws {McpError} `Unauthorized` when the request carries no grant or no
 *   grant manager is registered. There is nothing to fall back to.
 */
function callerGrant(): { executor: GrantQueryExecutor; grantId: GrantId } {
  const grantId = authContext.getStore()?.authInfo.extra?.grantId;
  if (!grantExecutor || typeof grantId !== "string" || grantId === "") {
    throw new McpError(
      JsonRpcErrorCode.Unauthorized,
      "This request has no IBM i sign-on. Sign on and retry.",
    );
  }
  return { executor: grantExecutor, grantId };
}

/**
 * The arguments up to the last one that is set, so that a pool is called
 * with the same argument list its callers passed before this module existed.
 */
function given<T extends unknown[]>(...args: T): T {
  while (args.length > 0 && args[args.length - 1] === undefined) {
    args.pop();
  }
  return args;
}

/**
 * Checks a statement against a tool's security settings before it is routed
 * anywhere: nothing is connected to, and no grant is looked up, for a
 * statement that is refused.
 */
function validate(
  query: string,
  { securityConfig }: QueryRouteOptions,
  context: RequestContext | undefined,
): void {
  if (securityConfig) {
    SqlSecurityValidator.validateQuery(
      query,
      securityConfig,
      context ??
        requestContextService.createRequestContext({
          operation: "ValidateRoutedQuery",
        }),
    );
  }
}

/**
 * Runs a statement and returns its one page of rows.
 *
 * @throws {McpError} `Unauthorized` in built-in OAuth mode when the caller
 *   has no grant or its connection is closed; `ValidationError` when
 *   `securityConfig` refuses the statement; otherwise what the connection
 *   reports.
 */
export async function executeQuery<T = unknown>(
  query: string,
  params?: BindingValue[],
  context?: RequestContext,
  options: PoolRouteOptions = {},
): Promise<QueryResult<T>> {
  const { source, securityConfig, rowsToFetch } = options;
  validate(query, options, context);

  if (config.oauth.builtin) {
    const { executor, grantId } = callerGrant();
    return executor.executeQuery<T>(
      grantId,
      query,
      params,
      context,
      rowsToFetch,
    );
  }
  if (source === undefined) {
    return IBMiConnectionPool.executeQuery(
      query,
      params,
      context,
      ...given(rowsToFetch),
    ) as Promise<QueryResult<T>>;
  }
  const ibmiToken = authContext.getStore()?.authInfo.ibmiToken;
  if (ibmiToken) {
    return AuthenticatedPoolManager.getInstance().executeQuery<T>(
      ibmiToken,
      query,
      params,
      context,
      securityConfig,
      rowsToFetch,
    );
  }
  return (options.sourceManager ?? SourceManager.getInstance()).executeQuery<T>(
    source,
    query,
    params,
    context,
    ...given(securityConfig, rowsToFetch),
  );
}

/**
 * Runs a statement and fetches until it is done or
 * `IBMI_PAGINATION_MAX_ROWS` rows are in hand. `rowsToFetch` is the size of
 * each fetch.
 *
 * @throws {McpError} As `executeQuery`.
 */
export async function executeQueryWithPagination(
  query: string,
  params?: BindingValue[],
  context?: RequestContext,
  options: PoolRouteOptions = {},
): Promise<PaginatedQueryResult> {
  const { source, securityConfig, rowsToFetch } = options;
  validate(query, options, context);

  if (config.oauth.builtin) {
    const { executor, grantId } = callerGrant();
    return executor.executeQueryWithPagination(
      grantId,
      query,
      params,
      context,
      rowsToFetch,
    );
  }
  if (source === undefined) {
    return IBMiConnectionPool.executeQueryWithPagination(
      query,
      params,
      context,
      ...given(rowsToFetch),
    );
  }
  const ibmiToken = authContext.getStore()?.authInfo.ibmiToken;
  if (ibmiToken) {
    return AuthenticatedPoolManager.getInstance().executeQueryWithPagination(
      ibmiToken,
      query,
      params,
      context,
      rowsToFetch,
      securityConfig,
    );
  }
  return (
    options.sourceManager ?? SourceManager.getInstance()
  ).executeQueryWithPagination(
    source,
    query,
    params,
    context,
    rowsToFetch,
    securityConfig,
  );
}
