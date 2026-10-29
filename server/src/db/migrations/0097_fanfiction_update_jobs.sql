ALTER TABLE "fanfiction_jobs" ADD COLUMN "source_version" integer;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "expected_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "scheduled" boolean DEFAULT false NOT NULL;