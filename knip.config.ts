/**
 * The Knip configuration: dependencies and binaries that are not to be
 * reported as unused.
 * @file
 */
export default {
  ignoreDependencies: [/^@semantic-release\//],
  ignoreBinaries: ['composer'],
};
