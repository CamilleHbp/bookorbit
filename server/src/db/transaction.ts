import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

export type DatabaseTransaction = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];
