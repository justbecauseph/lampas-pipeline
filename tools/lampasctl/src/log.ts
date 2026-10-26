let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Per-item progress output, printed only with --verbose. */
export function logVerbose(...args: unknown[]): void {
  if (verbose) console.log(...args);
}
