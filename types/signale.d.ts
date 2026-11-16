/**
 * The logger semantic-release hands to plugins. Its own typings import
 * `signale`, which ships none, so the logging members are declared here once.
 */
declare module 'signale' {
  type LogFunction = (...messages: readonly unknown[]) => void;

  export type Signale<Types extends string = never> = Record<
    Types | 'log' | 'warn' | 'error',
    LogFunction
  >;
}
