/**
 * Finds and removes the secrets held in the user info of a URL.
 * @file
 */

/**
 * The secrets in the user info of a URL: the password, and the user name of an
 * `http(s)` URL, where `https://token@host/repo.git` is a common form. The
 * user name of any other URL, such as the `git` of `ssh://git@host/repo.git`,
 * is not secret.
 * @param url - A URL, which may not be an absolute one.
 * @returns The secrets, which are empty when there is no user info.
 * @example
 * userInfoSecrets('https://token@host/repo.git'); // ['token']
 */
export function userInfoSecrets(url: string): readonly string[] {
  if (!URL.canParse(url)) {
    return [];
  }
  const { protocol, username, password } = new URL(url);
  const web = protocol === 'http:' || protocol === 'https:';
  return [password, web ? username : ''].filter((secret) => secret !== '');
}

/**
 * Remove the secrets from the user info of a URL, so that a token embedded in
 * a repository URL such as `https://user:token@host/repo.git` is not logged.
 * A value that is not an absolute URL, such as an scp-style `git@host:repo`,
 * or that has no secret in it is returned unchanged.
 * @param url - A URL that is about to be logged or put in an error.
 * @returns The URL without secrets.
 * @example
 * redactUrl('https://user:token@host/repo.git'); // 'https://host/repo.git'
 */
export function redactUrl(url: string): string {
  if (userInfoSecrets(url).length === 0) {
    return url;
  }
  const parsed = new URL(url);
  parsed.password = '';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    parsed.username = '';
  }
  return parsed.toString();
}
