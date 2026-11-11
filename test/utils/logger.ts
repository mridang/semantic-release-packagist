/**
 * A semantic-release style logger that records everything written to it.
 * @returns The logger and the lines it has received.
 */
export function recordingLogger(): {
  logger: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  lines: string[];
} {
  const lines: string[] = [];
  const write = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  return { logger: { log: write, warn: write, error: write }, lines };
}
