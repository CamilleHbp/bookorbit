CREATE TABLE "fanfiction_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"source_id" uuid,
	"job_id" uuid,
	"event_key" varchar(100) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"title" varchar(500) NOT NULL,
	"book_id" integer,
	"revision_id" uuid,
	"error_code" varchar(100),
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fanfiction_activity_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "fanfiction_activity_kind_chk" CHECK ("fanfiction_activity"."kind" in ('imported', 'updated', 'attention', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_source_id_fanfiction_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."fanfiction_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_job_id_fanfiction_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."fanfiction_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_activity" ADD CONSTRAINT "fanfiction_activity_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fanfiction_activity_library_idx" ON "fanfiction_activity" USING btree ("library_id","created_at","id");--> statement-breakpoint
CREATE INDEX "fanfiction_activity_pending_idx" ON "fanfiction_activity" USING btree ("created_at","id") WHERE "fanfiction_activity"."notified_at" is null;--> statement-breakpoint
CREATE INDEX "fanfiction_activity_user_idx" ON "fanfiction_activity" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fanfiction_activity_source_idx" ON "fanfiction_activity" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "fanfiction_activity_job_idx" ON "fanfiction_activity" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "fanfiction_activity_book_idx" ON "fanfiction_activity" USING btree ("book_id");