import { logger } from '$lib/utils/logger';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Cron } from 'croner';
import { env as privateEnv } from '$env/dynamic/private';
import { spawnerStateDir } from './spawner-state';
import {
  assertNativeGovernorHarnessAuthority,
  resolveExecutionAuthority,
  type HarnessAuthorityVerdict
} from './harness-authority';
import { parseJsonOrFallback } from '$lib/utils/safe-json';

function _envVar(name: string): string | undefined {
  const v = (privateEnv as Record<string, string | undefined>)[name];
  if (v && v.trim()) return v;
  const p = process.env[name];
  if (p && p.trim()) return p;
  return undefined;
}

function errorMessage(error: unknown, fallback = 'unknown'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

const TICK_MS = 30_000;

function schedulesFile(): string {
  return path.resolve(spawnerStateDir(privateEnv), 'schedules.json');
}

export type ScheduleAction = 'mission' | 'loop';

export interface ScheduleRecord {
  id: string;
  cron: string;
  action: ScheduleAction;
  payload: Record<string, unknown>;
  chatId?: string | null;
  /** IANA timezone the cron fields are evaluated in (e.g. "Europe/Zurich"). Null = server/process timezone (legacy records). */
  timezone?: string | null;
  authority?: {
    source: HarnessAuthorityVerdict['source'];
    reasonCodes: string[];
    traceId?: string;
    origin?: string;
  };
  createdAt: string;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  fireCount: number;
  lastStatus: string | null;
  enabled: boolean;
}

interface StoreShape {
  schedules: ScheduleRecord[];
}

let _store: StoreShape | null = null;
let _tickTimer: NodeJS.Timeout | null = null;
let _starting = false;
const _firingIds = new Set<string>();
let _tickInFlight = false;

function _id(): string {
  return 'sched-' + randomBytes(4).toString('hex');
}

async function _load(): Promise<StoreShape> {
  if (_store) return _store;
  try {
    const raw = await fs.readFile(schedulesFile(), 'utf-8');
    const parsed = parseJsonOrFallback<Partial<StoreShape> | null>(raw, null, 'scheduler-state');
    if (parsed && Array.isArray(parsed.schedules)) {
      _store = { schedules: parsed.schedules };
      return _store;
    }
    await backupCorruptSchedulesFile('unexpected shape');
  } catch (err: unknown) {
    if (errorCode(err) !== 'ENOENT') {
      await backupCorruptSchedulesFile(errorMessage(err, String(err)));
    }
  }
  _store = { schedules: [] };
  return _store;
}

async function backupCorruptSchedulesFile(reason: string): Promise<void> {
  const file = schedulesFile();
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return;
    const backupPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(file, backupPath);
    logger.warn('[scheduler] schedules.json could not be loaded; backed up to', backupPath, 'reason', reason);
  } catch (backupError: unknown) {
    if (errorCode(backupError) !== 'ENOENT') {
      logger.warn('[scheduler] failed to back up schedules.json before reset', errorMessage(backupError));
    }
  }
}

async function _save(): Promise<void> {
  if (!_store) return;
  const file = schedulesFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique tmp name (pid + monotonic counter + random suffix) so concurrent _save calls -
  // e.g. createSchedule and deleteSchedule firing back-to-back, or a tick firing while a
  // delete persists - cannot stomp on each other's `.tmp` file. Sister precedent #281
  // applied the same hardening to mission-control-relay persistState.
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(_store, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, file);
  } catch (renameError) {
    try {
      await fs.copyFile(tmp, file);
      await fs.unlink(tmp);
    } catch (copyError) {
      logger.warn('[scheduler] failed to save schedules.json after rename fallback', errorMessage(copyError));
      throw renameError;
    }
  }
}

