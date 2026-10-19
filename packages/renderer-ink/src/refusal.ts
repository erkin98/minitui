import type { RendererRefusalCode } from '@minitui/renderer-core';

// A refusal before any render: an Error whose own `code` is a member of RendererRefusalCode, so the
// host can tell a builder error from a spec to repair. The message is fixed text plus, at most,
// sanitised names; it is never built from raw spec text. Internal: the barrel does not export it.
export class RendererRefusal extends Error {
  readonly code: RendererRefusalCode;

  constructor(code: RendererRefusalCode, message: string) {
    super(message);
    this.name = 'RendererRefusal';
    this.code = code;
  }
}
