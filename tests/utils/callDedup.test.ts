/**
 * Dedup cache + call-sequence loop detection tests.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  dedupKey, getDedupedResult, storeDedupResult, clearDedupCache,
  appendNote, DEDUP_EXCLUDED_TOOLS, DEDUP_TTL_MS,
  getInFlight, registerInFlight, clearInFlight, clearAllInFlight,
} from '../../src/utils/callDedup';
import { recordCallSequence, resetCallSequence, getMetricsSnapshot } from '../../src/utils/toolMetrics';

beforeEach(() => {
  clearDedupCache();
  clearAllInFlight();
  resetCallSequence();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dedup cache', () => {
  it('returns the stored result for an identical key within the TTL', () => {
    const key = dedupKey('search', { query: 'CustTable' });
    const result = { content: [{ type: 'text', text: 'hit' }] };
    storeDedupResult(key, result);
    expect(getDedupedResult(key)).toBe(result);
  });

  it('treats different args as different keys', () => {
    storeDedupResult(dedupKey('search', { query: 'A' }), { content: [{ type: 'text', text: 'A' }] });
    expect(getDedupedResult(dedupKey('search', { query: 'B' }))).toBeUndefined();
  });

  it('expires entries after the TTL', () => {
    vi.useFakeTimers();
    const key = dedupKey('search', { query: 'CustTable' });
    storeDedupResult(key, { content: [{ type: 'text', text: 'hit' }] });
    vi.advanceTimersByTime(DEDUP_TTL_MS + 1);
    expect(getDedupedResult(key)).toBeUndefined();
  });

  it('never caches error results', () => {
    const key = dedupKey('search', { query: 'X' });
    storeDedupResult(key, { isError: true, content: [{ type: 'text', text: 'fail' }] });
    expect(getDedupedResult(key)).toBeUndefined();
  });

  it('excludes stateful tools from dedup', () => {
    for (const tool of ['build_d365fo_project', 'd365fo_file', 'prepare', 'get_workspace_info']) {
      expect(DEDUP_EXCLUDED_TOOLS.has(tool)).toBe(true);
    }
    expect(DEDUP_EXCLUDED_TOOLS.has('search')).toBe(false);
    expect(DEDUP_EXCLUDED_TOOLS.has('get_table_info')).toBe(false);
  });
});

describe('appendNote', () => {
  it('appends to the first text item only', () => {
    const result = appendNote(
      { content: [{ type: 'text', text: 'body' }, { type: 'text', text: 'second' }] },
      '> note',
    );
    expect(result.content[0].text).toBe('body\n\n> note');
    expect(result.content[1].text).toBe('second');
  });

  it('returns the input unchanged when there is no content', () => {
    const r = { content: [] };
    expect(appendNote(r, 'x')).toBe(r);
  });
});

describe('in-flight dedup', () => {
  it('getInFlight returns undefined before registration', () => {
    expect(getInFlight('k1')).toBeUndefined();
  });

  it('registerInFlight makes the promise available via getInFlight', () => {
    registerInFlight('k1');
    expect(getInFlight('k1')).toBeInstanceOf(Promise);
  });

  it('resolving the handle settles the promise', async () => {
    const handle = registerInFlight('k1');
    const result = { content: [{ type: 'text', text: 'done' }] };
    handle.resolve(result);
    await expect(getInFlight('k1')).resolves.toBe(result);
  });

  it('clearInFlight removes the entry', () => {
    registerInFlight('k1');
    clearInFlight('k1');
    expect(getInFlight('k1')).toBeUndefined();
  });

  it('coalesces two parallel identical calls (integration)', async () => {
    // Simulate two concurrent calls: both check in-flight, neither finds a
    // cached result. The first registers; the second should coalesce onto it.
    const key = dedupKey('object_patterns', { domain: 'form', action: 'analyze' });

    // --- caller A: registers and will resolve after a tick ---
    const handle = registerInFlight(key);
    const result = { content: [{ type: 'text', text: 'patterns' }] };

    // --- caller B: finds the in-flight promise ---
    const inFlight = getInFlight(key);
    expect(inFlight).toBeInstanceOf(Promise);

    // Simulate A completing
    handle.resolve(result);
    clearInFlight(key);

    // B should receive the same result
    expect(await inFlight).toBe(result);
  });
});

describe('recordCallSequence (loop detection)', () => {
  it('counts identical calls within the window', () => {
    expect(recordCallSequence('search', 'k1')).toBe(1);
    expect(recordCallSequence('search', 'k1')).toBe(2);
    expect(recordCallSequence('search', 'k1')).toBe(3);
  });

  it('does not mix different tools or args', () => {
    recordCallSequence('search', 'k1');
    expect(recordCallSequence('get_table_info', 'k1')).toBe(1);
    expect(recordCallSequence('search', 'k2')).toBe(1);
  });

  it('forgets calls that fall outside the window', () => {
    recordCallSequence('search', 'k1');
    for (let i = 0; i < 15; i++) recordCallSequence('other', `fill-${i}`);
    expect(recordCallSequence('search', 'k1')).toBe(1);
  });

  it('tracks duplicates in the metrics snapshot', () => {
    recordCallSequence('search', 'dup');
    recordCallSequence('search', 'dup');
    const snap = getMetricsSnapshot().find(s => s.tool === 'search');
    expect(snap?.duplicateCalls).toBeGreaterThanOrEqual(1);
  });
});
