import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { EngramCliAdapter } from './engram-cli.ts';
import type { Page, Query } from '../types.ts';

function mkPage(slug: string, title: string, compiled_truth: string): Page {
  return {
    slug,
    type: 'person',
    title,
    compiled_truth,
    timeline: '',
  };
}

function mkQuery(text: string): Query {
  return {
    id: 'q-1',
    tier: 'easy',
    text,
    expected_output_type: 'cited-source-pages',
    gold: { relevant: ['people/alice'] },
  };
}

function writeFakeEngram(dir: string): string {
  const bin = join(dir, 'fake-engram');
  writeFileSync(bin, `#!/usr/bin/env bun
const [cmd, ...args] = Bun.argv.slice(2);
if (cmd === 'init') process.exit(0);
if (cmd === 'sources' && args[0] === 'add') process.exit(0);
if (cmd === 'sync') process.exit(0);
if (cmd === 'query') {
  console.log(JSON.stringify([
    { slug: 'people/alice', score: 3, chunk_text: 'Alice hit' },
    { slug: 'people/alice', score: 2, chunk_text: 'duplicate chunk' },
    { slug: 'companies/acme', score: 1, chunk_text: 'Acme hit' },
  ]));
  process.exit(0);
}
if (cmd === 'search') {
  console.log(JSON.stringify([]));
  process.exit(0);
}
console.error('unexpected command', cmd, args.join(' '));
process.exit(2);
`, 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}

describe('EngramCliAdapter', () => {
  test('ingests public pages through source sync and returns unique ranked page IDs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'engram-cli-adapter-test-'));
    try {
      const adapter = new EngramCliAdapter({
        engramBin: writeFakeEngram(root),
        keepWorkspace: true,
        workRoot: root,
      });
      const state = await adapter.init([
        mkPage('people/alice', 'Alice', 'Alice works at Acme.'),
        mkPage('companies/acme', 'Acme', 'Acme employs Alice.'),
      ], { name: 'engram-query' });

      const results = await adapter.query(mkQuery('Who works at Acme?'), state);

      expect(results.map(r => r.page_id)).toEqual(['people/alice', 'companies/acme']);
      expect(results.map(r => r.rank)).toEqual([1, 2]);
      expect(results[0].snippet).toBe('Alice hit');
      expect(await Bun.file(join((state as any).sourceDir, 'people/alice.md')).text())
        .toContain('Alice works at Acme.');
      await adapter.teardown(state);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
