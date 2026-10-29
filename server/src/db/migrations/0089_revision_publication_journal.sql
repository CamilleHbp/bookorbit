CREATE TABLE "revision_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"book_file_id" integer NOT NULL,
	"library_id" integer NOT NULL,
	"expected_revision_id" uuid NOT NULL,
	"next_revision_id" uuid NOT NULL,
	"target_path" varchar(4096) NOT NULL,
	"staged_path" varchar(4096) NOT NULL,
	"backup_path" varchar(4096) NOT NULL,
	"previous_sha256" varchar(64) NOT NULL,
	"next_sha256" varchar(64) NOT NULL,
	"next_file_hash" varchar(32) NOT NULL,
	"next_size_bytes" bigint NOT NULL,
	"manifest" jsonb NOT NULL,
	"reason" varchar(30) NOT NULL,
	"state" varchar(30) DEFAULT 'prepared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_publications_state_chk" CHECK ("revision_publications"."state" in ('prepared', 'filesystem_published', 'database_committed', 'cleanup_complete', 'failed')),
	CONSTRAINT "revision_publications_reason_chk" CHECK ("revision_publications"."reason" in ('fanficfare', 'rollback')),
	CONSTRAINT "revision_publications_size_chk" CHECK ("revision_publications"."next_size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "book_file_revisions" ADD COLUMN "storage_path" varchar(4096);--> statement-breakpoint
ALTER TABLE "revision_publications" ADD CONSTRAINT "revision_publications_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_publications" ADD CONSTRAINT "revision_publications_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_publications_active_file_idx" ON "revision_publications" USING btree ("book_file_id") WHERE "revision_publications"."state" in ('prepared', 'filesystem_published');--> statement-breakpoint
CREATE INDEX "revision_publications_recovery_idx" ON "revision_publications" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE INDEX "revision_publications_library_file_idx" ON "revision_publications" USING btree ("library_id","book_file_id","created_at");