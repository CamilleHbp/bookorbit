import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { NotificationType, type FanfictionActivityPage } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { NotificationService } from '../notification/notification.service';
import { UserService } from '../user/user.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { ListFanfictionProfilesDto } from './dto/fanfiction-profile.dto';

const activity = schema.fanfictionActivity;
const notificationTypes = {
  imported: NotificationType.FanfictionImported,
  updated: NotificationType.FanfictionUpdated,
  rolled_back: NotificationType.FanfictionRolledBack,
  attention: NotificationType.FanfictionAttention,
  failed: NotificationType.FanfictionFailed,
};
const titles = {
  imported: 'Story imported',
  updated: 'Story updated',
  rolled_back: 'Story rolled back',
  attention: 'Story source needs attention',
  failed: 'Story operation failed',
};

@Injectable()
export class FanfictionActivityService {
  private readonly logger = new Logger(FanfictionActivityService.name);
  private dispatching = false;
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly users: UserService,
    private readonly notifications: NotificationService,
  ) {}

  async list(libraryId: number, dto: ListFanfictionProfilesDto, user: RequestUser): Promise<FanfictionActivityPage> {
    await this.access.administer(user, libraryId);
    const [before] = dto.cursor
      ? await this.db
          .select({ id: activity.id, createdAt: activity.createdAt })
          .from(activity)
          .where(and(eq(activity.libraryId, libraryId), eq(activity.id, dto.cursor)))
          .limit(1)
      : [];
    if (dto.cursor && !before) throw new NotFoundException('Activity cursor not found in this library');
    const rows = await this.db
      .select({
        id: activity.id,
        libraryId: activity.libraryId,
        sourceId: activity.sourceId,
        jobId: activity.jobId,
        kind: activity.kind,
        title: activity.title,
        bookId: activity.bookId,
        revisionId: activity.revisionId,
        errorCode: activity.errorCode,
        createdAt: activity.createdAt,
      })
      .from(activity)
      .where(
        and(
          eq(activity.libraryId, libraryId),
          before
            ? sql`(${activity.createdAt}, ${activity.id}) < (select ${activity.createdAt}, ${activity.id} from ${activity} where ${activity.id} = ${before.id} and ${activity.libraryId} = ${libraryId})`
            : undefined,
        ),
      )
      .orderBy(desc(activity.createdAt), desc(activity.id))
      .limit(dto.limit + 1);
    const items = rows.slice(0, dto.limit).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return { items, nextCursor: rows.length > dto.limit ? items.at(-1)!.id : null };
  }

  @Interval(5000)
  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    const startedAt = Date.now();
    try {
      const pending = await this.db
        .select({ id: activity.id })
        .from(activity)
        .where(and(isNull(activity.notifiedAt), lte(activity.notificationRunAfter, sql`now()`)))
        .orderBy(asc(activity.notificationRunAfter), asc(activity.id))
        .limit(100);
      if (!pending.length) return;
      this.logger.log(`[fanfiction.activity] [start] pending=${pending.length} - activity notifications started`);
      let delivered = 0;
      for (const entry of pending) {
        try {
          const notification = await this.deliver(entry.id);
          if (notification) {
            this.notifications.emitPersisted(notification);
            delivered++;
          }
        } catch {
          await this.db
            .update(activity)
            .set({
              notificationAttempts: sql`${activity.notificationAttempts} + 1`,
              notificationRunAfter: sql`now() + (least(3600, 30 * power(2, least(${activity.notificationAttempts}, 7))) * interval '1 second')`,
            })
            .where(and(eq(activity.id, entry.id), isNull(activity.notifiedAt)));
        }
      }
      this.logger.log(
        `[fanfiction.activity] [end] durationMs=${Date.now() - startedAt} pending=${pending.length} delivered=${delivered} - activity notifications processed`,
      );
    } catch {
      this.logger.warn(
        `[fanfiction.activity] [fail] durationMs=${Date.now() - startedAt} errorClass=OutboxError - activity notifications will retry`,
      );
    } finally {
      this.dispatching = false;
    }
  }

  private async deliver(id: string) {
    return this.db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(activity)
        .where(and(eq(activity.id, id), isNull(activity.notifiedAt), lte(activity.notificationRunAfter, sql`now()`)))
        .for('update', { skipLocked: true });
      if (!event) return null;
      let allowed = false;
      const user = await this.users.findByIdWithPermissions(event.userId);
      try {
        if (user) {
          await this.access.administer(user, event.libraryId);
          allowed = true;
        }
      } catch (error) {
        if (!(error instanceof ForbiddenException) && !(error instanceof NotFoundException)) throw error;
      }
      const notification = allowed
        ? await this.notifications.persistUserNotification(
            {
              userId: event.userId,
              type: notificationTypes[event.kind],
              title: titles[event.kind],
              message: event.title,
              actionUrl: '/fanfiction',
              meta: { libraryId: event.libraryId, sourceId: event.sourceId, jobId: event.jobId, activityId: event.id, revisionId: event.revisionId },
            },
            tx,
          )
        : null;
      await tx
        .update(activity)
        .set({ notifiedAt: sql`now()` })
        .where(eq(activity.id, id));
      return notification;
    });
  }
}
