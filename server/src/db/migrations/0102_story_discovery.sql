CREATE TABLE "fanfiction_discovery_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"book_file_id" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"title" varchar(500) NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chapter_count" integer NOT NULL,
	"urls" jsonb NOT NULL,
	"state" varchar(20) NOT NULL,
	"error_code" varchar(100),
	"source_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fanfiction_candidates_state_chk" CHECK ("fanfiction_discovery_candidates"."state" in ('pending', 'ambiguous', 'rejected', 'linked', 'failed')),
	CONSTRAINT "fanfiction_candidates_chapters_chk" CHECK ("fanfiction_discovery_candidates"."chapter_count" >= 0 and "fanfiction_discovery_candidates"."chapter_count" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" DROP CONSTRAINT "fanfiction_jobs_kind_chk";--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "discovery" jsonb;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "selection" jsonb;--> statement-breakpoint
ALTER TABLE "fanfiction_discovery_candidates" ADD CONSTRAINT "fanfiction_discovery_candidates_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_discovery_candidates" ADD CONSTRAINT "fanfiction_discovery_candidates_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_discovery_candidates" ADD CONSTRAINT "fanfiction_discovery_candidates_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_discovery_candidates" ADD CONSTRAINT "fanfiction_discovery_candidates_source_id_fanfiction_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."fanfiction_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_candidates_file_revision_idx" ON "fanfiction_discovery_candidates" USING btree ("library_id","book_file_id","sha256");--> statement-breakpoint
CREATE INDEX "fanfiction_candidates_review_idx" ON "fanfiction_discovery_candidates" USING btree ("library_id","state","id");--> statement-breakpoint
CREATE INDEX "fanfiction_candidates_book_idx" ON "fanfiction_discovery_candidates" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "fanfiction_candidates_file_idx" ON "fanfiction_discovery_candidates" USING btree ("book_file_id");--> statement-breakpoint
CREATE INDEX "fanfiction_candidates_source_idx" ON "fanfiction_discovery_candidates" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_jobs_discovery_active_idx" ON "fanfiction_jobs" USING btree ("library_id") WHERE "fanfiction_jobs"."kind" = 'discovery' and "fanfiction_jobs"."state" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_kind_chk" CHECK ("fanfiction_jobs"."kind" in ('preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback'));