/**
 * @module utils/errors
 * Safe error extraction and error code introspection utilities.
 */

/** Reads a Node errno code off an unknown thrown value. */
export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined && code !== null ? String(code) : undefined;
  }
  return undefined;
}

/**
 * Safely extracts a human-readable message from an unknown error value.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'Error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && error.message !== undefined && error.message !== null) {
      const msg = String((error as { message: unknown }).message);
      if (msg.trim().length > 0) return msg;
    }
    if ('error' in error && error.error !== undefined && error.error !== null) {
      if (typeof error.error === 'string' && error.error.trim().length > 0) {
        return error.error;
      }
      if (error.error instanceof Error) {
        return error.error.message || error.error.name;
      }
    }
    const str = String(error);
    if (str !== '[object Object]') {
      return str;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') {
        return json;
      }
    } catch {
      // Ignore circular reference errors during JSON.stringify
    }
    return str;
  }
  return String(error);
}
