/**
 * @module lib/errors
 * Safe error message extraction for GUI components and toast notifications.
 */

/**
 * Safely extracts a human-readable message from an unknown error value.
 * Falls back to `fallback` if no meaningful message can be derived.
 */
export function toErrorMessage(error: unknown, fallback = 'An unexpected error occurred'): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (trimmed.length > 0) return trimmed;
    return fallback;
  }
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      const msg = (error as { message: string }).message.trim();
      if (msg.length > 0) return msg;
    }
    if ('error' in error && typeof (error as { error: unknown }).error === 'string') {
      const err = (error as { error: string }).error.trim();
      if (err.length > 0) return err;
    }
  }
  return fallback;
}
