/** Matches ffmpeg's `time=HH:MM:SS.cc` stats token. */
const TIME_RE = /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/;

/** Unknown-duration heuristic: 60s of elapsed time maps to ~0.99, asymptotically. */
const UNKNOWN_HALF_LIFE_SECONDS = 30;

function parseTimeSeconds(line: string): number | null {
  const m = TIME_RE.exec(line);
  if (!m) return null;
  const [, hh, mm, ss, cc] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(cc) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Parses one ffmpeg stats line into a progress event, or null if the line carries no `time=`.
 * With totalSeconds, progress = elapsed/total clamped [0,1). Without it, progress is a monotone
 * asymptotic fraction of elapsed time, capped at 0.99 (the exit event sets the real 1.0).
 */
export function parseFfmpegProgress(
  line: string,
  totalSeconds?: number,
): { progress: number; message: string } | null {
  const elapsed = parseTimeSeconds(line);
  if (elapsed === null) return null;
  const message = line.trim();
  if (totalSeconds && totalSeconds > 0) {
    return { progress: clamp(elapsed / totalSeconds, 0, 0.999), message };
  }
  const progress = 1 - Math.exp(-elapsed / UNKNOWN_HALF_LIFE_SECONDS);
  return { progress: clamp(progress, 0, 0.99), message };
}

/** Returns a parser closed over totalSeconds, matching the RunSpec.progressParser shape. */
export function makeFfmpegProgressParser(
  totalSeconds?: number,
): (line: string) => { progress: number; message: string } | null {
  return (line) => parseFfmpegProgress(line, totalSeconds);
}
