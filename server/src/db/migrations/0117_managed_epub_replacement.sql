CREATE TABLE "book_dock_managed_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dock_file_id" integer,
	"library_id" integer,
	"user_id" integer,
	"owner_key" uuid,
	"state" varchar(20) DEFAULT 'uploading' NOT NULL,
	"sha256" varchar(64),
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_dock_managed_uploads_state_chk" CHECK ("book_dock_managed_uploads"."state" in ('uploading', 'ready', 'claimed')),
	CONSTRAINT "book_dock_managed_uploads_size_chk" CHECK ("book_dock_managed_uploads"."size_bytes" >= 0 and "book_dock_managed_uploads"."size_bytes" <= 134217728),
	CONSTRAINT "book_dock_managed_uploads_hash_chk" CHECK ("book_dock_managed_uploads"."sha256" is null or "book_dock_managed_uploads"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" DROP CONSTRAINT "fanfiction_jobs_kind_chk";--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "replacement_upload_id" uuid;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "replacement_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "replacement_reduction_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "book_dock_managed_uploads" ADD CONSTRAINT "book_dock_managed_uploads_dock_file_id_book_dock_files_id_fk" FOREIGN KEY ("dock_file_id") REFERENCES "public"."book_dock_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_managed_uploads" ADD CONSTRAINT "book_dock_managed_uploads_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_managed_uploads" ADD CONSTRAINT "book_dock_managed_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_dock_managed_uploads_expiry_idx" ON "book_dock_managed_uploads" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_uploads_user_idx" ON "book_dock_managed_uploads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_uploads_library_idx" ON "book_dock_managed_uploads" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_uploads_dock_idx" ON "book_dock_managed_uploads" USING btree ("dock_file_id");--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_kind_chk" CHECK ("fanfiction_jobs"."kind" in ('preview', 'discovery', 'adopt', 'import', 'update', 'refresh', 'rollback', 'source_batch', 'replacement'));