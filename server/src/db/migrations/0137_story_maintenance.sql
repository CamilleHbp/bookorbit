CREATE TABLE "fanfiction_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"site" varchar(255) NOT NULL,
	"document" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"credential_generation" integer DEFAULT 1 NOT NULL,
	"has_password" boolean DEFAULT false NOT NULL,
	"cookie_count" integer DEFAULT 0 NOT NULL,
	"last_successful_at" timestamp with time zone,
	"error_code" varchar(100),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD COLUMN "access_mode" varchar(20) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "maintainer_user_id" integer;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "updates_enabled" boolean;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "update_policy" varchar(20) DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "access_mode" varchar(20) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "metadata_review_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_connections" ADD CONSTRAINT "fanfiction_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_connections_user_site_idx" ON "fanfiction_connections" USING btree ("user_id","site");--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_maintainer_user_id_users_id_fk" FOREIGN KEY ("maintainer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fanfiction_sources_maintainer_site_idx" ON "fanfiction_sources" USING btree ("maintainer_user_id","site","library_id");