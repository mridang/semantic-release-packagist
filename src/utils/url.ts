/**
 * Remove the user name and password from a URL, so that a token embedded in a
 * repository URL such as `https://user:token@host/repo.git` is not logged. A
 * value that is not an absolute URL, such as an scp-style `git@host:repo`, or
 * that has no credentials is returned unchanged.
 *
 * @param url A URL that is about to be logged or put in an error.
 * @returns The URL without credentials.
 */
export function redactUrl(url: string): string {
  if (!URL.canParse(url)) {
    return url;
  }
  const parsed = new URL(url);
  if (!parsed.username && !parsed.password) {
    return url;
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}
