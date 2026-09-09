CREATE TABLE "koreader_delivery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"installed_copy_id" uuid NOT NULL,
	"library_id" integer NOT NULL,
	"revision_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"expected_local_sha256" varchar(64) NOT NULL,
	"expected_local_size_bytes" bigint NOT NULL,
	"pathname" varchar(4096) NOT NULL,
	"mode" varchar(12) NOT NULL,
	"installation_state" varchar(30) DEFAULT 'requested' NOT NULL,
	"restoration_state" varchar(30) DEFAULT 'verification_pending' NOT NULL,
	"failure_code" varchar(40),
	"restoration_failure_code" varchar(80),
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"claim_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"report_sequence" bigint DEFAULT 0 NOT NULL,
	"report_hash" varchar(64),
	"publication_token" uuid,
	"publication_expires_at" timestamp with time zone,
	"installed_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "koreader_delivery_installation_chk" CHECK ("koreader_delivery_jobs"."installation_state" in ('requested', 'waiting_for_uploads', 'waiting_for_close', 'downloading', 'installed')),
	CONSTRAINT "koreader_delivery_restoration_chk" CHECK ("koreader_delivery_jobs"."restoration_state" in ('verification_pending', 'verified', 'approximate', 'failed')),
	CONSTRAINT "koreader_delivery_mode_chk" CHECK ("koreader_delivery_jobs"."mode" in ('manual', 'automatic')),
	CONSTRAINT "koreader_delivery_identity_chk" CHECK ("koreader_delivery_jobs"."sha256" ~ '^[a-f0-9]{64}$' and "koreader_delivery_jobs"."expected_local_sha256" ~ '^[a-f0-9]{64}$' and "koreader_delivery_jobs"."size_bytes" >= 0 and "koreader_delivery_jobs"."expected_local_size_bytes" >= 0),
	CONSTRAINT "koreader_delivery_counter_chk" CHECK ("koreader_delivery_jobs"."version" > 0 and "koreader_delivery_jobs"."attempt" > 0 and "koreader_delivery_jobs"."fence" >= 0 and "koreader_delivery_jobs"."report_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "koreader_delivery_jobs" ADD CONSTRAINT "koreader_delivery_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "koreader_delivery_jobs" ADD CONSTRAINT "koreader_delivery_jobs_installed_copy_id_koreader_installed_copies_id_fk" FOREIGN KEY ("installed_copy_id") REFERENCES "public"."koreader_installed_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "koreader_delivery_jobs" ADD CONSTRAINT "koreader_delivery_jobs_revision_id_book_file_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."book_file_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "koreader_delivery_revision_idx" ON "koreader_delivery_jobs" USING btree ("user_id","installed_copy_id","revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "koreader_delivery_request_idx" ON "koreader_delivery_jobs" USING btree ("user_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "koreader_delivery_active_copy_idx" ON "koreader_delivery_jobs" USING btree ("installed_copy_id") WHERE "koreader_delivery_jobs"."cancelled_at" is null and "koreader_delivery_jobs"."failure_code" is null and "koreader_delivery_jobs"."installation_state" <> 'installed';--> statement-breakpoint
CREATE INDEX "koreader_delivery_user_page_idx" ON "koreader_delivery_jobs" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "koreader_delivery_copy_page_idx" ON "koreader_delivery_jobs" USING btree ("installed_copy_id","id");--> statement-breakpoint
CREATE INDEX "koreader_delivery_revision_fk_idx" ON "koreader_delivery_jobs" USING btree ("revision_id");