/** Returns the trimmed IANA timezone if it is valid, otherwise null. */
export function _validTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz.trim()) return null;
  const trimmed = tz.trim();
  try {
    // Throws RangeError for unknown time zones.
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Next fire time for a cron expression. When `timezone` (an IANA zone) is given
 * the cron fields are evaluated in that zone; otherwise croner uses the server
 * process timezone. Exported for unit testing.
 */
export function _computeNext(cronExpr: string, timezone?: string | null): string | null {
  try {
    const options: { paused: true; timezone?: string } = { paused: true };
    if (timezone) options.timezone = timezone;
    const c = new Cron(cronExpr, options);
    const next = c.nextRun();
    c.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

export async function listSchedules(): Promise<ScheduleRecord[]> {
  const store = await _load();
  return store.schedules.map((s) => ({ ...s }));
}

export async function createSchedule(input: {
  cron: string;
  action: ScheduleAction;
  payload: Record<string, unknown>;
  chatId?: string | null;
  executionAuthority?: unknown;
  timezone?: string | null;
}): Promise<ScheduleRecord> {
  const store = await _load();
  // Distinguish "no timezone provided" (null/empty - legacy server-tz behavior)
  // from "a non-empty string that failed IANA validation" (typo such as
  // "America/NewYork"). Silently dropping the latter to null made the
  // schedule fire in server TZ while the operator believed it was using
  // their zone; reject it with a clear message instead.
  const timezoneProvided = typeof input.timezone === 'string' && input.timezone.trim().length > 0;
  const timezone = _validTimezone(input.timezone);
  if (timezoneProvided && !timezone) {
    throw new Error(`Invalid IANA timezone: ${String(input.timezone).trim()}`);
  }
  const nextFireAt = _computeNext(input.cron, timezone);
  if (!nextFireAt) {
    throw new Error(`Invalid cron expression: ${input.cron}`);
  }
  const authority = assertNativeGovernorHarnessAuthority({
    authority: resolveExecutionAuthority(input.executionAuthority),
    toolName: 'spawner.schedule.create',
    ownerSystem: 'spawner-ui',
    mutationClass: 'creates_schedule'
  });
  const record: ScheduleRecord = {
    id: _id(),
    cron: input.cron,
    action: input.action,
    payload: input.payload,
    chatId: input.chatId ?? null,
    timezone,
    authority: {
      source: authority.source,
      reasonCodes: authority.reasonCodes,
      traceId: authority.traceId,
      origin: authority.origin
    },
    createdAt: new Date().toISOString(),
    lastFiredAt: null,
    nextFireAt,
    fireCount: 0,
    lastStatus: null,
    enabled: true,
  };
  store.schedules.push(record);
  await _save();
  return { ...record };
}

export async function deleteSchedule(input: string | { id: string; executionAuthority?: unknown }): Promise<boolean> {
  const id = typeof input === 'string' ? input : input.id;
  assertNativeGovernorHarnessAuthority({
    authority: resolveExecutionAuthority(typeof input === 'string' ? undefined : input.executionAuthority),
    toolName: 'spawner.schedule.delete',
    ownerSystem: 'spawner-ui',
    mutationClass: 'deletes_schedule'
  });
  const store = await _load();
  const before = store.schedules.length;
  store.schedules = store.schedules.filter((s) => s.id !== id);
  if (store.schedules.length === before) return false;
  await _save();
  return true;
}

async function _fire(record: ScheduleRecord): Promise<{ ok: boolean; summary: string }> {
  if (record.action === 'mission') {
    const goal = String(record.payload.goal ?? '');
    if (!goal) return { ok: false, summary: 'mission has no goal' };
    return {
      ok: false,
      summary: 'scheduled mission fire requires fresh Governor authority; stored schedule authority is evidence only'
    };
  }
  if (record.action === 'loop') {
    const chipKey = String(record.payload.chipKey ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    const rounds = Math.max(1, Number(record.payload.rounds ?? 2));
    if (!chipKey) return { ok: false, summary: 'loop has no chipKey' };
    return {
      ok: false,
      summary: 'scheduled loop fire requires fresh Governor authority; stored schedule authority is evidence only'
    };
  }
  return { ok: false, summary: `unknown action ${record.action}` };
}

async function _relayToTelegram(record: ScheduleRecord, result: { ok: boolean; summary: string }): Promise<void> {
  if (!record.chatId) {
    logger.info('[scheduler] relay skipped: no chatId on', record.id);
    return;
  }
  const token = _envVar('TELEGRAM_BOT_TOKEN') || _envVar('BOT_TOKEN');
  if (!token) {
    logger.info('[scheduler] relay skipped: no TELEGRAM_BOT_TOKEN or BOT_TOKEN in env');
    return;
  }
  const text = _composeScheduleRelayText(record, result);
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: record.chatId, text }),
    });
    const bodyText = await resp.text();
    if (resp.ok) {
      logger.info('[scheduler] relay', record.id, 'status', resp.status, 'body', bodyText.slice(0, 200));
    } else {
      logger.warn('[scheduler] relay', record.id, 'failed HTTP', resp.status, 'body', bodyText.slice(0, 200));
    }
  } catch (err: unknown) {
    logger.warn('[scheduler] relay fetch error on', record.id, errorMessage(err, String(err)));
  }
}

