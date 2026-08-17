import { Module } from 'node:module';

void Module.createRequire(import.meta.url)('node:child_process');
