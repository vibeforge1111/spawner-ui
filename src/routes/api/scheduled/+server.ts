import { json, type RequestEvent } from '@sveltejs/kit';
import { building } from '$app/environment';
import type { RequestHandler } from './$types';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  startScheduler,
  type ScheduleAction,
  type ScheduleRecord,
} from '$lib/server/scheduler';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { HarnessAuthorityError } from '$lib/server/harness-authority';

function scheduledAuth(event: RequestEvent, allowLoopbackWithoutKey = false) {
  return requireControlAuth(event, {
    surface: 'Scheduled',
    apiKeyEnvVar: 'EVENTS_API_KEY',
    fallbackApiKeyEnvVar: 'MCP_API_KEY',
    apiKeyQueryParam: 'apiKey',
    apiKeyCookieName: 'spawner_events_api_key',
    allowLoopbackWithoutKey,
    allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
  });
}

function scheduledReadAuth(event: RequestEvent) {
  const openRead = scheduledAuth(event, true);
  if (openRead) return { openRead, hasControlAuth: false };
  const strictRead = scheduledAuth(event, false);
  return { openRead: null, hasControlAuth: strictRead === null };
}

function sanitizeScheduleForLoopback(schedule: ScheduleRecord): ScheduleRecord {
  return {
    ...schedule,
    payload: {},
    chatId: null,
    authority: schedule.authority
      ? {
          source: schedule.authority.source,
          reasonCodes: schedule.authority.reasonCodes
        }
      : undefined
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

if (!building && process.env.NODE_ENV !== 'test') {
  startScheduler();
}

export const GET: RequestHandler = async (event) => {
  const { openRead, hasControlAuth } = scheduledReadAuth(event);
  if (openRead) return openRead;
  const schedules = await listSchedules();
  return json({ ok: true, schedules: hasControlAuth ? schedules : schedules.map(sanitizeScheduleForLoopback) });
};

export const POST: RequestHandler = async (event) => {
  const unauthorized = scheduledAuth(event);
  if (unauthorized) return unauthorized;
  const { request } = event;
  let body: Record<string, unknown>;
  try {
    body = asRecord(await request.json());
  } catch {
    return json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const action = String(body?.action || '').toLowerCase() as ScheduleAction;
  const cron = String(body?.cron || '').trim();
  const payload = asRecord(body.payload);
  const chatId = body?.chatId ? String(body.chatId) : null;
  const timezone = body?.timezone ? String(body.timezone) : null;
  if (!cron) return json({ ok: false, error: 'cron required' }, { status: 400 });
  if (action !== 'mission' && action !== 'loop') {
    return json({ ok: false, error: "action must be 'mission' or 'loop'" }, { status: 400 });
  }
  try {
    const executionAuthority = body.executionAuthority;
    const record = await createSchedule({ cron, action, payload, chatId, timezone, executionAuthority });
    return json({ ok: true, schedule: record });
  } catch (err: unknown) {
    if (err instanceof HarnessAuthorityError) {
      return json({ ok: false, error: err.message, code: err.code, authority: err.verdict }, { status: err.status });
    }
    return json({ ok: false, error: errorMessage(err, 'create failed') }, { status: 400 });
  }
};

export const DELETE: RequestHandler = async (event) => {
  const unauthorized = scheduledAuth(event);
  if (unauthorized) return unauthorized;
  const { request, url } = event;
  let body: Record<string, unknown> = {};
  try { body = asRecord(await request.json()); } catch {}
  const id = url.searchParams.get('id') || (body?.id ? String(body.id) : '');
  if (!id) return json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const executionAuthority = body.executionAuthority;
    const ok = await deleteSchedule({ id, executionAuthority });
    return json({ ok, error: ok ? undefined : 'not found' });
  } catch (err: unknown) {
    if (err instanceof HarnessAuthorityError) {
      return json({ ok: false, error: err.message, code: err.code, authority: err.verdict }, { status: err.status });
    }
    return json({ ok: false, error: errorMessage(err, 'delete failed') }, { status: 400 });
  }
};
