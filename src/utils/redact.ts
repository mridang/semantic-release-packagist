/**
 * @file Hides credentials and secrets in text before it is logged or shown.
 */

/**
 * Hide credentials in a piece of text that is about to be logged or put in an
 * error message. This is a backstop that works on the shape of the text; the
 * primary defence is not to put secrets in text at all.
 *
 * Covered: `scheme://user:password@` (the password may contain `@` and `/`,
 * and the scheme may be any case), `scheme://token@`, `token=`,
 * `access_token=`, `password=` and `private_token=` query values,
 * `Authorization:` header lines, `Bearer` tokens, and bare GitHub and GitLab
 * tokens (`ghp_`, `github_pat_`, `glpat-`).
 * @param text - Text that may contain credentials.
 * @returns The text with every credential replaced by `***`.
 * @example
 * redactCredentials('https://user:secret@host/repo.git'); // 'https://***@host/repo.git'
 */
export function redactCredentials(text: string): string {
  return (
    text
      // eslint-disable-next-line sonarjs/super-linear-regex -- password may contain '@' and '/', so \S* is required
      .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:\S*@/gi, '$1***@')
      // eslint-disable-next-line sonarjs/super-linear-regex -- scheme-and-user match is anchored on '://' and bounded by '@'
      .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+@/gi, '$1***@')
      .replaceAll(
        /([?&](?:access_token|token|password|private_token)=)[^&\s#'"]+/gi,
        '$1***',
      )
      .replaceAll(/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: ***')
      .replaceAll(/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
      .replaceAll(
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[A-Za-z0-9_-]{16,})/g,
        '***',
      )
  );
}

/**
 * Replace secrets in text that is about to be shown to a person. A secret is
 * searched for in the forms it takes when a server or a tool echoes a URL
 * back: as it is, percent-encoded (`encodeURIComponent`), form-encoded
 * (`URLSearchParams`, where a space becomes `+`) and JSON-escaped with `/`
 * written as `\/` (as PHP's `json_encode` does). Any other re-encoding is not
 * recognised, so never put a secret in text that is shown if it can be left
 * out.
 * @param text - Text that came from the network or from a child process.
 * @param secrets - The secrets to remove. Empty ones are ignored.
 * @returns The text with every form of every secret replaced.
 * @example
 * redactSecrets('token is ghp_x y', ['ghp_x']); // 'token is [redacted] y'
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  const forms = secrets
    .filter((secret) => secret !== '')
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ s: secret }).toString().slice(2),
      JSON.stringify(secret)
        .slice(1, -1)
        .replaceAll('/', String.raw`\/`),
    ])
    .toSorted((a, b) => b.length - a.length);
  if (forms.length === 0) {
    return text;
  }
  // One pass, so that a secret cannot match inside the marker of another.
  const pattern = new RegExp(
    forms
      .map((form) => form.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
      .join('|'),
    'g',
  );
  return text.replace(pattern, '[redacted]');
}
