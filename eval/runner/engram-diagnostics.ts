#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createEngramQuery, createEngramSearch } from './adapters/engram-cli.ts';
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { precisionAtK, recallAtK, sanitizePage, sanitizeQuery } from './types.ts';

const TOP_K = 5;
const CORPUS_DIR = 'eval/data/world-v1';

interface RichPage extends Page {
  _facts: {
    type: string;
    founders?: string[];
    employees?: string[];
    investors?: string[];
    advisors?: string[];
    attendees?: string[];
  };
}

interface QueryDiagnostic {
  id: string;
  relation: string;
  text: string;
  expected: string[];
  query: AdapterDiagnostic;
  search: AdapterDiagnostic;
}

interface AdapterDiagnostic {
  precision_at_5: number;
  recall_at_5: number;
  top_5: string[];
  hits: string[];
  misses: string[];
  extras: string[];
}

function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const pages: RichPage[] = [];
  for (const file of files) {
    const page = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (Array.isArray(page.timeline)) page.timeline = page.timeline.join('\n');
    if (Array.isArray(page.compiled_truth)) page.compiled_truth = page.compiled_truth.join('\n\n');
    page.title = String(page.title ?? '');
    page.compiled_truth = String(page.compiled_truth ?? '');
    page.timeline = String(page.timeline ?? '');
    pages.push(page as RichPage);
  }
  return pages;
}

function buildQueries(pages: RichPage[]): Query[] {
  const existing = new Set(pages.map((p) => p.slug));
  const filter = (slugs: string[]) => slugs.filter((slug) => existing.has(slug));
  const queries: Query[] = [];
  let counter = 0;
  const nextId = () => `q-${String(++counter).padStart(4, '0')}`;

  for (const page of pages) {
    if (page._facts.type !== 'meeting') continue;
    const expected = filter(page._facts.attendees ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who attended ${page.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: expected },
    });
  }

  for (const page of pages) {
    if (page._facts.type !== 'company') continue;
    const expected = filter([...(page._facts.employees ?? []), ...(page._facts.founders ?? [])]);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who works at ${page.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: [...new Set(expected)] },
    });
  }

  for (const page of pages) {
    if (page._facts.type !== 'company') continue;
    const expected = filter(page._facts.investors ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who invested in ${page.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: expected },
    });
  }

  for (const page of pages) {
    if (page._facts.type !== 'company') continue;
    const expected = filter(page._facts.advisors ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who advises ${page.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: expected },
    });
  }

  return queries;
}

function relationFor(text: string): string {
  if (text.startsWith('Who attended ')) return 'attended';
  if (text.startsWith('Who works at ')) return 'works_at';
  if (text.startsWith('Who invested in ')) return 'invested_in';
  if (text.startsWith('Who advises ')) return 'advises';
  return 'unknown';
}

async function runAdapter(adapter: Adapter, pages: Page[], queries: Query[]): Promise<Map<string, RankedDoc[]>> {
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name });
  const results = new Map<string, RankedDoc[]>();
  for (const query of queries) {
    const publicQuery = sanitizeQuery(query);
    results.set(query.id, await adapter.query(publicQuery as unknown as Query, state));
  }
  if (adapter.teardown) await adapter.teardown(state);
  return results;
}

function diagnose(results: RankedDoc[], expected: string[]): AdapterDiagnostic {
  const relevant = new Set(expected);
  const top = results.slice(0, TOP_K).map((result) => result.page_id);
  const hits = top.filter((id) => relevant.has(id));
  return {
    precision_at_5: precisionAtK(results, relevant, TOP_K),
    recall_at_5: recallAtK(results, relevant, TOP_K),
    top_5: top,
    hits,
    misses: expected.filter((id) => !hits.includes(id)),
    extras: top.filter((id) => !relevant.has(id)),
  };
}

const pages = loadCorpus(CORPUS_DIR) as Page[];
const queries = buildQueries(pages as RichPage[]);
const [queryResults, searchResults] = await Promise.all([
  runAdapter(createEngramQuery(), pages, queries),
  runAdapter(createEngramSearch(), pages, queries),
]);

const diagnostics: QueryDiagnostic[] = queries.map((query) => {
  const expected = query.gold.relevant ?? [];
  return {
    id: query.id,
    relation: relationFor(query.text),
    text: query.text,
    expected,
    query: diagnose(queryResults.get(query.id) ?? [], expected),
    search: diagnose(searchResults.get(query.id) ?? [], expected),
  };
});

const summary = {
  queries: queries.length,
  query_misses: diagnostics.filter((row) => row.query.recall_at_5 < 1).length,
  search_misses: diagnostics.filter((row) => row.search.recall_at_5 < 1).length,
  query_low_precision: diagnostics.filter((row) => row.query.recall_at_5 === 1 && row.query.precision_at_5 < 1).length,
  by_relation: Object.fromEntries(
    ['attended', 'works_at', 'invested_in', 'advises'].map((relation) => {
      const rows = diagnostics.filter((row) => row.relation === relation);
      return [
        relation,
        {
          queries: rows.length,
          query_misses: rows.filter((row) => row.query.recall_at_5 < 1).length,
          search_misses: rows.filter((row) => row.search.recall_at_5 < 1).length,
          query_low_precision: rows.filter((row) => row.query.recall_at_5 === 1 && row.query.precision_at_5 < 1).length,
        },
      ];
    }),
  ),
};

console.log(JSON.stringify({ summary, diagnostics }, null, 2));
