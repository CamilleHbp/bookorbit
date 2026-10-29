CREATE TABLE "book_file_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_file_id" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"file_hash" varchar(32) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"reason" varchar(30) NOT NULL,
	"chapters" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_file_revisions_size_chk" CHECK ("book_file_revisions"."size_bytes" >= 0),
	CONSTRAINT "book_file_revisions_reason_chk" CHECK ("book_file_revisions"."reason" in ('baseline', 'external_change', 'file_write', 'fanficfare', 'rollback'))
);
--> statement-breakpoint
ALTER TABLE "book_file_hash_history" DROP CONSTRAINT "book_file_hash_history_reason_chk";--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "current_revision_id" varchar(36);--> statement-breakpoint
ALTER TABLE "book_file_revisions" ADD CONSTRAINT "book_file_revisions_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_file_revisions_file_created_idx" ON "book_file_revisions" USING btree ("book_file_id","created_at","id");--> statement-breakpoint
CREATE INDEX "book_file_revisions_file_sha256_idx" ON "book_file_revisions" USING btree ("book_file_id","sha256");--> statement-breakpoint
ALTER TABLE "book_file_hash_history" ADD CONSTRAINT "book_file_hash_history_reason_chk" CHECK ("book_file_hash_history"."reason" in ('file_write', 'external_change', 'rescan', 'fanficfare', 'rollback'));