import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { advisoriesIn, checkDirectory, evaluateAudit, main, parseExceptions } from './audit-gate.mjs';

interface Found { id: string; pkg: string; severity?: string }

/** The shape `npm audit --json` reports: one entry per vulnerable package, advisories as `via` objects. */
function auditOf(...found: Found[]) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const { id, pkg, severity = 'high' } of found) {
    vulnerabilities[pkg] = {
      name: pkg, severity, isDirect: false, range: '*', effects: [],
      via: [{ source: 1_000_000, name: pkg, dependency: pkg, title: `${pkg} advisory`, url: `https://github.com/advisories/${id}`, severity, range: '*' }],
    };
    // A package that is vulnerable only because it depends on this one lists it by name.
    vulnerabilities[`uses-${pkg}`] = { name: `uses-${pkg}`, severity, isDirect: true, range: '*', effects: [], via: [pkg] };
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
}

const BRACES: Found = { id: 'GHSA-vfj7-8cjw-p6xm', pkg: 'braces' };
const CACHE: Found = { id: 'GHSA-ch52-4w7c-c8xp', pkg: 'http-cache-semantics' };
const exception = (id: string, expires = '2026-11-02', reason = 'No patched release exists.') => ({ id, expires, reason });
const TODAY = '2026-10-03';

describe('advisoriesIn', () => {
  it('lists each advisory once, however many packages carry it, and ignores packages that only depend on one', () => {
    const audit = auditOf(BRACES, { ...BRACES, pkg: 'micromatch' });
    const advisories = advisoriesIn(audit);
    expect([...advisories.keys()]).toEqual(['GHSA-vfj7-8cjw-p6xm']);
    expect(advisories.get('GHSA-vfj7-8cjw-p6xm')!.packages.sort()).toEqual(['braces', 'micromatch']);
  });

  it('falls back to the numeric source when an advisory has no url', () => {
    const audit = { vulnerabilities: { x: { severity: 'low', via: [{ source: 12345, name: 'x', title: 't', severity: 'low' }] } } };
    expect([...advisoriesIn(audit).keys()]).toEqual(['12345']);
  });

  it('is empty for a clean audit', () => {
    expect(advisoriesIn({ vulnerabilities: {} }).size).toBe(0);
    expect(advisoriesIn({}).size).toBe(0);
  });
});

describe('evaluateAudit', () => {
  it('passes a clean audit', () => {
    expect(evaluateAudit(auditOf(), [], TODAY)).toMatchObject({ ok: true, blocking: [], excepted: [], expired: [] });
  });

  it('blocks an advisory nobody excepted, at any severity', () => {
    const result = evaluateAudit(auditOf({ id: 'GHSA-low-0000-0000', pkg: 'tiny', severity: 'low' }), [exception(BRACES.id)], TODAY);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((advisory: { id: string }) => advisory.id)).toEqual(['GHSA-low-0000-0000']);
  });

  it('passes an advisory with a live exception, and reports why', () => {
    const result = evaluateAudit(auditOf(BRACES), [exception(BRACES.id, '2026-11-02', 'Reachable only with trusted patterns.')], TODAY);
    expect(result.ok).toBe(true);
    expect(result.excepted).toEqual([expect.objectContaining({ id: BRACES.id, expires: '2026-11-02', reason: 'Reachable only with trusted patterns.' })]);
  });

  it('keeps an exception valid through its last day and fails the day after', () => {
    const live = evaluateAudit(auditOf(BRACES), [exception(BRACES.id, '2026-11-02')], '2026-11-02');
    expect(live.ok).toBe(true);

    const lapsed = evaluateAudit(auditOf(BRACES), [exception(BRACES.id, '2026-11-02')], '2026-11-03');
    expect(lapsed.ok).toBe(false);
    expect(lapsed.expired.map((advisory: { id: string }) => advisory.id)).toEqual([BRACES.id]);
    expect(lapsed.blocking).toEqual([]);
  });

  it('does not let an exception for one advisory excuse another', () => {
    const result = evaluateAudit(auditOf(BRACES, CACHE), [exception(BRACES.id)], TODAY);
    expect(result.ok).toBe(false);
    expect(result.blocking.map((advisory: { id: string }) => advisory.id)).toEqual([CACHE.id]);
    expect(result.excepted.map((advisory: { id: string }) => advisory.id)).toEqual([BRACES.id]);
  });

  it('ignores an exception for an advisory that is no longer reported', () => {
    expect(evaluateAudit(auditOf(), [exception(BRACES.id)], TODAY)).toMatchObject({ ok: true, excepted: [] });
  });

  it('never passes when the audit itself could not run', () => {
    const result = evaluateAudit({ error: { code: 'ENOAUDIT', summary: 'audit endpoint returned an error', detail: 'offline' } }, [exception(BRACES.id)], TODAY);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('audit endpoint returned an error');
  });
});

