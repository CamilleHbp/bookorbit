CREATE TABLE "fanfiction_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"folder_id" integer,
	"profile_id" uuid,
	"book_id" integer,
	"book_file_id" integer,
	"canonical_url" text NOT NULL,
	"canonical_key" varchar(64) NOT NULL,
	"site" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" varchar(30) DEFAULT 'pending' NOT NULL,
	"chapter_count" integer DEFAULT 0 NOT NULL,
	"word_count" integer,
	"story_status" varchar(100) DEFAULT '' NOT NULL,
	"interval_minutes" integer DEFAULT 1440,
	"next_check_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_updated_at" timestamp with time zone,
	"attention_code" varchar(100),
	"import_operation_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fanfiction_sources_import_operation_id_unique" UNIQUE("import_operation_id"),
	CONSTRAINT "fanfiction_sources_state_chk" CHECK ("fanfiction_sources"."state" in ('pending', 'active', 'paused', 'review_required', 'configuration_blocked', 'unlinked')),
	CONSTRAINT "fanfiction_sources_interval_chk" CHECK ("fanfiction_sources"."interval_minutes" is null or "fanfiction_sources"."interval_minutes" >= 60),
	CONSTRAINT "fanfiction_sources_chapters_chk" CHECK ("fanfiction_sources"."chapter_count" >= 0 and ("fanfiction_sources"."word_count" is null or "fanfiction_sources"."word_count" >= 0))
);
--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_folder_id_library_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_profile_id_fanfiction_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."fanfiction_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_sources_identity_idx" ON "fanfiction_sources" USING btree ("library_id","canonical_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_sources_file_idx" ON "fanfiction_sources" USING btree ("book_file_id") WHERE "fanfiction_sources"."state" <> 'unlinked';--> statement-breakpoint
CREATE INDEX "fanfiction_sources_list_idx" ON "fanfiction_sources" USING btree ("library_id","created_at","id");--> statement-breakpoint
CREATE INDEX "fanfiction_sources_schedule_idx" ON "fanfiction_sources" USING btree ("state","next_check_at","id");--> statement-breakpoint
CREATE INDEX "fanfiction_sources_user_idx" ON "fanfiction_sources" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "fanfiction_sources_folder_idx" ON "fanfiction_sources" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "fanfiction_sources_profile_idx" ON "fanfiction_sources" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "fanfiction_sources_book_idx" ON "fanfiction_sources" USING btree ("book_id");--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_source_id_fanfiction_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."fanfiction_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_jobs_active_source_idx" ON "fanfiction_jobs" USING btree ("source_id") WHERE "fanfiction_jobs"."source_id" is not null and "fanfiction_jobs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "fanfiction_jobs_source_idx" ON "fanfiction_jobs" USING btree ("source_id");