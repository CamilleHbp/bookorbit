import type { DatabaseTransaction } from '../../db/transaction';

export interface RevisionPublicationAuthority {
  ownerKey: string;
  authorize: (transaction: DatabaseTransaction) => Promise<void>;
}
