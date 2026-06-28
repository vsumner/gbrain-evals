/**
 * External Engram adapter.
 *
 * This treats Engram as a black-box CLI retriever: the adapter receives only
 * public pages/queries from the sealed-qrels runner, ingests those pages
 * through Engram's source-sync CLI path, and converts Engram's ranked chunk
 * output back into BrainBench `RankedDoc` page IDs. The scorer remains the
 * benchmark scorer.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';

export type EngramCliMode = 'query' | 'search';

interface EngramCliOptions {
  name?: string;
  mode?: EngramCliMode;
  engramBin?: string;
  limit?: number;
  keepWorkspace?: boolean;
  workRoot?: string;
}

interface EngramCliState {
  workspace: string;
  sourceDir: string;
  engramBin: string;
  mode: EngramCliMode;
  limit: number;
  keepWorkspace: boolean;
}

interface EngramJsonResult {
  slug?: unknown;
  id?: unknown;
  score?: unknown;
  chunk_text?: unknown;
  snippet?: unknown;
  summary?: unknown;
  title?: unknown;
}

const DEFAULT_LIMIT = 25;

export class EngramCliAdapter implements Adapter {
  readonly name: string;
  private readonly mode: EngramCliMode;
  private readonly engramBin?: string;
  private readonly limit?: number;
  private readonly keepWorkspace: boolean;
  private readonly workRoot?: string;

  constructor(options: EngramCliOptions = {}) {
    this.mode = options.mode ?? 'query';
    this.name = options.name ?? `engram-${this.mode}`;
    this.engramBin = options.engramBin;
    this.limit = options.limit;
    this.keepWorkspace = options.keepWorkspace ?? process.env.BRAINBENCH_ENGRAM_KEEP_WORKSPACES === '1';
    this.workRoot = options.workRoot;
  }

  async init(rawPages: Page[], config: AdapterConfig): Promise<BrainState> {
    const engramBin = String(
      config.engramBin
        ?? this.engramBin
        ?? process.env.ENGRAM_BIN
        ?? 'engram',
    );
    const limit = Number(
      config.limit
        ?? this.limit
        ?? process.env.BRAINBENCH_ENGRAM_LIMIT
        ?? DEFAULT_LIMIT,
    );
    const workspaceParent = this.workRoot ?? tmpdir();
    mkdirSync(workspaceParent, { recursive: true });
    const workspace = mkdtempSync(join(workspaceParent, 'brainbench-engram-'));
    const sourceDir = join(workspace, 'corpus');
    mkdirSync(sourceDir, { recursive: true });

    runCommand(engramBin, ['init', '--workspace', workspace]);
    rawPages.forEach((page, index) => {
      const pagePath = join(sourceDir, `${page.slug || `page-${index}`}.md`);
      mkdirSync(dirname(pagePath), { recursive: true });
      writeFileSync(pagePath, renderPage(page), 'utf8');
    });
    runCommand(engramBin, [
      'sources',
      'add',
      'brainbench-corpus',
      sourceDir,
      '--kind',
      'local',
      '--realm',
      'resident',
      '--federated',
      '--workspace',
      workspace,
    ]);
    runCommand(engramBin, ['sync', '--source', 'brainbench-corpus', '--workspace', workspace]);

    return {
      workspace,
      sourceDir,
      engramBin,
      mode: this.mode,
      limit,
      keepWorkspace: this.keepWorkspace,
    } satisfies EngramCliState;
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as EngramCliState;
    const stdout = runCommand(s.engramBin, [
      s.mode,
      q.text,
      '--workspace',
      s.workspace,
      '--limit',
      String(s.limit),
      '--json',
    ]);
    return rankedDocsFromEngramJson(stdout);
  }

  async teardown(state: BrainState): Promise<void> {
    const s = state as EngramCliState;
    if (!s.keepWorkspace) {
      rmSync(s.workspace, { recursive: true, force: true });
    }
  }
}

export function createEngramQuery(): EngramCliAdapter {
  return new EngramCliAdapter({ mode: 'query' });
}

export function createEngramSearch(): EngramCliAdapter {
  return new EngramCliAdapter({ mode: 'search' });
}

function renderPage(page: Page): string {
  const sections = [
    '---',
    `title: ${yamlString(page.title)}`,
    `type: ${yamlString(page.type)}`,
    '---',
    '',
    page.compiled_truth.trim(),
  ];
  const timeline = page.timeline.trim();
  if (timeline) sections.push('', '## Timeline', '', timeline);
  return sections.filter(part => part !== '').join('\n') + '\n';
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function rankedDocsFromEngramJson(stdout: string): RankedDoc[] {
  const parsed = JSON.parse(stdout || '[]');
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.results)
      ? parsed.results
      : [];
  const docs: RankedDoc[] = [];
  const seen = new Set<string>();
  for (const row of rows as EngramJsonResult[]) {
    if (!row || typeof row !== 'object') continue;
    const pageId = String(row.slug ?? row.id ?? '').trim();
    if (!pageId || seen.has(pageId)) continue;
    seen.add(pageId);
    const fallbackScore = Math.max(0, rows.length - docs.length);
    docs.push({
      page_id: pageId,
      score: typeof row.score === 'number' ? row.score : fallbackScore,
      rank: docs.length + 1,
      snippet: stringOrUndefined(row.chunk_text ?? row.snippet ?? row.summary ?? row.title),
    });
  }
  return docs;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text ? text : undefined;
}

function runCommand(bin: string, args: string[]): string {
  const completed = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (completed.error) {
    throw completed.error;
  }
  if (completed.status !== 0) {
    throw new Error(
      `Engram command failed (${completed.status}): ${bin} ${args.join(' ')}\n`
      + `stdout:\n${completed.stdout}\n`
      + `stderr:\n${completed.stderr}`,
    );
  }
  return completed.stdout;
}
