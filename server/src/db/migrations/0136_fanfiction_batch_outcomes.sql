CREATE TABLE "fanfiction_source_batch_items" (
	"batch_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	"child_job_id" uuid,
	"error_code" varchar(100),
	CONSTRAINT "fanfiction_source_batch_items_batch_id_source_id_pk" PRIMARY KEY("batch_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "fanfiction_source_batch_items" ADD CONSTRAINT "fanfiction_source_batch_items_batch_id_fanfiction_jobs_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."fanfiction_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_source_batch_items" ADD CONSTRAINT "fanfiction_source_batch_items_source_id_fanfiction_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."fanfiction_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_source_batch_items" ADD CONSTRAINT "fanfiction_source_batch_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_source_batch_items" ADD CONSTRAINT "fanfiction_source_batch_items_child_job_id_fanfiction_jobs_id_fk" FOREIGN KEY ("child_job_id") REFERENCES "public"."fanfiction_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fanfiction_source_batch_items_child_idx" ON "fanfiction_source_batch_items" USING btree ("child_job_id");--> statement-breakpoint
CREATE INDEX "fanfiction_source_batch_items_source_idx" ON "fanfiction_source_batch_items" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "fanfiction_source_batch_items_user_idx" ON "fanfiction_source_batch_items" USING btree ("user_id");