import { BadRequestException } from '@nestjs/common';
import type { FanfictionCookie } from '@bookorbit/types';

const MASK = '********';
const identity = (cookie: FanfictionCookie) => JSON.stringify([cookie.domain.toLowerCase(), cookie.path, cookie.name]);

export function redactFanfictionCookies(cookies: FanfictionCookie[]): FanfictionCookie[] {
  return cookies.map((cookie) => ({ ...cookie, value: cookie.value ? MASK : '' }));
}

export function mergeFanfictionCookies(previous: FanfictionCookie[], incoming?: FanfictionCookie[] | null): FanfictionCookie[] {
  if (incoming == null) return previous.map((cookie) => ({ ...cookie }));
  const saved = new Map(previous.map((cookie) => [identity(cookie), cookie]));
  const seen = new Set<string>();
  const merged = incoming.map((cookie) => {
    const key = identity(cookie);
    if (seen.has(key)) throw new BadRequestException('Cookie names must be unique within each domain and path');
    seen.add(key);
    const old = saved.get(key);
    if (cookie.value === MASK && !old) throw new BadRequestException('Enter a value for a new cookie or a changed cookie domain, name or path');
    return { ...cookie, domain: cookie.domain.toLowerCase(), value: cookie.value === MASK ? old!.value : cookie.value };
  });
  if (Buffer.byteLength(JSON.stringify(merged)) > 1_048_576) throw new BadRequestException('Cookie storage limit exceeded');
  return merged;
}
