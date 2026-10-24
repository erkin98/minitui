import { hasBraceExpansion } from './operands.js';

// Words that can stand in command-name position without being a command: made only of digits (a file
// descriptor the grammar read as the name), a shell reserved word left behind after a wrapper peel, or
// an assignment word (`NAME=value`). The host cannot say which binary any of them runs.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  '!',
  '{',
  '}',
  '[[',
  ']]',
]);

export const isDigitsOnly = (name: string): boolean => /^[0-9]+$/.test(name);
export const isReservedWord = (name: string): boolean => RESERVED_WORDS.has(name);
export const isAssignmentWord = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(name);

export const isNonCommandName = (name: string): boolean =>
  isDigitsOnly(name) || isReservedWord(name) || isAssignmentWord(name);

// A token that spans lines: the grammar reads a newline followed by an escaped character as one word.
export const hasLineBreak = (token: string): boolean => /[\r\n]/.test(token);

// A name that carries an unquoted glob character or a brace expansion (the tree check decides this
// before the wrapper peel; this one covers the name the peel produced).
export const hasGlobOrBrace = (name: string): boolean =>
  /[*?[]/.test(name) || hasBraceExpansion(name);
