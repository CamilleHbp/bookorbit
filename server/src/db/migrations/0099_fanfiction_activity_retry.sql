DROP INDEX "fanfiction_activity_pending_idx";--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD COLUMN "notification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD COLUMN "notification_run_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "fanfiction_activity_pending_idx" ON "fanfiction_activity" USING btree ("notification_run_after","id") WHERE "fanfiction_activity"."notified_at" is null;