// Pure: the standard library only, so the runner and the request builder share it without an edge
// between src/exec/ and src/permission/.

/** POSIX single-quote-escape one token (mirrors the stdio-MCP shellQuote). */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Joins the resolved command + args into ONE POSIX-shell-quoted string for sandbox.wrapArgv —
 * ASRT wraps it as [shell, '-c', <wrapped>], so a naive space-join would be a shell-injection
 * surface; every token is single-quote-escaped first.
 */
export function quoteCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}
