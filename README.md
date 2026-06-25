# minitui

A terminal-first agent that builds small, single-purpose apps on demand — and runs them safely.

You describe what you want ("merge these two videos", "rename every file by its EXIF date"). minitui doesn't dump a wall of shell at you and doesn't run arbitrary generated code. Instead it assembles a small interactive form from a fixed, trusted catalog of components, renders it right in your terminal, and executes the underlying commands only after they pass a host-parsed permission gate and an OS sandbox.

## How it works

1. **Route** — your intent is classified: a quick chat answer, a one-shot command, or a generated mini-app.
2. **Generate** — for an app, the model emits a *declarative spec*, not code. Every element and action in that spec must already exist in a frozen catalog allowlist — there is no path to arbitrary code.
3. **Validate** — the spec is checked structurally and semantically (do the bindings resolve? is that codec actually available on this machine?) with an automatic repair-and-retry loop before anything renders.
4. **Render** — the validated spec mounts as an interactive terminal UI.
5. **Gate & run** — when an action fires, the *host* parses the real command (never the model), splits compound commands, refuses opaque substitution, and resolves it against a deny-first permission engine with a non-overridable hard floor. Approved commands run inside an OS sandbox. Output is stripped of terminal control sequences before it ever reaches the screen.
6. **Keep** — useful apps can be saved and relaunched later, re-binding their parameters on the way back in.

## Design principles

- **Declarative, not generated code.** The agent is bounded to a trusted component catalog. Off-catalog elements are rejected at generation time and fail loud at render time.
- **The host holds the keys.** Permission decisions, command parsing, and sandboxing live in the host — not in model output and not in the UI layer.
- **Security can't be bypassed.** The control-sequence sanitizer is a zero-dependency leaf; the permission engine sits behind ports that upstream code can't reach around. The boundaries are enforced by the build, not by convention.
- **Swappable renderer.** The terminal renderer sits behind a single port with no UI framework in its signature, so the rendering backend can change without touching the core.

## Architecture

A pnpm + Turborepo monorepo of focused packages across six layers — types and transport at the base, then the agent loop, the spec/validation layer, the catalog and renderer seam, execution + permission + sandbox, and the kept-app library. Two seams keep it honest (the renderer swap boundary and the no-code catalog allowlist) and one moat keeps it safe (the permission engine, the OS sandbox, and lazily-attached, gated tool servers). Import directions are machine-enforced, so the architecture can't silently rot.

Built with TypeScript and Ink, with a declarative rendering layer, a streaming model loop, host-side shell parsing, and an OS sandbox underneath.

## Status

Early. The design and a complete set of implementation plans are done; the build is just beginning. Expect rapid change and breaking everything.
