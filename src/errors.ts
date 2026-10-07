/**
 * @fileoverview Helpers for turning caught `unknown` values into usable data.
 */

/**
 * Returns the message of an `Error`, or the string form of any other value.
 *
 * Everything thrown by this project, by `fetch` and by `jose` is an `Error`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Returns the `code` of a Node system error such as `ENOTFOUND`, or
 * `undefined` when the value carries no code.
 */
export function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const {code} = error;
  return typeof code === 'string' ? code : undefined;
}
