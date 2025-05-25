# Semantic Release - Packagist

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin to automatically trigger a package update on [Packagist](https://packagist.org/).

This plugin automates the final step of a PHP package release workflow. It updates the `version` in your `composer.json` file, and after `semantic-release` publishes a new Git tag, it notifies Packagist to sync the new version from your repository. This eliminates the need for manual updates or webhooks, ensuring your Packagist package is always up-to-date with your latest release.

### Why?

Automating the release of a PHP package involves more than just creating a Git tag. For a new version to be accessible to the PHP community via Composer, it must be updated on Packagist. This final synchronization step is a common point of friction in an otherwise automated pipeline.

Without this plugin, developers typically face one of two issues:

- **Dependency on a GitHub App:** The most common method for automation is installing the official Packagist GitHub App. However, this requires administrative permissions on the repository or organization. Some security policies or development workflows may not permit installing external applications, or you may simply prefer a more lightweight integration.
- **Incomplete Automation:** Other existing `semantic-release` plugins for Composer may correctly update the `version` in your `composer.json` file, but they often stop there. They do not handle the final, crucial step of notifying Packagist that a new version is ready. This leaves a manual gap in the release process, forcing you to log in to Packagist and click "Update" or configure separate webhooks.
- **Missing Metadata Validation:** Many tools may update your `composer.json` but might skip the essential step of validating its contents (e.g., via `composer validate`). This can lead to attempting to publish a new version that Packagist later rejects due to metadata errors, interrupting the release flow and requiring manual intervention.

This plugin provides a lightweight and direct solution by using the Packagist API. Instead of relying on a GitHub App, it authenticates with a simple `username` and `apiToken` that you provide. It bridges the gap in the release process by ensuring that after `semantic-release` successfully creates a new release, your Packagist package is immediately synchronized. This creates a seamless, end-to-end automated pipeline directly within your `semantic-release` configuration, without requiring extra permissions or external app installations.

## Installation

Install using NPM by using the following command:

```sh
npm install --save-dev @mridang/semantic-release-packagist
```

## Usage

To use this plugin, add it to your semantic-release configuration file (e.g., `.releaserc.js`, `release.config.js`, or in your `package.json`).

The plugin's `prepare` step modifies your `composer.json` and the `composer.lock` file.
For this change to be included in the release commit, the plugin should be
placed **before** `@semantic-release/git` and `@semantic-release/github` in
the `plugins` array.

> [!IMPORTANT]
> This plugin updates the `version` field in your `composer.json` file during the
> `prepare` step. For this change to be included in your release commit,
> you **must** configure the `@semantic-release/git` plugin to add
> `composer.json` and the `composer.locj` to its `assets` array.

**Example Configuration (`.releaserc.js`):**

```javascript
module.exports = {
  branches: ['main', 'next'],
  plugins: [
    '@semantic-release/commit-analyzer', // Must come first to determine release type
    // The prepare step of the packagist plugin runs here to update composer.json
    [
      '@mridang/semantic-release-packagist',
      {
        username: process.env.PACKAGIST_USERNAME,
        apiToken: process.env.PACKAGIST_TOKEN, // Use an environment variable for security
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/github', // For creating GitHub releases and comments
    [
      '@semantic-release/git', // To commit package.json, CHANGELOG.md, etc.
      {
        assets: ['composer.json', 'CHANGELOG.md'],
        message:
          'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
};
```

## Known Issues

- None.

## Useful links

- **[Semantic Release](https://github.com/semantic-release/semantic-release):**
  The core automated version management and package publishing tool.

## Contributing

If you have suggestions for how this app could be improved, or
want to report a bug, open an issue - we'd love all and any
contributions.

## License

Apache License 2.0 © 2024 Mridang Agarwalla
