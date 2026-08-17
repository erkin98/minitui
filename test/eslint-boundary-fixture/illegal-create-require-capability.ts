import { createRequire as makeRequire } from 'node:module';

const load = makeRequire(import.meta.url);
void load('node:child_process');
