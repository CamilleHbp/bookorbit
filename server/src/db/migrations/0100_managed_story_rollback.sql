ALTER TABLE "fanfiction_activity" DROP CONSTRAINT "fanfiction_activity_kind_chk";--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "rollback_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_kind_chk" CHECK ("fanfiction_activity"."kind" in ('imported', 'updated', 'rolled_back', 'attention', 'failed'));