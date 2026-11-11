import { EventEmitter } from 'node:events';
import { FROZEN_SIZE } from '../golden/determinism.js';

// ink-testing-library-shaped fake streams, fed through mountInk's io seam so a test drives the real
// mounted tree and reads what it wrote. They mirror renderer-ink's own test streams, which no other
// package can import.

/** A stdin whose write() emits 'readable' and 'data', which drives ink's useInput; it claims a TTY. */
export class FakeStdin extends EventEmitter {
  isTTY = true as const;
  private data: string | null = null;
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    const d = this.data;
    this.data = null;
    return d;
  }
  write(data: string): boolean {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
    return true;
  }
}

/** A 100-column stdout with no rows that records every write. */
export class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  readonly columns = FROZEN_SIZE.columns;
  write = (chunk: string): boolean => {
    this.frames.push(chunk);
    return true;
  };
}

// The one place a fake is typed as the Node stream ink's options name. The fakes implement what ink reads
// from a stream; they are not complete Node streams.
export const asReadStream = (stdin: FakeStdin): NodeJS.ReadStream =>
  // eslint-disable-next-line no-restricted-syntax -- ink names the full Node stream type
  stdin as unknown as NodeJS.ReadStream;
export const asWriteStream = (stdout: FakeStdout): NodeJS.WriteStream =>
  // eslint-disable-next-line no-restricted-syntax -- ink names the full Node stream type
  stdout as unknown as NodeJS.WriteStream;
