import { sql, type SQL } from 'drizzle-orm';

// Multiple sites remain a separate group so one book cannot be selected twice.
export function discoveryWebsite(urls: SQL) {
  return sql<string>`(select case when count(distinct host) = 1 then min(host) else '' end
    from (select substring(value->>'canonicalUrl' from '^https?://(?:www\\.)?([^/:?#]+)') as host
      from jsonb_array_elements(${urls}) where value->>'recognized' = 'true') as recognized_sites)`;
}
