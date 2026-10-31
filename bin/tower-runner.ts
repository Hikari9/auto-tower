#!/usr/bin/env -S node --import tsx
import { main } from '../src/runner/cli.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  undefined,
  controller.signal,
);
