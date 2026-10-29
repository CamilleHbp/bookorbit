CREATE TABLE "book_dock_managed_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"folder_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"dock_file_id" integer NOT NULL,
	"state" varchar(32) DEFAULT 'reserved' NOT NULL,
	"file_name" text NOT NULL,
	"source_path" text NOT NULL,
	"dock_path" text NOT NULL,
	"library_root" text NOT NULL,
	"destination_path" text NOT NULL,
	"book_folder_path" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"book_id" integer,
	"book_file_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_dock_managed_imports_dock_file_id_unique" UNIQUE("dock_file_id"),
	CONSTRAINT "book_dock_managed_imports_destination_path_unique" UNIQUE("destination_path"),
	CONSTRAINT "book_dock_managed_imports_state_chk" CHECK ("book_dock_managed_imports"."state" in ('reserved', 'prepared', 'filesystem_published', 'database_committed', 'metadata_committed', 'cleanup_complete'))
);
--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD COLUMN "ingestion_mode" varchar(20) DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "book_dock_managed_imports" ADD CONSTRAINT "book_dock_managed_imports_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_managed_imports" ADD CONSTRAINT "book_dock_managed_imports_folder_id_library_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."library_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_managed_imports" ADD CONSTRAINT "book_dock_managed_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_managed_imports" ADD CONSTRAINT "book_dock_managed_imports_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_managed_imports" ADD CONSTRAINT "book_dock_managed_imports_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_dock_managed_imports_library_idx" ON "book_dock_managed_imports" USING btree ("library_id","id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_imports_folder_idx" ON "book_dock_managed_imports" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_imports_user_idx" ON "book_dock_managed_imports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_imports_book_idx" ON "book_dock_managed_imports" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_dock_managed_imports_file_idx" ON "book_dock_managed_imports" USING btree ("book_file_id");--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD CONSTRAINT "book_dock_files_ingestion_mode_chk" CHECK ("book_dock_files"."ingestion_mode" in ('standard', 'managed'));