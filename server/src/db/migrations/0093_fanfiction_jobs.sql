CREATE TABLE "fanfiction_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"token_version" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"profile_id" uuid,
	"kind" varchar(20) NOT NULL,
	"state" varchar(30) DEFAULT 'queued' NOT NULL,
	"url" text NOT NULL,
	"site" varchar(255) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"cancellation_requested" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fanfiction_jobs_attempts_chk" CHECK ("fanfiction_jobs"."attempts" >= 0 and "fanfiction_jobs"."fence" >= 0),
	CONSTRAINT "fanfiction_jobs_kind_chk" CHECK ("fanfiction_jobs"."kind" in ('preview', 'discovery', 'import', 'update', 'refresh', 'rollback')),
	CONSTRAINT "fanfiction_jobs_state_chk" CHECK ("fanfiction_jobs"."state" in ('queued', 'running', 'succeeded', 'no_change', 'review_required', 'configuration_blocked', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" ADD CONSTRAINT "fanfiction_jobs_profile_id_fanfiction_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."fanfiction_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fanfiction_jobs_request_idx" ON "fanfiction_jobs" USING btree ("library_id","user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fanfiction_jobs_queue_idx" ON "fanfiction_jobs" USING btree ("state","run_after","id");--> statement-breakpoint
CREATE INDEX "fanfiction_jobs_lease_idx" ON "fanfiction_jobs" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "fanfiction_jobs_library_created_idx" ON "fanfiction_jobs" USING btree ("library_id","created_at","id");--> statement-breakpoint
CREATE INDEX "fanfiction_jobs_user_idx" ON "fanfiction_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fanfiction_jobs_profile_idx" ON "fanfiction_jobs" USING btree ("profile_id");