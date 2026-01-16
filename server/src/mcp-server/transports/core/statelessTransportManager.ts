/**
 * @fileoverview Implements a stateless transport manager for the MCP SDK.
 *
 * This manager handles single, ephemeral MCP operations. For each incoming request,
 * it dynamically creates a temporary McpServer and transport instance, processes the
 * request, and then immediately schedules the resources for cleanup. This approach
 * is ideal for simple, one-off tool calls that do not require persistent session state.
 *
 * The key challenge addressed here is bridging the Node.js-centric MCP SDK with
 * modern, Web Standards-based frameworks like Hono. This is achieved by deferring
 * resource cleanup until the response stream has been fully consumed by the web
 * framework, preventing premature closure and truncated responses.
 *
 * @module src/mcp-server/transports/core/statelessTransportManager
 */

import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "@/utils/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BaseTransportManager } from "./baseTransportManager.js";
import { McpTransportRequest } from "./transportRequest.js";
import { HttpStatusCode, TransportResponse } from "./transportTypes.js";

/**
 * Manages ephemeral, single-request MCP operations.
 */
export class StatelessTransportManager extends BaseTransportManager {
  /**
   * Handles a single, stateless MCP request.
   *
   * This method orchestrates the creation of temporary server and transport instances,
   * handles the request, and ensures resources are cleaned up only after the
   * response stream is closed.
   *
   * @param webRequest - The Web Standard Request object.
   * @param body - The parsed body of the request.
   * @param context - The request context for logging and tracing.
   * @returns A promise resolving to a streaming TransportResponse.
   */
  async handleRequest({
    webRequest,
    body,
    context,
  }: McpTransportRequest): Promise<TransportResponse> {
    const opContext = {
      ...context,
      operation: "StatelessTransportManager.handleRequest",
    };
    logger.debug(
      opContext,
      "Creating ephemeral server instance for stateless request.",
    );

    let server: McpServer | undefined;
    let transport: WebStandardStreamableHTTPServerTransport | undefined;

    try {
      // 1. Create ephemeral instances for this request.
      server = await this.createServerInstanceFn();
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        onsessioninitialized: undefined,
      });

      await server.connect(transport);
      logger.debug(opContext, "Ephemeral server connected to transport.");

      // 2. Handle request using Web Standards API
      const webResponse = await transport.handleRequest(webRequest, {
        parsedBody: body,
      });

      logger.info(opContext, "Stateless request handled successfully.");

      // 3. Handle response based on whether it has a body
      if (!webResponse.body) {
        // No body - return buffered response and cleanup immediately
        this.cleanup(server, transport, opContext);
        return {
          type: "buffered",
          headers: webResponse.headers,
          statusCode: webResponse.status as HttpStatusCode,
          body: null,
        };
      }

      // 4. Extract stream and schedule cleanup on stream completion
      const stream = webResponse.body;
      this.setupDeferredCleanup(stream, server, transport, opContext);

      // 5. Return streaming response
      return {
        type: "stream",
        headers: webResponse.headers,
        statusCode: webResponse.status as HttpStatusCode,
        stream: stream as ReadableStream<Uint8Array>,
      };
    } catch (error) {
      // If an error occurs before the stream is returned, we must clean up immediately.
      if (server || transport) {
        this.cleanup(server, transport, opContext);
      }
      throw ErrorHandler.handleError(error, {
        operation: "StatelessTransportManager.handleRequest",
        context: opContext,
        rethrow: true,
      });
    }
  }

  /**
   * Attaches listeners to the response stream to trigger resource cleanup
   * only after the stream has been fully consumed or has errored.
   *
   * @param stream - The Web ReadableStream response body.
   * @param server - The ephemeral McpServer instance.
   * @param transport - The ephemeral transport instance.
   * @param context - The request context for logging.
   */
  private setupDeferredCleanup(
    stream: ReadableStream,
    server: McpServer,
    transport: WebStandardStreamableHTTPServerTransport,
    context: RequestContext,
  ): void {
    let cleanedUp = false;

    const cleanupFn = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.cleanup(server, transport, context);
    };

    // Read stream to completion then cleanup
    const reader = stream.getReader();
    (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch (error) {
        logger.warning(
          { ...context, error },
          "Stream reading error, proceeding to cleanup.",
        );
      } finally {
        await cleanupFn();
      }
    })();
  }

  /**
   * Performs the actual cleanup of ephemeral resources.
   * This method is designed to be "fire-and-forget".
   */
  private cleanup(
    server: McpServer | undefined,
    transport: WebStandardStreamableHTTPServerTransport | undefined,
    context: RequestContext,
  ): void {
    const opContext = {
      ...context,
      operation: "StatelessTransportManager.cleanup",
    };
    logger.debug(opContext, "Scheduling cleanup for ephemeral resources.");

    Promise.all([transport?.close(), server?.close()])
      .then(() => {
        logger.debug(opContext, "Ephemeral resources cleaned up successfully.");
      })
      .catch((cleanupError) => {
        logger.warning(
          {
            ...opContext,
            error: cleanupError as Error,
          },
          "Error during stateless resource cleanup.",
        );
      });
  }

  /**
   * Shuts down the manager. For the stateless manager, this is a no-op
   * as there are no persistent resources to manage.
   */
  async shutdown(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: "StatelessTransportManager.shutdown",
    });
    logger.info(
      context,
      "Stateless transport manager shutdown - no persistent resources to clean up.",
    );
    return Promise.resolve();
  }
}
