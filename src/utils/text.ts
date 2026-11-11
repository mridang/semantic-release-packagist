/**
 * Helpers for shortening text before it is put into a message.
 * @file
 */

/**
 * Shorten foreign text (a response body, a command's output) before it goes
 * into an error message.
 * @param text - Text of any length.
 * @param max - The most characters to keep.
 * @returns The text, or its first `max` characters followed by a marker.
 * @example
 * truncate('abcdef', 3); // 'abc... (truncated)'
 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... (truncated)` : text;
}
