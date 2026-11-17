/**
 * Helpers for shortening text before it is put into a message.
 * @file
 */

/** Cuts text at grapheme boundaries, built once. */
const segmenter = new Intl.Segmenter();

/**
 * Shorten foreign text (a response body, a command's output) before it goes
 * into an error message.
 * @param text - Text of any length.
 * @param max - The most characters (graphemes) to keep.
 * @returns The text, or its first `max` characters followed by a marker.
 * @example
 * truncate('abcdef', 3); // 'abc... (truncated)'
 */
export function truncate(text: string, max: number): string {
  const graphemes = Array.from(
    segmenter.segment(text),
    ({ segment }) => segment,
  );
  return graphemes.length > max
    ? `${graphemes.slice(0, max).join('')}... (truncated)`
    : text;
}
