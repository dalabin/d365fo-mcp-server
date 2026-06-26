/**
 * Search Labels Tool
 * Full-text search across indexed AxLabelFile entries.
 * Returns matching labels with their ID, text, comment and model/language info.
 *
 * Typical use-cases:
 *  - Find existing labels before creating new ones
 *  - Discover the @ABC:MyLabel reference syntax to use in code or metadata
 *  - List all labels for a specific label file / model
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const SearchLabelsArgsSchema = z.object({
  query: z
    .string()
    .describe(
      'Search text — searches label ID, label text and comments (e.g. "customer name", "MyFeature", "batch"). ' +
      'FTS5 syntax is allowed: word* (prefix), "phrase" (exact), AND/OR/NOT, parens for grouping. ' +
      'See matchType parameter for shortcuts.',
    ),
  language: z
    .string()
    .optional()
    .default('en-US')
    .describe('Language/locale to search in (default: en-US). Examples: cs, de, sk, en-US'),
  model: z
    .string()
    .optional()
    .describe('Restrict results to a specific model (e.g. ContosoExt, ApplicationPlatform)'),
  labelFileId: z
    .string()
    .optional()
    .describe('Restrict results to a specific label file ID (e.g. ContosoExt, SYS)'),
  limit: z.number().optional().default(30).describe('Maximum number of results (default 30)'),
  matchType: z
    .enum(['fts5', 'substring', 'prefix', 'phrase'])
    .optional()
    .default('fts5')
    .describe(
      'How to interpret the query: ' +
      '"fts5" (default, full FTS5 syntax: "phrase", word* prefix, AND/OR/NOT, parens); ' +
      '"substring" (LIKE %x% on text OR label_id, no FTS5 syntax, safe for queries with _ or %); ' +
      '"prefix" (auto-appends *, FTS5 prefix match — "Failed" → "Failed*"); ' +
      '"phrase" (auto-wraps in " ", FTS5 exact phrase match).',
    ),
  description: z
    .enum(['any', 'empty', 'present'])
    .optional()
    .default('any')
    .describe(
      'Filter by whether the .label.txt developer comment is populated. ' +
      '"any" (default) returns both; ' +
      '"empty" returns only labels with NULL/blank comment (clean vocabulary, ' +
      'typically shorter and reused in many places — 90% less noise on system models); ' +
      '"present" returns only labels with a developer comment (long, descriptive, ' +
      'often help-text).',
    ),
});

export async function searchLabelsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SearchLabelsArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { query, language, model, labelFileId, limit, matchType, description } = args;

    let results = symbolIndex.searchLabels(query, {
      language, model, labelFileId, limit, matchType, description,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No labels found matching "${query}"` +
              (language !== 'en-US' ? ` in language "${language}"` : '') +
              (model ? ` in model "${model}"` : '') +
              (description !== 'any' ? ` with description="${description}"` : '') +
              '.\n\n' +
              `💡 Tip: Use labels(action="create") to add a new label to your custom model.\n` +
              `💡 To search a different language use the language parameter (e.g. "cs", "de", "sk").\n` +
              `💡 To find clean vocabulary labels (no developer comment), retry with description="empty".`,
          },
        ],
      };
    }

    // Normalise column names (DB returns snake_case)
    const normalise = (r: any) => ({
      labelId: r.label_id ?? r.labelId,
      labelFileId: r.label_file_id ?? r.labelFileId,
      model: r.model,
      language: r.language,
      text: r.text,
      comment: r.comment ?? null,
    });

    // Active filter chips — make the LLM aware of what's applied so it
    // doesn't accidentally re-trigger the same query with no filters.
    const activeFilters: string[] = [];
    if (language !== 'en-US')       activeFilters.push(`language=${language}`);
    if (model)                      activeFilters.push(`model=${model}`);
    if (labelFileId)                activeFilters.push(`labelFileId=${labelFileId}`);
    if (matchType !== 'fts5')       activeFilters.push(`matchType=${matchType}`);
    if (description !== 'any')      activeFilters.push(`description=${description}`);

    const lines: string[] = [
      `Found ${results.length} label(s) matching "${query}"` +
        (activeFilters.length ? ` [${activeFilters.join(', ')}]` : '') +
        ':',
      '',
    ];

    // If description='any' (default) and we have at least one result WITH a
    // comment, hint that description='empty' would cut 90% of noise on system
    // models. This makes the LLM learn the parameter organically.
    const hintResultsHaveComments =
      description === 'any' && results.some(r => (r.comment ?? '').trim() !== '');
    if (hintResultsHaveComments) {
      lines.push('💡 Many results have developer comments (long, descriptive). ' +
        'For clean vocabulary labels (no comment, typically shorter), retry with description="empty".');
      lines.push('');
    }

    for (const raw of results) {
      const r = normalise(raw);
      // X++ label reference syntax
      const ref = `@${r.labelFileId}:${r.labelId}`;
      lines.push(`  ${ref}`);
      lines.push(`  Text    : ${r.text}`);
      if (r.comment) lines.push(`  Comment : ${r.comment}`);
      lines.push(`  Model   : ${r.model}  |  LabelFile: ${r.labelFileId}`);
      lines.push('');
    }

    const first = normalise(results[0]);
    lines.push(`💡 Use the label reference syntax in X++:  literalStr("@${first.labelFileId}:${first.labelId}")`);
    lines.push(`💡 Or in metadata XML:  <Label>@${first.labelFileId}:${first.labelId}</Label>`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error searching labels: ${err.message}` }],
      isError: true,
    };
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
