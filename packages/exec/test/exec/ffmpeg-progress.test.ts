import { describe, it, expect } from 'vitest';
import { parseFfmpegProgress, makeFfmpegProgressParser } from '../../src/exec/progress.js';

describe('parseFfmpegProgress', () => {
  it('parses a stats line into time-based progress against a known duration', () => {
    const line =
      'frame=  120 fps= 30 q=28.0 size=    512kB time=00:00:05.00 bitrate= 838.9kbits/s speed=1.0x';
    const out = parseFfmpegProgress(line, 10);
    expect(out).not.toBeNull();
    expect(out!.progress).toBeCloseTo(0.5, 2);
    expect(out!.message).toMatch(/00:00:05/);
  });

  it('caps progress at 0.99 when total duration is unknown', () => {
    const line =
      'frame=  600 fps= 30 q=28.0 size=  2048kB time=00:01:00.00 bitrate= 279.6kbits/s speed=1.0x';
    const out = parseFfmpegProgress(line);
    expect(out).not.toBeNull();
    expect(out!.progress).toBeLessThanOrEqual(0.99);
    expect(out!.progress).toBeGreaterThan(0);
  });

  it('returns null for a non-progress line', () => {
    expect(parseFfmpegProgress('Input #0, mov,mp4,m4a, from "a.mp4":')).toBeNull();
    expect(parseFfmpegProgress('')).toBeNull();
  });

  it('makeFfmpegProgressParser closes over the duration', () => {
    const parse = makeFfmpegProgressParser(10);
    const out = parse('frame=1 time=00:00:05.00 speed=1.0x');
    expect(out!.progress).toBeCloseTo(0.5, 2);
  });
});
