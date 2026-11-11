#!/usr/bin/env node
/* global process */
// The bin. Ink reads the colour level once, when it is loaded, and does not read NO_COLOR, so the
// environment is settled here, before the program (and with it Ink) is imported.
if (process.env.NO_COLOR !== undefined) process.env.FORCE_COLOR = '0';

const { cliMain } = await import('@minitui/cli');
process.exitCode = await cliMain(process.argv.slice(2));
