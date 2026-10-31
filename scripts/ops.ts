import { runOpsCli } from '../src/ops/cli.js';

process.exitCode = runOpsCli(process.argv.slice(2), process.env, {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
