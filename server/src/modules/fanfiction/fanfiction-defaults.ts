import type { FanfictionProfileDocument } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';

export function withFanfictionDefaults(document: FanfictionProfileDocument, user: RequestUser): FanfictionProfileDocument {
  const isAdult = user.settings?.fanfictionIsAdult;
  if (typeof isAdult !== 'boolean') return document;
  const lines = document.configuration.split(/\r?\n/);
  let inOverrides = false;
  const configuration = lines.filter((line) => {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) inOverrides = header[1] === 'overrides';
    return !inOverrides || !/^is_adult\s*[:=]/i.test(line);
  });
  const index = configuration.findIndex((line) => /^\[overrides\]\s*$/.test(line));
  if (index < 0) configuration.push('[overrides]', `is_adult: ${isAdult}`);
  else configuration.splice(index + 1, 0, `is_adult: ${isAdult}`);
  return { ...document, configuration: configuration.join('\n') };
}

export function configurationMatchesUrl(configuration: string, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const normalize = (host: string) =>
    host
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/^beta\.fiction\.live$/, 'fiction.live')
      .replace(/^m\.fanfiction\.net$/, 'fanfiction.net');
  return [...configuration.matchAll(/^\[([^\]\r\n]+)\][ \t]*$/gm)].some((match) => {
    const section = match[1];
    if (section.startsWith('https://')) {
      try {
        const scoped = new URL(section);
        return (
          scoped.origin === url.origin && (scoped.pathname === url.pathname || url.pathname.startsWith(scoped.pathname.replace(/\/$/, '') + '/'))
        );
      } catch {
        return false;
      }
    }
    return normalize(section) === normalize(url.hostname);
  });
}
