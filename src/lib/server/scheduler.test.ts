import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _computeNext, _schedulerInternalsForTests, _validTimezone, createSchedule, listSchedules } from './scheduler';

// Regression test for the scheduled-mission timezone mismatch: _computeNext built
// `new Cron(cron, { paused: true })` with no timezone, so cron fields were
// evaluated in the SERVER process timezone (UTC on Railway/Docker) while the
// Kanban UI labels schedules "(in your timezone, <browser tz>)". Now the
// operator's IANA timezone is threaded through so the fire time matches the
// label. These tests fail on the pre-fix code (timezone ignored) and pass after.

function hourInZone(tz: string, iso: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === 'hour')?.value);
}

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
const originalSpawnerUiUrl = process.env.SPAWNER_UI_URL;
const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
let tempDirs: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'spawner-scheduler-'));
  tempDirs.push(dir);
  process.env.SPAWNER_STATE_DIR = dir;
  _schedulerInternalsForTests.reset();
  return dir;
}

function record(overrides: Partial<Parameters<typeof _schedulerInternalsForTests.fire>[0]> = {}): Parameters<typeof _schedulerInternalsForTests.fire>[0] {
  return {
    id: 'sched-test',
    cron: '* * * * *',
    action: 'mission',
    payload: { goal: 'run a scheduled mission' },
    chatId: null,
    timezone: null,
    createdAt: new Date().toISOString(),
    lastFiredAt: null,
    nextFireAt: new Date(Date.now() - 60_000).toISOString(),
    fireCount: 0,
    lastStatus: null,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreEnv('SPAWNER_STATE_DIR', originalSpawnerStateDir);
  restoreEnv('SPAWNER_UI_URL', originalSpawnerUiUrl);
  restoreEnv('TELEGRAM_BOT_TOKEN', originalTelegramBotToken);
  _schedulerInternalsForTests.reset();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('_computeNext timezone handling', () => {
  it('evaluates cron fields in the supplied IANA timezone', () => {
    const iso = _computeNext('0 9 * * *', 'America/New_York');
    expect(iso).toBeTruthy();
    // "0 9 * * *" must fire at 09:00 wall-clock in the requested zone.
    expect(hourInZone('America/New_York', iso as string)).toBe(9);
  });

  it('produces different fire instants for the same cron in different timezones', () => {
    // Pre-fix the timezone arg was ignored, so both evaluated in the process
    // timezone and were identical. After the fix they must differ.
    const ny = _computeNext('0 9 * * *', 'America/New_York');
    const tokyo = _computeNext('0 9 * * *', 'Asia/Tokyo');
    expect(ny).toBeTruthy();
    expect(tokyo).toBeTruthy();
    expect(ny).not.toBe(tokyo);
  });

  it('still works with no timezone (process timezone) and rejects invalid zones', () => {
    expect(_computeNext('0 9 * * *')).toBeTruthy();
    expect(_validTimezone('Europe/Zurich')).toBe('Europe/Zurich');
    expect(_validTimezone('  Asia/Tokyo  ')).toBe('Asia/Tokyo');
    expect(_validTimezone('Not/AZone')).toBeNull();
    expect(_validTimezone('')).toBeNull();
    expect(_validTimezone(undefined)).toBeNull();
  });
});

describe('scheduler reliability guards', () => {
  it('rejects a non-empty misspelled IANA timezone', async () => {
    await tempStateDir();

    await expect(
      createSchedule({
        cron: '0 9 * * *',
        action: 'mission',
        payload: { goal: 'timezone proof' },
        timezone: 'America/NewYork'
      })
    ).rejects.toThrow('Invalid IANA timezone: America/NewYork');
  });

  it('keeps Telegram relay text under the platform limit', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'packet-204-token';
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      expect(body.text.length).toBeLessThan(4096);
      expect(body.text).toContain('... [truncated]');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await _schedulerInternalsForTests.relayToTelegram(
      record({ chatId: '1234' }),
      { ok: false, summary: 'x'.repeat(5000) }
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('backs up corrupt schedules before resetting the in-memory store', async () => {
    const dir = await tempStateDir();
    await writeFile(path.join(dir, 'schedules.json'), '{bad json', 'utf-8');

    await expect(listSchedules()).resolves.toEqual([]);

    const backups = (await readdir(dir)).filter((file) => file.startsWith('schedules.json.corrupt-'));
    expect(backups).toHaveLength(1);
    await expect(readFile(path.join(dir, backups[0]), 'utf-8')).resolves.toBe('{bad json');
  });

  // Scheduled fires no longer execute from stored authority: a schedule record
  // is evidence only, and _fire blocks fail-closed until a fresh Governor
  // decision authorizes execution. These tests pin the authority gate.
  it('blocks scheduled mission fires without fresh Governor authority and never calls spark/run', async () => {
    process.env.SPAWNER_UI_URL = 'http://scheduler.test';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await _schedulerInternalsForTests.fire(record());

    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      'scheduled mission fire requires fresh Governor authority; stored schedule authority is evidence only'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks scheduled loop fires without fresh Governor authority and never calls the loop runner', async () => {
    process.env.SPAWNER_UI_URL = 'http://scheduler.test';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      _schedulerInternalsForTests.fire(record({ action: 'loop', payload: { chipKey: 'chip-test' } }))
    ).resolves.toEqual({
      ok: false,
      summary: 'scheduled loop fire requires fresh Governor authority; stored schedule authority is evidence only',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('increments fireCount and persists the blocked-fire status when a tick fires a stored schedule', async () => {
    const dir = await tempStateDir();
    await writeFile(
      path.join(dir, 'schedules.json'),
      JSON.stringify({ schedules: [record()] }, null, 2),
      'utf-8'
    );
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await _schedulerInternalsForTests.tick();

    const [saved] = await listSchedules();
    expect(saved.fireCount).toBe(1);
    expect(saved.lastStatus).toBe(
      'fail: scheduled mission fire requires fresh Governor authority; stored schedule authority is evidence only'
    );
    expect(saved.nextFireAt).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('repairs an invalid nextFireAt without firing the schedule', async () => {
    const dir = await tempStateDir();
    await writeFile(
      path.join(dir, 'schedules.json'),
      JSON.stringify({ schedules: [record({ nextFireAt: 'not-a-date' })] }, null, 2),
      'utf-8'
    );
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await _schedulerInternalsForTests.tick();

    const [saved] = await listSchedules();
    expect(saved.fireCount).toBe(0);
    expect(Number.isFinite(Date.parse(saved.nextFireAt || ''))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