describe('parseExceptions', () => {
  it('accepts well-formed entries', () => {
    expect(parseExceptions({ exceptions: [exception(BRACES.id)] })).toEqual([exception(BRACES.id)]);
    expect(parseExceptions({ exceptions: [] })).toEqual([]);
  });

  it.each([
    ['a missing list', {}],
    ['an entry without an id', { exceptions: [{ expires: '2026-11-02', reason: 'x' }] }],
    ['an entry without a reason', { exceptions: [{ id: 'GHSA-a', expires: '2026-11-02' }] }],
    ['an entry with a blank reason', { exceptions: [{ id: 'GHSA-a', expires: '2026-11-02', reason: '   ' }] }],
    ['an entry without an expiry', { exceptions: [{ id: 'GHSA-a', reason: 'x' }] }],
    ['an expiry that is not a date', { exceptions: [{ id: 'GHSA-a', expires: 'soon', reason: 'x' }] }],
    ['an impossible date', { exceptions: [{ id: 'GHSA-a', expires: '2026-13-45', reason: 'x' }] }],
    ['the same advisory twice', { exceptions: [exception('GHSA-a'), exception('GHSA-a')] }],
  ])('rejects %s, so a typo cannot silently excuse nothing or everything', (_label, config) => {
    expect(() => parseExceptions(config)).toThrow();
  });

  it('accepts the exceptions file committed to the repository', () => {
    const committed = JSON.parse(fs.readFileSync(new URL('../.github/audit-exceptions.json', import.meta.url), 'utf8'));
    const parsed = parseExceptions(committed);
    // Every committed entry is accepted, whichever advisories it holds today.
    expect(parsed.map((entry: { id: string }) => entry.id)).toEqual(committed.exceptions.map((entry: { id: string }) => entry.id));
    expect(parsed.length).toBeGreaterThan(0);
  });
});

describe('checkDirectory and main', () => {
  const exceptions = [exception(BRACES.id), exception(CACHE.id)];

  it('audits the directory it was given', async () => {
    const asked: string[] = [];
    const result = await checkDirectory({ dir: 'desktop', exceptions, today: TODAY, runAudit: async (dir: string) => { asked.push(dir); return auditOf(CACHE); } });
    expect(asked).toEqual(['desktop']);
    expect(result.ok).toBe(true);
  });

  const run = (audits: Record<string, unknown>, config: unknown = { exceptions }) => {
    const lines: string[] = [];
    return main(['.', 'gui'], {
      runAudit: async (dir: string) => { const next = audits[dir]; if (next instanceof Error) throw next; return next; },
      readText: async () => JSON.stringify(config),
      today: () => TODAY,
      log: (line: string) => lines.push(line),
    }).then((code: number) => ({ code, output: lines.join('\n') }));
  };

  it('exits 0 when every directory is clean or fully excepted', async () => {
    const { code, output } = await run({ '.': auditOf(BRACES), gui: auditOf() });
    expect(code).toBe(0);
    expect(output).toContain(BRACES.id);
    expect(output).toMatch(/2026-11-02/);
  });

  it('exits 1 when any directory has an advisory without an exception, and names it', async () => {
    const { code, output } = await run({ '.': auditOf(BRACES), gui: auditOf({ id: 'GHSA-new-0000-0000', pkg: 'fresh' }) });
    expect(code).toBe(1);
    expect(output).toContain('GHSA-new-0000-0000');
  });

  it('exits 1 when an exception has expired', async () => {
    const { code, output } = await run({ '.': auditOf(BRACES), gui: auditOf() }, { exceptions: [exception(BRACES.id, '2026-10-01')] });
    expect(code).toBe(1);
    expect(output).toMatch(/expired/i);
  });

  it('exits 1 when the audit cannot run, rather than passing', async () => {
    const { code, output } = await run({ '.': new Error('ENOTFOUND registry.npmjs.org'), gui: auditOf() });
    expect(code).toBe(1);
    expect(output).toContain('ENOTFOUND');
  });

  it('exits 1 on an invalid exceptions file', async () => {
    const { code } = await run({ '.': auditOf(), gui: auditOf() }, { exceptions: [{ id: 'GHSA-a' }] });
    expect(code).toBe(1);
  });
});
