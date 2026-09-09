CREATE TABLE "fanfiction_source_batch_failures" (
	"job_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"error_code" varchar(100) NOT NULL,
	CONSTRAINT "fanfiction_source_batch_failures_job_id_source_id_pk" PRIMARY KEY("job_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "fanfiction_activity" DROP CONSTRAINT "fanfiction_activity_kind_chk";--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" DROP CONSTRAINT "fanfiction_jobs_kind_chk";--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "source_selection" jsonb;--> statement-breakpoint
ALTER TABLE "fanfiction_source_batch_failures" ADD CONSTRAINT "fanfiction_source_batch_failures_job_id_fanfiction_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."fanfiction_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_source_batch_failures" ADD CONSTRAINT "fanfiction_source_batch_failures_source_id_fanfiction_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."fanfiction_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fanfiction_source_batch_failures_source_idx" ON "fanfiction_source_batch_failures" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_kind_chk" CHECK ("fanfiction_activity"."kind" in ('imported', 'updated', 'rolled_back', 'attention', 'failed', 'batch_completed'));--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_kind_chk" CHECK ("fanfiction_jobs"."kind" in ('preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch'));