ALTER TABLE "book_file_revisions" ADD COLUMN "manifest_version" integer;--> statement-breakpoint
ALTER TABLE "book_file_revisions" ADD COLUMN "content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "book_file_revisions" ADD COLUMN "metadata_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "book_file_revisions" ADD COLUMN "cover_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "book_file_revisions" ADD COLUMN "change_kind" varchar(20) DEFAULT 'unknown' NOT NULL;