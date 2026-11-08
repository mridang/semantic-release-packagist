/**
 * Replace secrets in text that is about to be shown to a person. A secret is
 * searched for in the forms it takes when a server or a tool echoes a URL
 * back: as it is, percent-encoded (`encodeURIComponent`), form-encoded
 * (`URLSearchParams`, where a space becomes `+`) and JSON-escaped with `/`
 * written as `\/` (as PHP's `json_encode` does). Any other re-encoding is not
 * recognised, so never put a secret in text that is shown if it can be left
 * out.
 *
 * @param text Text that came from the network or from a child process.
 * @param secrets The secrets to remove. Empty ones are ignored.
 * @returns The text with every form of every secret replaced.
 */
export function redactCredentials(
  text: string,
  secrets: readonly string[],
): string {
  const forms = secrets
    .filter((secret) => secret !== '')
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ s: secret }).toString().slice(2),
      JSON.stringify(secret).slice(1, -1).replaceAll('/', '\\/'),
    ])
    .toSorted((a, b) => b.length - a.length);
  if (forms.length === 0) {
    return text;
  }
  // One pass, so that a secret cannot match inside the marker of another.
  const pattern = new RegExp(
    forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  return text.replace(pattern, '[redacted]');
}
