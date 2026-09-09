import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { FanfictionCookie } from '@bookorbit/types';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FanfictionCookieDto } from './dto/fanfiction-profile.dto';

export type FanfictionCookieSink = (cookies: FanfictionCookie[]) => Promise<void>;

const MASK = '********';
const identity = (cookie: FanfictionCookie) => JSON.stringify([cookie.domain.toLowerCase(), cookie.path, cookie.name]);

export function validateRuntimeCookies(value: unknown): FanfictionCookie[] {
  if (!Array.isArray(value) || value.length > 200 || Buffer.byteLength(JSON.stringify(value)) > 480 * 1024)
    throw new ServiceUnavailableException('Invalid runtime cookies');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ServiceUnavailableException('Invalid runtime cookie');
    const cookie = plainToInstance(FanfictionCookieDto, item);
    if (validateSync(cookie, { whitelist: true, forbidNonWhitelisted: true }).length) throw new ServiceUnavailableException('Invalid runtime cookie');
    const key = identity(cookie);
    if (seen.has(key)) throw new ServiceUnavailableException('Duplicate runtime cookie');
    seen.add(key);
    return { ...cookie, domain: cookie.domain.toLowerCase() };
  });
}

export function mergeRenewedCookies(base: FanfictionCookie[], current: FanfictionCookie[], incoming: FanfictionCookie[]): FanfictionCookie[] {
  const before = new Map(base.map((cookie) => [identity(cookie), cookie]));
  const next = new Map(incoming.map((cookie) => [identity(cookie), cookie]));
  const merged = new Map(current.map((cookie) => [identity(cookie), cookie]));
  const evidence = (cookie?: FanfictionCookie) =>
    cookie && JSON.stringify([cookie.value, cookie.secure, cookie.hostOnly ?? !cookie.domain.startsWith('.'), cookie.expires ?? null]);
  for (const key of new Set([...before.keys(), ...next.keys()])) {
    if (evidence(merged.get(key)) !== evidence(before.get(key))) continue;
    const cookie = next.get(key);
    if (cookie) merged.set(key, cookie);
    else merged.delete(key);
  }
  return validateRuntimeCookies([...merged.values()]);
}

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
