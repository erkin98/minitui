/** The result of probing a file path on disk. */
export interface FileStat {
  readonly exists: boolean;
  readonly readable: boolean;
  readonly isFile: boolean;
}

/**
 * The LIVE capability seam. Implemented by `@minitui/exec` (cached probe of
 * `ffmpeg -encoders/-codecs/-filters` + fs stat) and injected by the composition
 * root. `@minitui/spec` NEVER imports exec — semantic validation reads the world
 * only through this port. The triad mirrors exec's impl exactly, so
 * `createCapabilityProvider()`'s return is structurally assignable here.
 */
export interface CapabilityProvider {
  /** Encoders the local ffmpeg actually supports (cached probe of `-encoders`). */
  listEncoders(): Promise<readonly string[]>;
  /** Codecs the local ffmpeg supports (`-codecs`). */
  listCodecs(): Promise<readonly string[]>;
  /** Filters the local ffmpeg supports (`-filters`). */
  listFilters(): Promise<readonly string[]>;
  /** Resolve a real path to existence + readability (TOCTOU-aware: re-checked at use elsewhere). */
  statFile(path: string): Promise<FileStat>;
}
