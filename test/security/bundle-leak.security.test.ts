import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The capability walls hold in what ships, not only in the source: the built bundle of every package is
// scanned for the dependencies only one package may carry. Each family has a positive control on the one
// package that does carry it, so a scanner that matched nothing would fail. A missing build fails too.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const DIST: Readonly<Record<string, string>> = {
  types: 'packages/types/dist',
  transport: 'packages/transport/dist',
  sanitizer: 'packages/sanitizer/dist',
  'renderer-core': 'packages/renderer-core/dist',
  catalog: 'packages/catalog/dist',
  spec: 'packages/spec/dist',
  'agent-core': 'packages/agent-core/dist',
  exec: 'packages/exec/dist',
  'runtime-host': 'packages/runtime-host/dist',
  'renderer-ink': 'packages/renderer-ink/dist',
  cli: 'apps/cli/dist',
};
const PACKAGES = Object.keys(DIST);

const EXEC_ONLY = ['child_process', '@modelcontextprotocol/', '@anthropic-ai/sandbox-runtime'];
const MODEL_SDK = [/(["'`])ai(\/[^"'`]+)?\1/, /@ai-sdk\//];
const INK_FAMILY = [/(["'`])react\1/, /(["'`])ink\1/, /@json-render\/ink(?!\/server)/];

function readDist(pkg: string): string {
  const dir = join(repoRoot, DIST[pkg] ?? '');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((file) => /\.(c|m)?js$/.test(file))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
}

// The eval harness and its adversarial case text stay out of every shipped bundle. What the scan looks for
// is read from the source, never imported (this package does not depend on eval code): the sentinel from
// its declaration in row.ts, the hostile texts from the case files. A declaration that is gone, or a case
// set with no hostile case, fails every eval row, so the scan cannot look for nothing.
const EVAL_ROW_FILE = 'apps/cli/eval/harness/row.ts';
const EVAL_CASES_DIR = 'apps/cli/eval/cases';
const SENTINEL_DECLARATION = /export const EVAL_HARNESS_ID = (['"])(.+?)\1;/;
const AS_WRITTEN = ' (as the bundler writes it)';

// The slice of a case line the scan reads; the header line has no tags.
interface CaseLine {
  readonly id?: string;
  readonly tags?: readonly string[];
  readonly input?: { readonly text?: string };
}
interface HostileCase {
  readonly id: string;
  readonly text: string;
}
interface EvalInputs {
  readonly sentinel: string;
  readonly hostile: readonly [HostileCase, ...HostileCase[]];
}

// A line without the hostile tag is skipped; one with it must carry its id and its text, or the scan stops.
function hostileIn(jsonl: string): HostileCase[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line): HostileCase[] => {
      const parsed: CaseLine = JSON.parse(line);
      if (!parsed.tags?.includes('hostile')) return [];
      const { id, input } = parsed;
      if (typeof id !== 'string' || typeof input?.text !== 'string')
        throw new Error(`a hostile case has no id or no input text: ${line.slice(0, 80)}`);
      return [{ id, text: input.text }];
    });
}

function evalInputs(rowText: string, caseTexts: readonly string[]): EvalInputs {
  const sentinel = SENTINEL_DECLARATION.exec(rowText)?.[2];
  if (sentinel === undefined)
    throw new Error(`EVAL_HARNESS_ID is not declared in ${EVAL_ROW_FILE}`);
  const [first, ...rest] = caseTexts.flatMap(hostileIn);
  if (first === undefined) throw new Error(`no hostile case found in ${EVAL_CASES_DIR}`);
  return { sentinel, hostile: [first, ...rest] };
}

// Every .jsonl file under the cases directory, at any depth, in path order. The patch lines of references/
// carry no tags, so they are skipped like the header line.
function caseFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return caseFilesUnder(path);
      return entry.name.endsWith('.jsonl') ? [path] : [];
    })
    .sort();
}

function readEvalInputs(): EvalInputs {
  return evalInputs(
    readFileSync(join(repoRoot, EVAL_ROW_FILE), 'utf8'),
    caseFilesUnder(join(repoRoot, EVAL_CASES_DIR)).map((file) => readFileSync(file, 'utf8')),
  );
}

// What the cli's bundler (esbuild 0.27.7 under tsup 8.5.1, target node22, no minify or charset option)
// writes for a text inside a string literal. Measured with the installed esbuild over every code point from
// U+0000 to U+10FFFF except the surrogates, each in literals that make the printer pick each quote in turn;
// over every sequence of up to six of a double quote, a single quote, a backtick, ${, a backslash, a line
// feed, a carriage return and a letter; and over 11.4 million literals that put every kind of character
// before and after a text (at its start and its end, as two-character texts, next to a core that picks each
// quote, and </script, <!--, --> and the like split at every place). The rule:
// - The quote is the one needing the fewest escapes (a double quote counts against a double-quoted literal,
//   a single quote against a single-quoted one, a backtick or a ${ against a backtick one; a tie goes to the
//   double quote, then the single, then the backtick), and a source template literal stays a backtick
//   literal. The quote comes from the whole literal, not from the text it holds, so there is one spelling
//   per quote and evalLeaks looks for each.
// - A backslash is written as two, and the quote of the literal is escaped with a backslash; the other two
//   quotes are raw. A ${ is escaped as \${ in a backtick literal only.
// - A line feed is \n, but raw in a backtick literal; a carriage return is \r. NUL is \0 (\x00 before a
//   digit); backspace, vertical tab and form feed are \b \v \f; BEL and ESC are \x07 and \x1B; every other
//   control character below DEL is written as it is.
// - From DEL up the output is ASCII, in upper-case hex: \x and two digits up to U+00FF (DEL and the C1
//   range), a u-escape with four digits up to U+FFFF (the line separators, U+FEFF, U+202E) and a u-escape
//   with braces beyond (U+1F600).
// - Two of these read the character after the text, which can belong to the literal and not to the text: NUL
//   before a digit, and $ before a { in a backtick literal. evalLeaks looks for a text spelled with each
//   ending it may meet (FOLLOWING). Nothing else before or after a text changes how it is written.
// Not modelled: a lone surrogate. Its spelling is not measured, so unmodelledIn stops the scan when a
// hostile text holds one. Not measured either: a build target below ES2015, which cannot build this source.
// No spelling finds a text that is not whole in the bundle: esbuild joins "a" + "b" of constants (measured),
// but not a template with a ${"b"} substitution, a join or a concat.
const QUOTES = ['"', "'", '`'] as const;
type Quote = (typeof QUOTES)[number];

const SHORT_ESCAPES = new Map([
  [0x08, 'b'],
  [0x0a, 'n'],
  [0x0b, 'v'],
  [0x0c, 'f'],
  [0x0d, 'r'],
]);

const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;
const upperHex = (code: number): string => code.toString(16).toUpperCase();

// A control character, DEL or anything outside ASCII, as the printer writes it in every quote.
function escaped(code: number, next: string): string {
  const short = SHORT_ESCAPES.get(code);
  if (short !== undefined) return `\\${short}`;
  if (code === 0) return /\d/.test(next) ? '\\x00' : '\\0';
  if (code === 0x07 || code === 0x1b) return `\\x${upperHex(code).padStart(2, '0')}`;
  if (code < 0x7f) return String.fromCodePoint(code);
  if (code <= 0xff) return `\\x${upperHex(code)}`;
  return code <= 0xffff ? `\\u${upperHex(code).padStart(4, '0')}` : `\\u{${upperHex(code)}}`;
}

function bundlerSpelling(text: string, quote: Quote): string {
  return text.replace(/[^\x20-\x7e]|[\\"'`]|\$(?=\{)/gu, (char, offset: number) => {
    const code = char.codePointAt(0) ?? 0;
    if (isSurrogate(code)) return char;
    if (char === '\\' || char === quote) return `\\${char}`;
    if (char === '$') return quote === '`' ? '\\$' : char;
    if (code === 0x0a && quote === '`') return char;
    return code >= 0x20 && code < 0x7f ? char : escaped(code, text.charAt(offset + 1));
  });
}

// The characters of each hostile text whose spelling is not measured, as `case id: U+code point`: a lone
// surrogate. A text holding one could be unfindable in a bundle with every row green, so the scan stops
// until the bundler's spelling of it is measured and modelled.
function isModelled(char: string): boolean {
  return !isSurrogate(char.codePointAt(0) ?? 0);
}

function unmodelledIn(hostile: readonly HostileCase[]): string[] {
  return hostile.flatMap(({ id, text }) => {
    const found = new Set([...text].filter((char) => !isModelled(char)));
    return [...found].map((char) => {
      const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return `${id}: U+${hex}`;
    });
  });
}

// What may follow a text in the literal that holds it, as far as its spelling goes: nothing that matters, a
// digit (a NUL before it is written as an x escape) or a brace (a $ before it is escaped in a backtick
// literal). The printer reads those from the whole literal, which can go on after the text.
const FOLLOWING = ['', '0', '{'] as const;

// Every way a text can be written in a bundle: in each quote, and for each kind of character that may follow.
function writtenForms(text: string): string[] {
  const forms = QUOTES.flatMap((quote) =>
    FOLLOWING.map((next) => {
      const written = bundlerSpelling(`${text}${next}`, quote);
      return written.slice(0, written.length - next.length);
    }),
  );
  return [...new Set(forms)].filter((form) => form !== text);
}

// One matcher for the package rows and the controls: which eval material a bundle holds, by label. A text
// is looked for as it is and in every way the bundler may have written it.
function evalLeaks(bundle: string, { sentinel, hostile }: EvalInputs): string[] {
  const hit = (label: string, ...needles: string[]): string[] =>
    needles.some((needle) => bundle.includes(needle)) ? [label] : [];
  return [
    ...hit(`sentinel ${sentinel}`, sentinel),
    ...hostile.flatMap(({ id, text }) => [
      ...hit(`hostile case ${id}`, text),
      ...hit(`hostile case ${id}${AS_WRITTEN}`, ...writtenForms(text)),
    ]),
  ];
}

// esbuild 0.27.7's output for a string literal holding the character between a and b, as measured: the
// text between the quotes of a double-quoted literal.
const MEASURED_CODES: ReadonlyArray<readonly [number, string]> = [
  [0x00, '\\0'],
  [0x07, '\\x07'],
  [0x08, '\\b'],
  [0x0a, '\\n'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x1b, '\\x1B'],
  [0x5c, '\\\\'],
  [0x7f, '\\x7F'],
  [0x80, '\\x80'],
  [0x9a, '\\x9A'],
  [0xa0, '\\xA0'],
  [0xe9, '\\xE9'],
  [0xff, '\\xFF'],
  [0x100, '\\u0100'],
  [0x2028, '\\u2028'],
  [0x2029, '\\u2029'],
  [0x202e, '\\u202E'],
  [0xfeff, '\\uFEFF'],
  [0xffff, '\\uFFFF'],
  [0x1f600, '\\u{1F600}'],
  [0x10000, '\\u{10000}'],
  [0x10ffff, '\\u{10FFFF}'],
];

// The whole literal esbuild 0.27.7 printed for a text, quotes included, as measured: the quote it picked
// (the one needing the fewest escapes) and what is between the quotes.
const MEASURED_LITERALS: ReadonlyArray<readonly [string, string]> = [
  ['a"b', "'a\"b'"],
  ["a'b", '"a\'b"'],
  ['a\\b', '"a\\\\b"'],
  ['a`b', '"a`b"'],
  ['a${b}c', '"a${b}c"'],
  // both quotes: the backtick needs no escape
  ['a"b\'c', '`a"b\'c`'],
  ['a"b"c\'d', '`a"b"c\'d`'],
  // all three once: a tie goes to the double quote
  ['a"b\'c`d', '"a\\"b\'c`d"'],
  // a backtick literal escapes a backtick and a ${
  ['a"b"c"d\'e\'f${g}', '`a"b"c"d\'e\'f\\${g}`'],
  ['a"b"c"d\'e\'f\'g`h', '`a"b"c"d\'e\'f\'g\\`h`'],
  // a backslash is doubled, and the quote the literal is written in is escaped
  ['a\\"b', "'a\\\\\"b'"],
  ["a\\'b", '"a\\\\\'b"'],
  // a line feed is \n, but raw in a backtick literal; a carriage return is \r in both
  ['a\nb', '"a\\nb"'],
  ['a"b"c\'d\'e\nf', '`a"b"c\'d\'e\nf`'],
  ['a"b"c\'d\'e\r\nf', '`a"b"c\'d\'e\\r\nf`'],
];

describe('shipped bundle leak gate', () => {
  it.each(PACKAGES)('%s has a built bundle to scan', (pkg) => {
    expect(readDist(pkg).length, `${DIST[pkg] ?? pkg} is missing: build first`).toBeGreaterThan(0);
  });

  it.each(PACKAGES.filter((pkg) => pkg !== 'exec'))(
    '%s carries no process, sandbox or tool-server client',
    (pkg) => {
      const bundle = readDist(pkg);
      for (const dep of EXEC_ONLY)
        expect(bundle.includes(dep), `${pkg} carries ${dep}`).toBe(false);
    },
  );

  it.each(PACKAGES.filter((pkg) => pkg !== 'agent-core'))('%s carries no model SDK', (pkg) => {
    const bundle = readDist(pkg);
    for (const pattern of MODEL_SDK) {
      expect(pattern.test(bundle), `${pkg} matches ${String(pattern)}`).toBe(false);
    }
  });

  it.each(PACKAGES.filter((pkg) => pkg !== 'renderer-ink' && pkg !== 'cli'))(
    '%s carries no React or Ink',
    (pkg) => {
      const bundle = readDist(pkg);
      for (const pattern of INK_FAMILY) {
        expect(pattern.test(bundle), `${pkg} matches ${String(pattern)}`).toBe(false);
      }
    },
  );

  it('the scan sees the process API and the sandbox runtime in exec', () => {
    const bundle = readDist('exec');
    expect(bundle.includes('child_process')).toBe(true);
    expect(bundle.includes('@anthropic-ai/sandbox-runtime')).toBe(true);
  });

  it('the scan sees the model SDK in agent-core', () => {
    const bundle = readDist('agent-core');
    expect(MODEL_SDK.every((pattern) => pattern.test(bundle))).toBe(true);
  });

  it('the scan sees React and Ink in renderer-ink', () => {
    const bundle = readDist('renderer-ink');
    expect(INK_FAMILY.every((pattern) => pattern.test(bundle))).toBe(true);
  });

  it.each(PACKAGES)('%s carries neither the eval harness nor an adversarial case text', (pkg) => {
    expect(evalLeaks(readDist(pkg), readEvalInputs()), `${pkg} carries eval material`).toEqual([]);
  });

  it('the eval scan flags a planted sentinel and hostile text, and not a clean bundle', () => {
    const inputs = readEvalInputs();
    const [first] = inputs.hostile;
    const planted = `const a = "${inputs.sentinel}"; const b = "${first.text}";`;
    expect(evalLeaks(planted, inputs)).toEqual([
      `sentinel ${inputs.sentinel}`,
      `hostile case ${first.id}`,
    ]);
    expect(evalLeaks('const merge = "two files into one";', inputs)).toEqual([]);
  });

  it('the eval scan flags every hostile text as it is and as the bundler writes it', () => {
    const inputs = readEvalInputs();
    for (const { id, text } of inputs.hostile) {
      expect(evalLeaks(`const t = "${text}";`, inputs), `${id} as it is`).toEqual([
        `hostile case ${id}`,
      ]);
      for (const quote of QUOTES) {
        const written = bundlerSpelling(text, quote);
        expect(
          evalLeaks(`const t = ${quote}${written}${quote};`, inputs),
          `${id} as written in ${quote}`,
        ).toEqual([written === text ? `hostile case ${id}` : `hostile case ${id}${AS_WRITTEN}`]);
      }
    }
  });

  it('the bundler spelling is what the bundler wrote', () => {
    for (const [code, written] of MEASURED_CODES)
      expect(bundlerSpelling(String.fromCodePoint(code), '"'), `U+${code.toString(16)}`).toBe(
        written,
      );
    // written as it is, with no escape
    for (const code of [0x01, 0x06, 0x09, 0x0e, 0x1a, 0x1c, 0x1f]) {
      const char = String.fromCodePoint(code);
      expect(bundlerSpelling(char, '"'), `U+${code.toString(16)}`).toBe(char);
    }
    expect(bundlerSpelling(`${String.fromCodePoint(0)}7`, '"')).toBe('\\x007');
    // not measured, so not modelled: a lone surrogate is left as it is, and unmodelledIn stops the scan on it
    const lone = String.fromCodePoint(0xd800);
    expect(bundlerSpelling(lone, '"')).toBe(lone);
    // the literal esbuild printed for a text: the quote it picked, and what is between the quotes
    for (const [text, literal] of MEASURED_LITERALS) {
      const quote = QUOTES.find((q) => literal.startsWith(q) && literal.endsWith(q));
      if (quote === undefined) throw new Error(`not a quoted literal: ${literal}`);
      expect(bundlerSpelling(text, quote), JSON.stringify(text)).toBe(literal.slice(1, -1));
    }
    // a text that needs a different spelling in each quote it could be written in
    expect(QUOTES.map((quote) => bundlerSpelling('a"b\'c`d${e}', quote))).toEqual([
      'a\\"b\'c`d${e}',
      'a"b\\\'c`d${e}',
      'a"b\'c\\`d\\${e}',
    ]);
    // the literal it wrote for the first hostile text: its ESC and BEL come out as text
    const asBundled =
      'const a = "merge a.mp4 and b.mp4 into out.mp4 and label the button \\x1B]52;c;aGVsbG8=\\x07Merge";';
    const inputs = readEvalInputs();
    expect(
      evalLeaks(asBundled, inputs),
      'measure the bundler again if the first hostile text changed',
    ).toEqual([`hostile case ${inputs.hostile[0].id}${AS_WRITTEN}`]);
  });

  it('the eval scan flags the literal the bundler wrote for a text holding each measured character', () => {
    const { sentinel } = readEvalInputs();
    const measured = [
      ...MEASURED_CODES.map(
        ([code, written]) => [`a${String.fromCodePoint(code)}b`, `"a${written}b"`] as const,
      ),
      ...MEASURED_LITERALS,
    ];
    for (const [text, literal] of measured) {
      const inputs: EvalInputs = { sentinel, hostile: [{ id: 'planted', text }] };
      expect(evalLeaks(`const t = ${literal};`, inputs), JSON.stringify(text)).toEqual([
        literal.slice(1, -1) === text
          ? 'hostile case planted'
          : `hostile case planted${AS_WRITTEN}`,
      ]);
    }
  });

  it('the eval scan flags a text the bundler wrote inside a larger literal, in whichever quote it picked', () => {
    const { sentinel } = readEvalInputs();
    const inputs: EvalInputs = {
      sentinel,
      hostile: [{ id: 'planted', text: 'say "hi" it\'s' }],
    };
    // The printer picks the quote from the whole literal, not from the text it holds. These are the literals
    // esbuild 0.27.7 printed for the text alone (a backtick), with one backtick after it (a single quote),
    // and with a single quote and two backticks after it (a double quote).
    const printed: ReadonlyArray<readonly [string, string]> = [
      ['`say "hi" it\'s`', 'hostile case planted'],
      ["'say \"hi\" it\\'s `x'", `hostile case planted${AS_WRITTEN}`],
      ['"say \\"hi\\" it\'s \'x `a`"', `hostile case planted${AS_WRITTEN}`],
    ];
    for (const [literal, label] of printed)
      expect(evalLeaks(`const t = ${literal};`, inputs), literal).toEqual([label]);
    expect(evalLeaks('const t = "say hi its";', inputs)).toEqual([]);
  });

  it('the eval scan flags a text at the edge of a larger literal, whatever follows it in the literal', () => {
    const { sentinel } = readEvalInputs();
    const nul = String.fromCodePoint(0);
    // The printer decides two spellings from the character after the text, which may belong to the literal and
    // not to the text: NUL is written as an x escape before a digit, and a dollar sign is escaped before a
    // brace in a backtick literal. These are the literals esbuild 0.27.7 printed for a text with each ending,
    // the literal going on with the character that changes the spelling and then with one that does not.
    const printed: ReadonlyArray<readonly [text: string, literal: string]> = [
      [`x${nul}`, '"x\\x001"'],
      [`x${nul}`, '"x\\0y"'],
      ['q"q"q\'q\'q$', '`q"q"q\'q\'q\\${z}`'],
      ['q"q"q\'q\'q$', '`q"q"q\'q\'q$z`'],
    ];
    for (const [text, literal] of printed) {
      const inputs: EvalInputs = { sentinel, hostile: [{ id: 'planted', text }] };
      const label = literal.includes(text)
        ? 'hostile case planted'
        : `hostile case planted${AS_WRITTEN}`;
      expect(evalLeaks(`const t = ${literal};`, inputs), literal).toEqual([label]);
    }
  });

  it('the bundler writes ESC and a backslash in the real sanitizer bundle the way the spelling says', () => {
    // A live check of the measured table: the sanitizer's OSC 8 close is a string literal holding ESC and a
    // backslash, so its bundle holds what the bundler writes for them today. A bundler that writes either
    // differently fails here, instead of leaving the texts that hold them unfindable with every other row
    // green. The whole literal is looked for, quotes included, so the closing backslash cannot match by
    // being the start of an escape.
    const bundle = readDist('sanitizer');
    const esc = String.fromCodePoint(0x1b);
    expect(
      bundle.includes(`"${bundlerSpelling(`${esc}]8;;${esc}\\`, '"')}"`),
      'the sanitizer bundle does not hold the OSC 8 close as the spelling writes it: measure the bundler again, or point this row at another literal with ESC and a backslash in it',
    ).toBe(true);
    expect(
      bundle.includes(esc),
      'the sanitizer bundle holds a raw ESC byte: measure the bundler again',
    ).toBe(false);
  });

  it('every hostile text holds only characters the bundler spelling models', () => {
    expect(
      unmodelledIn(readEvalInputs().hostile),
      'measure how the bundler writes the character, then model it in bundlerSpelling',
    ).toEqual([]);
  });

  it('a hostile text holding a character the bundler spelling does not model is reported', () => {
    const around = (...codes: number[]): string => `a ${String.fromCodePoint(...codes)} b`;
    const printable = Array.from({ length: 0x5f }, (_, index) => 0x20 + index);
    const planted: HostileCase[] = [
      // a lone surrogate: its spelling is not measured
      { id: 'high-surrogate', text: around(0xd800) },
      { id: 'low-surrogate', text: around(0xdc00) },
      // everything the spelling does model: every printable ASCII character (the quotes, a backslash, a
      // backtick), the controls, DEL, the C1 range, the line separators, a non-ASCII BMP character and an
      // astral one, given both as one code point and as its surrogate pair
      {
        id: 'modelled',
        text: around(
          ...printable,
          0x1b,
          0x07,
          0x0a,
          0x09,
          0x7f,
          0x85,
          0xe9,
          0x2028,
          0x202e,
          0x1f600,
          0xd83d,
          0xde00,
        ),
      },
    ];
    expect(unmodelledIn(planted)).toEqual(['high-surrogate: U+D800', 'low-surrogate: U+DC00']);
  });

  it('the eval scan reads case files at any depth under the cases directory', () => {
    const declaration = "export const EVAL_HARNESS_ID = 'minitui-eval-harness/1';";
    const nested = '{"id":"hostile-nested","tags":["hostile"],"input":{"text":"a nested probe"}}';
    const dir = mkdtempSync(join(tmpdir(), 'bundle-leak-cases-'));
    try {
      mkdirSync(join(dir, 'sets', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'top.jsonl'), '{"status":"draft","caseSetVersion":1}\n');
      writeFileSync(join(dir, 'sets', 'deep', 'nested.jsonl'), `${nested}\n`);
      // a hostile-looking line in a file that is not .jsonl is not read
      writeFileSync(join(dir, 'sets', 'notes.txt'), `${nested.replace('nested', 'skipped')}\n`);
      const texts = caseFilesUnder(dir).map((file) => readFileSync(file, 'utf8'));
      const inputs = evalInputs(declaration, texts);
      expect(inputs.hostile).toEqual([{ id: 'hostile-nested', text: 'a nested probe' }]);
      expect(evalLeaks('const t = "a nested probe";', inputs)).toEqual([
        'hostile case hostile-nested',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the eval scan stops when its sentinel or its hostile cases are gone', () => {
    const header = '{"status":"draft","caseSetVersion":1}';
    const hostile = '{"id":"a","tags":["hostile"],"input":{"text":"x y"}}';
    const plain = '{"id":"b","tags":["merge"],"input":{"text":"p q"}}';
    const declaration = "export const EVAL_HARNESS_ID = 'minitui-eval-harness/1';";
    expect(evalInputs(declaration, [[header, hostile, plain].join('\n')])).toEqual({
      sentinel: 'minitui-eval-harness/1',
      hostile: [{ id: 'a', text: 'x y' }],
    });
    expect(() => evalInputs(declaration.replace('HARNESS_', ''), [hostile])).toThrow(
      'EVAL_HARNESS_ID is not declared',
    );
    expect(() => evalInputs(declaration, [[header, plain].join('\n')])).toThrow(
      'no hostile case found',
    );
    expect(() => evalInputs(declaration, ['{"id":"c","tags":["hostile"],"input":{}}'])).toThrow(
      'no input text',
    );
  });
});
