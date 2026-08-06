import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runPipeline } from './pipeline.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    refresh: { type: 'boolean', default: false },
    out: { type: 'string', default: 'chunks.json' },
  },
});

if (!values.repo) {
  console.error('Usage: npm run ingest -- --repo <local-path-or-github-url> [--refresh] [--out chunks.json]');
  process.exit(1);
}

const result = await runPipeline(values.repo, { refresh: values.refresh });

if (!result.ok) {
  console.error(`Ingest failed: ${result.error}`);
  process.exit(1);
}

const { chunks, report } = result.value;
await writeFile(values.out, JSON.stringify(chunks, null, 2));

console.log(`Files seen:      ${report.filesSeen}`);
console.log(`Chunked:         ${report.chunked}`);
console.log(`Degraded:        ${report.degraded}`);
console.log(`No declarations: ${report.noDeclarations}`);
console.log(`Failed:          ${report.failed}`);
console.log(`Skipped:         ${report.skipped}`);
console.log(`Total chunks:    ${report.totalChunks}`);
console.log(`Commit SHA:      ${report.commitSha ?? '(none)'}`);
console.log(`Wrote ${values.out}`);
