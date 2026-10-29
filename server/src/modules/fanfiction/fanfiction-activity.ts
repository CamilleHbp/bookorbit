import type { DatabaseTransaction } from '../../db/transaction';
import { fanfictionActivity } from '../../db/schema';

export async function recordFanfictionActivity(tx: DatabaseTransaction, activity: typeof fanfictionActivity.$inferInsert): Promise<void> {
  await tx.insert(fanfictionActivity).values(activity).onConflictDoNothing({ target: fanfictionActivity.eventKey });
}
