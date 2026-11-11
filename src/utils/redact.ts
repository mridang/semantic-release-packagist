/**
 * @file Hides credentials and secrets in text before it is logged or shown.
 */

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
const NAME_END = /[\s/@:]/;
const SPACE = /\s/;

/**
 * Find where the URL scheme in front of a `://` starts: the first letter of
 * the run of scheme characters that ends at the `://`.
 * @param text - The text being searched.
 * @param at - Index of the `://`.
 * @param lowest - The scheme may not start before this index.
 * @returns The index where the scheme starts, or -1 when there is none.
 */
function schemeStart(text: string, at: number, lowest: number): number {
  let start = at;
  while (start > lowest && SCHEME_CHAR.test(text.charAt(start - 1))) {
    start--;
  }
  for (let index = start; index < at; index++) {
    if (LETTER.test(text.charAt(index))) {
      return index;
    }
  }
  return -1;
}

/**
 * Find the end of the user name that follows a `://`: the first character
 * that cannot be part of it.
 * @param text - The text being searched.
 * @param from - Index just after the `://`.
 * @returns The index of the first character that is not part of the name.
 */
function nameEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && !NAME_END.test(text.charAt(index))) {
    index++;
  }
  return index;
}

/**
 * Where a `user:password@` ends. The password may hold any non-space
 * character, so the match runs to the last `@` of the unbroken run of
 * non-space characters. The last `@` is remembered per run, so that many
 * candidates in one long run cost a single scan.
 * @param text - The text being searched.
 * @param from - Index just after the `://`.
 * @param run - Cache of the current run of non-space characters.
 * @param run.start - Where the cached run was first looked at.
 * @param run.end - Where the cached run ends.
 * @param run.at - Index of the last `@` before the end of the cached run.
 * @returns The index just after the `@`, or -1 when there is no match.
 */
function passwordEnd(
  text: string,
  from: number,
  run: { start: number; end: number; at: number },
): number {
  const colon = nameEnd(text, from);
  if (text.charAt(colon) !== ':') {
    return -1;
  }
  const password = colon + 1;
  if (password < run.start || password > run.end) {
    let end = password;
    while (end < text.length && !SPACE.test(text.charAt(end))) {
      end++;
    }
    run.start = password;
    run.end = end;
    run.at = text.lastIndexOf('@', end - 1);
  }
  return run.at >= password ? run.at + 1 : -1;
}

/**
 * Where a `token@` ends: a non-empty name straight after the `://`.
 * @param text - The text being searched.
 * @param from - Index just after the `://`.
 * @returns The index just after the `@`, or -1 when there is no match.
 */
function tokenEnd(text: string, from: number): number {
  const end = nameEnd(text, from);
  return end > from && text.charAt(end) === '@' ? end + 1 : -1;
}

/**
 * Where the user information after the `://` at `at` ends, if the scheme in
 * front of it and the user information form a match.
 * @param text - The text being searched.
 * @param at - Index of the `://`.
 * @param lowest - The scheme may not start before this index.
 * @param withPassword - Match `user:password@` when true, `token@` when false.
 * @param run - Cache of the current run of non-space characters.
 * @param run.start - Where the cached run was first looked at.
 * @param run.end - Where the cached run ends.
 * @param run.at - Index of the last `@` before the end of the cached run.
 * @returns The index just after the `@`, or -1 when there is no match.
 */
function matchEnd(
  text: string,
  at: number,
  lowest: number,
  withPassword: boolean,
  run: { start: number; end: number; at: number },
): number {
  if (schemeStart(text, at, lowest) === -1) {
    return -1;
  }
  return withPassword ? passwordEnd(text, at + 3, run) : tokenEnd(text, at + 3);
}

/**
 * Replace the user information of every URL with `***`, so that
 * `scheme://user:password@host` and `scheme://token@host` become
 * `scheme://***@host`. It is a single left to right pass, so its cost grows
 * in step with the length of the text.
 * @param text - Text that may contain URLs.
 * @param withPassword - Match `user:password@` when true, `token@` when false.
 * @returns The text with the user information replaced.
 */
function redactUserinfo(text: string, withPassword: boolean): string {
  const run = { start: 0, end: -1, at: -1 };
  let out = '';
  let copied = 0;
  let search = 0;
  for (
    let at = text.indexOf('://');
    at !== -1;
    at = text.indexOf('://', search)
  ) {
    search = at + 1;
    const end = matchEnd(text, at, copied, withPassword, run);
    if (end !== -1) {
      out += `${text.slice(copied, at + 3)}***@`;
      copied = end;
      search = end;
    }
  }
  return out + text.slice(copied);
}

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
  return redactUserinfo(redactUserinfo(text, true), false)
    .replaceAll(
      /([?&](?:access_token|token|password|private_token)=)[^&\s#'"]+/gi,
      '$1***',
    )
    .replaceAll(/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: ***')
    .replaceAll(/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replaceAll(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[A-Za-z0-9_-]{16,})/g,
      '***',
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
