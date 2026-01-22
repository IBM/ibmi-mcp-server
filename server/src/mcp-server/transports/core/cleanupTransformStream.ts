/**
 * Creates a TransformStream wrapper that triggers cleanup when the stream completes.
 *
 * This utility wraps a ReadableStream with a transparent TransformStream that:
 * - Passes through all chunks unchanged (identity transform)
 * - Hooks into stream lifecycle events (flush, cancel, error)
 * - Triggers cleanup automatically when the stream completes
 * - Ensures cleanup happens exactly once
 *
 * @param originalStream - The ReadableStream to wrap
 * @param onCleanup - Async function to call when the stream completes
 * @returns A new ReadableStream that triggers cleanup on completion
 *
 * @example
 * ```typescript
 * const wrappedStream = createCleanupTransformStream(
 *   responseStream,
 *   async () => {
 *     await server.close();
 *     await transport.close();
 *   }
 * );
 * ```
 */
export function createCleanupTransformStream(
  originalStream: ReadableStream,
  onCleanup: () => Promise<void>,
): ReadableStream {
  // Track cleanup state to ensure idempotency
  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await onCleanup();
  };

  // Create transform stream with lifecycle hooks
  const { readable, writable } = new TransformStream({
    /**
     * Identity transform - passes chunks through unchanged
     */
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },

    /**
     * Called when stream closes normally (all data consumed)
     */
    async flush() {
      await cleanup();
    },

    /**
     * Called when stream is cancelled/aborted by the consumer
     */
    async cancel() {
      await cleanup();
    },
  });

  // Pipe original stream through transform
  // If piping fails (error in original stream), trigger cleanup
  originalStream.pipeTo(writable).catch(() => cleanup());

  return readable;
}