export function _composeScheduleRelayText(
  record: Pick<ScheduleRecord, 'action'>,
  result: { ok: boolean; summary: string }
): string {
  const subject = record.action === 'loop' ? 'loop' : 'mission';
  if (result.summary.includes('requires fresh Governor authority')) {
    return `This scheduled ${subject} is due, but it still needs fresh approval before I can run it.`;
  }
  if (result.ok) {
    return `The scheduled ${subject} finished. You can inspect Spawner if you want the run details.`;
  }
  return `The scheduled ${subject} didn’t make it through. Spawner has the exact failure if you want to inspect it.`;
}

async function _tick(): Promise<void> {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const store = await _load();
    const now = new Date();
    let dirty = false;
    for (const rec of store.schedules) {
      if (!rec.enabled) continue;
      if (!rec.nextFireAt) {
        rec.nextFireAt = _computeNext(rec.cron, rec.timezone);
        dirty = true;
        continue;
      }
      const nextFireMs = Date.parse(rec.nextFireAt);
      if (!Number.isFinite(nextFireMs)) {
        // Stored nextFireAt is non-empty but unparseable (state-file drift /
        // hand edit / older format). Recompute from the cron expression
        // instead of falling through, which would make `new Date(<invalid>)
        // > now` evaluate false (because Invalid Date comparisons always
        // return false) and re-fire the schedule every TICK_MS (~30s)
        // instead of on its cron cadence.
        rec.nextFireAt = _computeNext(rec.cron, rec.timezone);
        dirty = true;
        continue;
      }
      if (nextFireMs > now.getTime()) continue;
      if (_firingIds.has(rec.id)) {
        // Previous fire for this schedule is still in flight (e.g. long subprocess).
        // Skip so we do not relaunch the mission or emit a duplicate relay message.
        continue;
      }
      const nextFireAt = _computeNext(rec.cron, rec.timezone);
      rec.nextFireAt = nextFireAt;
      _firingIds.add(rec.id);
      try {
        const result = await _fire(rec);
        rec.lastFiredAt = new Date().toISOString();
        rec.fireCount += 1;
        rec.lastStatus = (result.ok ? 'ok: ' : 'fail: ') + result.summary.slice(0, 200);
        await _relayToTelegram(rec, result);
      } catch (err: unknown) {
        rec.lastFiredAt = new Date().toISOString();
        rec.fireCount += 1;
        rec.lastStatus = 'crash: ' + errorMessage(err);
      } finally {
        _firingIds.delete(rec.id);
      }
      dirty = true;
    }
    if (dirty) await _save();
  } finally {
    _tickInFlight = false;
  }
}

export function startScheduler(): void {
  if (_tickTimer || _starting) return;
  _starting = true;
  _tick()
    .catch((err) => {
      logger.error('[scheduler] initial tick failed', errorMessage(err));
    })
    .finally(() => {
      _tickTimer = setInterval(() => {
        _tick().catch((err) => {
          logger.error('[scheduler] tick failed', errorMessage(err));
        });
      }, TICK_MS);
      _starting = false;
    });
}

export function stopScheduler(): void {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

export function resetSchedulerForTests(): void {
  stopScheduler();
  _store = null;
  _starting = false;
  _tickInFlight = false;
  _firingIds.clear();
}

export async function runSchedulerTickForTests(): Promise<void> {
  await _tick();
}

export const _schedulerInternalsForTests = {
  fire: _fire,
  relayToTelegram: _relayToTelegram,
  load: _load,
  tick: _tick,
  reset(): void {
    _store = null;
    _tickInFlight = false;
    _firingIds.clear();
    stopScheduler();
  },
};
