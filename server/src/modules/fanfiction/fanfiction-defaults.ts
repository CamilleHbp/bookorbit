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
