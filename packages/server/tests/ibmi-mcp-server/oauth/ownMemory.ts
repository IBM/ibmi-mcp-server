/**
 * @fileoverview Where the bytes of a Buffer are, for the tests of the
 * built-in OAuth sign-on: a secret must be in memory that zero-filling the
 * Buffer wipes for good.
 */

/**
 * Whether a Buffer's bytes are in memory of their own outside the V8 heap.
 *
 * Two places are not that:
 * - Node's shared Buffer pool, which `Buffer.from(string)` and
 *   `Buffer.allocUnsafe` hand slices of.
 * - The V8 heap, where V8 keeps the bytes of a typed array of up to 64
 *   bytes, `Buffer.allocUnsafeSlow(24)` included. The garbage collector
 *   moves them, and a native call copies them out, without wiping what it
 *   leaves. Asking such a Buffer for its `.buffer` makes V8 allocate a copy
 *   outside the heap, which is how it is recognised here: the process's
 *   count of ArrayBuffer bytes grows. (A garbage collection in between can
 *   only lower that count.)
 */
export function hasOwnMemory(buffer: Buffer): boolean {
  const before = process.memoryUsage().arrayBuffers;
  const { byteLength } = buffer.buffer;
  return (
    process.memoryUsage().arrayBuffers <= before &&
    byteLength !== Buffer.poolSize
  );
}
