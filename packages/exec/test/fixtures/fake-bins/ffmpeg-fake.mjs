#!/usr/bin/env node
/* global process */
// Fake ffmpeg/ffprobe: prints canned -encoders/-codecs/-filters output for the prober test.
const arg = process.argv[2] ?? '';
if (arg === '-encoders') {
  process.stdout.write('Encoders:\n V..... libx264 H.264\n A..... aac AAC\n');
} else if (arg === '-codecs') {
  process.stdout.write('Codecs:\n DEV.LS h264 H.264\n DEA.L. aac AAC\n');
} else if (arg === '-filters') {
  process.stdout.write(
    'Filters:\n  concat            Concatenate streams.\n  scale             Scale.\n',
  );
} else if (arg === '-version') {
  process.stdout.write('ffprobe version 6.0\n');
}
process.exit(0);
