import { EventEmitter } from 'node:events';

// ink-testing-library-shaped fake streams, fed through mountInk's io seam so a test drives the REAL
// mounted tree (real focus ring, real gated handlers) and reads what it wrote.

// A stdin whose write() emits 'readable' and 'data', which drives ink's useInput. It claims to be a
// TTY so ink accepts raw mode.
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

export interface FakeStdoutOptions {
  readonly columns?: number;
  // omitted: the stream reports no rows, like a pipe and like ink-testing-library's stream
  readonly rows?: number;
  // true: the stream claims to be a TTY, so the host brackets writes and clears the screen on open
  readonly tty?: boolean;
}

// A stdout that records every write. `columns` and `rows` can be changed and a `resize` emitted, as
// a terminal does.
export class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  columns: number;
  rows: number | undefined;
  isTTY: boolean;

  constructor(options: FakeStdoutOptions = {}) {
    super();
    this.columns = options.columns ?? 100;
    this.rows = options.rows;
    this.isTTY = options.tty === true;
  }

  write = (chunk: string): boolean => {
    this.frames.push(chunk);
    return true;
  };

  resize(columns: number, rows: number | undefined): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

// The one place a fake is typed as the Node stream ink's options name. The fakes implement what ink
// reads from a stream; they are not complete Node streams.
export const asReadStream = (stdin: FakeStdin): NodeJS.ReadStream =>
  stdin as unknown as NodeJS.ReadStream;
export const asWriteStream = (stdout: FakeStdout): NodeJS.WriteStream =>
  stdout as unknown as NodeJS.WriteStream;
