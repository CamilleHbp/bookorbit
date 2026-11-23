CREATE TABLE "bulk_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) NOT NULL,
	"requested_by" integer,
	"credential_kind" varchar(10) NOT NULL,
	"api_key_id" integer,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"subject_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" varchar(50),
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"actor_username" varchar(255),
	"actor_ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "bulk_runs_kind_chk" CHECK ("bulk_runs"."kind" in ('book-refresh-metadata', 'book-re-extract-cover', 'book-embed-audio-cover', 'author-refresh-metadata', 'book-move')),
	CONSTRAINT "bulk_runs_status_chk" CHECK ("bulk_runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "bulk_runs_credential_kind_chk" CHECK ("bulk_runs"."credential_kind" in ('session', 'api_key')),
	CONSTRAINT "bulk_runs_counts_nonnegative_chk" CHECK ("bulk_runs"."total" >= 0 and "bulk_runs"."processed" >= 0 and "bulk_runs"."succeeded" >= 0 and "bulk_runs"."failed" >= 0 and "bulk_runs"."skipped" >= 0)
);
--> statement-breakpoint
CREATE TABLE "library_docks" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"folder_name" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"target_folder_id" integer,
	"auto_fetch_metadata" boolean,
	"auto_finalize_enabled" boolean,
	"auto_finalize_threshold" integer,
	"auto_finalize_metadata_mode" varchar(20),
	"auto_join" boolean DEFAULT false NOT NULL,
	"keep_original" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_docks_library_id_unique" UNIQUE("library_id"),
	CONSTRAINT "library_docks_auto_finalize_threshold_chk" CHECK ("library_docks"."auto_finalize_threshold" is null or ("library_docks"."auto_finalize_threshold" >= 50 and "library_docks"."auto_finalize_threshold" <= 100)),
	CONSTRAINT "library_docks_auto_finalize_metadata_mode_chk" CHECK ("library_docks"."auto_finalize_metadata_mode" is null or "library_docks"."auto_finalize_metadata_mode" in ('safe_merge', 'fetched_only', 'embedded_only'))
);
--> statement-breakpoint
CREATE TABLE "book_dock_kept_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"absolute_path" text NOT NULL,
	"file_size" bigint NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"dock_id" integer,
	"book_id" integer,
	"ignored" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_dock_kept_files_absolute_path_unique" UNIQUE("absolute_path")
);
--> statement-breakpoint
CREATE TABLE "book_file_audio_timelines" (
	"file_id" integer PRIMARY KEY NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mtime_ms" double precision NOT NULL,
	"total_seconds" double precision,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_file_audio_timelines_total_seconds_nonnegative_chk" CHECK ("book_file_audio_timelines"."total_seconds" is null or "book_file_audio_timelines"."total_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_answer_cache" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_hash" char(64) NOT NULL,
	"feature" varchar(60) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"answer" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_budget_reservations" (
	"job_id" varchar(64) PRIMARY KEY NOT NULL,
	"feature" varchar(60) NOT NULL,
	"month" varchar(7) NOT NULL,
	"amount_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "ai_budget_reservations_amount_chk" CHECK ("ai_budget_reservations"."amount_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"api_type" varchar(40) NOT NULL,
	"base_url" text NOT NULL,
	"key_encrypted" text,
	"key_hint" varchar(8),
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headers_encrypted" text,
	"network_profile" jsonb,
	"timeout_ms" integer DEFAULT 120000 NOT NULL,
	"max_parallel" integer DEFAULT 8 NOT NULL,
	"requests_per_minute" integer,
	"last_test" jsonb,
	"failing_since" timestamp with time zone,
	"failing_code" varchar(40),
	"failing_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connections_timeout_chk" CHECK ("ai_connections"."timeout_ms" between 10000 and 600000),
	CONSTRAINT "ai_connections_parallel_chk" CHECK ("ai_connections"."max_parallel" between 1 and 32),
	CONSTRAINT "ai_connections_rpm_chk" CHECK ("ai_connections"."requests_per_minute" is null or "ai_connections"."requests_per_minute" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"month" varchar(7) NOT NULL,
	"feature" varchar(60) NOT NULL,
	"slot" varchar(20) NOT NULL,
	"connection_id" integer,
	"model" varchar(200) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"duration_ms" integer NOT NULL,
	"outcome" varchar(60) NOT NULL,
	"job_id" varchar(64),
	"attempt" integer DEFAULT 1 NOT NULL,
	"user_id" integer
);
--> statement-breakpoint
CREATE TABLE "ai_usage_monthly" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" varchar(7) NOT NULL,
	"feature" varchar(60) NOT NULL,
	"slot" varchar(20) NOT NULL,
	"connection_id" integer,
	"model" varchar(200) NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"unknown_cost_requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"feature" varchar(40) NOT NULL,
	"subject_key" varchar(128) NOT NULL,
	"format" smallint NOT NULL,
	"pipeline" varchar(40) NOT NULL,
	"generation" integer NOT NULL,
	"payload" "bytea" NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size" integer NOT NULL,
	"coverage" double precision NOT NULL,
	"models" jsonb,
	"cost_micros" bigint,
	"job_id" uuid,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_artifacts_coverage_chk" CHECK ("ai_artifacts"."coverage" >= 0 and "ai_artifacts"."coverage" <= 1)
);
--> statement-breakpoint
CREATE TABLE "ai_job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" varchar(5) NOT NULL,
	"step" varchar(40),
	"code" varchar(60) NOT NULL,
	"data" jsonb,
	CONSTRAINT "ai_job_events_level_chk" CHECK ("ai_job_events"."level" in ('info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE TABLE "ai_job_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"feature" varchar(40) NOT NULL,
	"subject_key" varchar(128) NOT NULL,
	"step" varchar(40) NOT NULL,
	"unit" varchar(64) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"generation" integer NOT NULL,
	"outcome" varchar(10) DEFAULT 'ok' NOT NULL,
	"skip_reason" varchar(20),
	"result" jsonb,
	"model" varchar(200),
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_job_steps_outcome_chk" CHECK ("ai_job_steps"."outcome" in ('ok', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature" varchar(40) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"subject_key" varchar(128) NOT NULL,
	"subject_ref" jsonb NOT NULL,
	"pipeline" varchar(40) NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"phase" varchar(40),
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"reason" varchar(40),
	"requested_by" integer,
	"lease_owner" varchar(64),
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"models" jsonb,
	"estimate" jsonb,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"cap_raises" smallint DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "ai_jobs_status_chk" CHECK ("ai_jobs"."status" in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ai_jobs_kind_chk" CHECK ("ai_jobs"."kind" in ('build', 'update', 'rebuild')),
	CONSTRAINT "ai_jobs_counts_chk" CHECK ("ai_jobs"."done" >= 0 and "ai_jobs"."total" >= 0 and "ai_jobs"."attempts" >= 0 and "ai_jobs"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ai_step_timings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"feature" varchar(40) NOT NULL,
	"step" varchar(40) NOT NULL,
	"connection_id" integer NOT NULL,
	"model" varchar(200) NOT NULL,
	"effort" varchar(16),
	"units" integer NOT NULL,
	"lanes" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_step_timings_counts_chk" CHECK ("ai_step_timings"."units" > 0 and "ai_step_timings"."lanes" > 0 and "ai_step_timings"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "book_file_texts" (
	"file_id" integer PRIMARY KEY NOT NULL,
	"size_bytes" bigint,
	"mtime" timestamp with time zone,
	"extraction_version" smallint NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"text_key" varchar(64),
	"previous_key" varchar(64),
	"language" varchar(16),
	"words" integer DEFAULT 0 NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_file_texts_outcome_chk" CHECK ("book_file_texts"."outcome" in ('ready', 'unreadable', 'too-large')),
	CONSTRAINT "book_file_texts_ready_key_chk" CHECK ("book_file_texts"."outcome" <> 'ready' or "book_file_texts"."text_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "story_guide_fixes" (
	"text_key" varchar(64) NOT NULL,
	"id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"target" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"from_section" integer,
	"from_offset" integer,
	"client_updated_at" timestamp with time zone NOT NULL,
	"made_at" timestamp with time zone NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"revision" bigserial NOT NULL,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_guide_fixes_text_key_id_pk" PRIMARY KEY("text_key","id"),
	CONSTRAINT "story_guide_fixes_kind_not_empty_chk" CHECK (char_length("story_guide_fixes"."kind") >= 1),
	CONSTRAINT "story_guide_fixes_target_object_chk" CHECK (jsonb_typeof("story_guide_fixes"."target") = 'object'),
	CONSTRAINT "story_guide_fixes_data_object_chk" CHECK (jsonb_typeof("story_guide_fixes"."data") = 'object'),
	CONSTRAINT "story_guide_fixes_from_chk" CHECK (("story_guide_fixes"."from_section" is null and "story_guide_fixes"."from_offset" is null) or ("story_guide_fixes"."from_section" >= 0 and "story_guide_fixes"."from_offset" >= 0))
);
--> statement-breakpoint
ALTER TABLE "book_duplicate_dismissals" DROP CONSTRAINT "book_duplicate_dismissals_kind_chk";--> statement-breakpoint
ALTER TABLE "book_duplicate_groups" DROP CONSTRAINT "book_duplicate_groups_kind_chk";--> statement-breakpoint
ALTER TABLE "book_duplicate_pairs" DROP CONSTRAINT "book_duplicate_pairs_kind_chk";--> statement-breakpoint
ALTER TABLE "book_duplicate_scans" ADD COLUMN "total_other_edition_pairs" integer;--> statement-breakpoint
ALTER TABLE "book_series_memberships" ADD COLUMN "covered_volumes" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "authors" ADD COLUMN "gender" varchar(32);--> statement-breakpoint
ALTER TABLE "book_metadata" ADD COLUMN "original_published_year" integer;--> statement-breakpoint
ALTER TABLE "book_metadata" ADD COLUMN "edition_name" varchar(500);--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD COLUMN "dock_id" integer;--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD COLUMN "former_library_name" varchar(255);--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD COLUMN "hold_reason" varchar(40);--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD COLUMN "hold_detail" jsonb;--> statement-breakpoint
ALTER TABLE "book_request_downloads" ADD COLUMN "failure_code" varchar(30);--> statement-breakpoint
ALTER TABLE "hardcover_user_settings" ADD COLUMN "excluded_library_ids" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "read_aloud_jobs" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_aloud_jobs" ADD COLUMN "user_order" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "read_aloud_jobs" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storygraph_user_settings" ADD COLUMN "excluded_library_ids" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "bulk_runs" ADD CONSTRAINT "bulk_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_runs" ADD CONSTRAINT "bulk_runs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_docks" ADD CONSTRAINT "library_docks_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_docks" ADD CONSTRAINT "library_docks_target_folder_id_library_folders_id_fk" FOREIGN KEY ("target_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_kept_files" ADD CONSTRAINT "book_dock_kept_files_dock_id_library_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."library_docks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_dock_kept_files" ADD CONSTRAINT "book_dock_kept_files_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_file_audio_timelines" ADD CONSTRAINT "book_file_audio_timelines_file_id_book_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_connection_id_ai_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ai_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD CONSTRAINT "ai_artifacts_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_job_events" ADD CONSTRAINT "ai_job_events_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_job_steps" ADD CONSTRAINT "ai_job_steps_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_step_timings" ADD CONSTRAINT "ai_step_timings_connection_id_ai_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ai_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_step_timings" ADD CONSTRAINT "ai_step_timings_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_file_texts" ADD CONSTRAINT "book_file_texts_file_id_book_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_guide_fixes" ADD CONSTRAINT "story_guide_fixes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_runs_status_created_idx" ON "bulk_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "bulk_runs_requested_by_created_idx" ON "bulk_runs" USING btree ("requested_by","created_at" desc);--> statement-breakpoint
CREATE INDEX "bulk_runs_finished_idx" ON "bulk_runs" USING btree ("finished_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "bulk_runs_requested_by_finished_idx" ON "bulk_runs" USING btree ("requested_by","finished_at" desc,"id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "library_docks_folder_name_lower_uidx" ON "library_docks" USING btree (lower("folder_name"));--> statement-breakpoint
CREATE INDEX "library_docks_target_folder_id_idx" ON "library_docks" USING btree ("target_folder_id");--> statement-breakpoint
CREATE INDEX "book_dock_kept_files_dock_id_idx" ON "book_dock_kept_files" USING btree ("dock_id");--> statement-breakpoint
CREATE INDEX "book_dock_kept_files_book_id_idx" ON "book_dock_kept_files" USING btree ("book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_answer_cache_key_uidx" ON "ai_answer_cache" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "ai_answer_cache_accessed_idx" ON "ai_answer_cache" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE INDEX "ai_budget_reservations_month_idx" ON "ai_budget_reservations" USING btree ("month","feature");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_connections_name_lower_uidx" ON "ai_connections" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "ai_usage_month_feature_idx" ON "ai_usage" USING btree ("month","feature");--> statement-breakpoint
CREATE INDEX "ai_usage_month_feature_user_idx" ON "ai_usage" USING btree ("month","feature","user_id") WHERE "ai_usage"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_usage_at_idx" ON "ai_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "ai_usage_job_idx" ON "ai_usage" USING btree ("job_id") WHERE "ai_usage"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_monthly_key_uidx" ON "ai_usage_monthly" USING btree ("month","feature","slot","model",coalesce("connection_id", 0));--> statement-breakpoint
CREATE UNIQUE INDEX "ai_artifacts_subject_uidx" ON "ai_artifacts" USING btree ("feature","subject_key");--> statement-breakpoint
CREATE INDEX "ai_artifacts_job_idx" ON "ai_artifacts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ai_job_events_job_idx" ON "ai_job_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_job_steps_unit_uidx" ON "ai_job_steps" USING btree ("feature","subject_key","step","unit","fingerprint");--> statement-breakpoint
CREATE INDEX "ai_job_steps_subject_generation_idx" ON "ai_job_steps" USING btree ("feature","subject_key","generation");--> statement-breakpoint
CREATE INDEX "ai_job_steps_used_at_idx" ON "ai_job_steps" USING btree ("used_at");--> statement-breakpoint
CREATE INDEX "ai_job_steps_job_idx" ON "ai_job_steps" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_jobs_unfinished_subject_uidx" ON "ai_jobs" USING btree ("feature","subject_key") WHERE "ai_jobs"."status" in ('queued', 'running', 'paused');--> statement-breakpoint
CREATE INDEX "ai_jobs_due_idx" ON "ai_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "ai_jobs_subject_created_idx" ON "ai_jobs" USING btree ("feature","subject_key","created_at" desc);--> statement-breakpoint
CREATE INDEX "ai_jobs_requested_by_idx" ON "ai_jobs" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "ai_jobs_queue_order_idx" ON "ai_jobs" USING btree ("feature","priority" desc,"next_attempt_at","created_at") WHERE "ai_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "ai_jobs_finished_idx" ON "ai_jobs" USING btree ("finished_at" desc);--> statement-breakpoint
CREATE INDEX "ai_jobs_feature_finish_idx" ON "ai_jobs" USING btree ("feature",coalesce("finished_at", "updated_at") desc,"id" desc) WHERE "ai_jobs"."status" in ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "ai_step_timings_key_idx" ON "ai_step_timings" USING btree ("feature","connection_id","model","step","created_at" desc);--> statement-breakpoint
CREATE INDEX "book_file_texts_text_key_idx" ON "book_file_texts" USING btree ("text_key");--> statement-breakpoint
CREATE INDEX "book_file_texts_extraction_version_idx" ON "book_file_texts" USING btree ("extraction_version");--> statement-breakpoint
CREATE INDEX "story_guide_fixes_text_revision_idx" ON "story_guide_fixes" USING btree ("text_key","revision");--> statement-breakpoint
CREATE INDEX "story_guide_fixes_tombstone_idx" ON "story_guide_fixes" USING btree ("updated_at") WHERE "story_guide_fixes"."deleted";--> statement-breakpoint
CREATE INDEX "story_guide_fixes_updated_by_idx" ON "story_guide_fixes" USING btree ("updated_by");--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD CONSTRAINT "book_dock_files_dock_id_library_docks_id_fk" FOREIGN KEY ("dock_id") REFERENCES "public"."library_docks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_merge_jobs_finish_idx" ON "book_merge_jobs" USING btree (coalesce("finished_at", "updated_at") desc,"id" desc) WHERE "book_merge_jobs"."status" in ('done', 'failed', 'rolled_back');--> statement-breakpoint
CREATE INDEX "book_merge_jobs_user_finish_idx" ON "book_merge_jobs" USING btree ("requested_by_user_id",coalesce("finished_at", "updated_at") desc,"id" desc) WHERE "book_merge_jobs"."status" in ('done', 'failed', 'rolled_back');--> statement-breakpoint
CREATE INDEX "authors_name_normalized_key_idx" ON "authors" USING btree (lower(btrim(regexp_replace(replace("name", chr(160), ' '), '[[:space:]]+', ' ', 'g'))));--> statement-breakpoint
CREATE INDEX "bm_original_published_year_idx" ON "book_metadata" USING btree ("original_published_year");--> statement-breakpoint
CREATE INDEX "bm_amazon_id_idx" ON "book_metadata" USING btree ("amazon_id") WHERE "book_metadata"."amazon_id" is not null;--> statement-breakpoint
CREATE INDEX "bm_audible_id_idx" ON "book_metadata" USING btree ("audible_id") WHERE "book_metadata"."audible_id" is not null;--> statement-breakpoint
CREATE INDEX "bm_google_books_id_idx" ON "book_metadata" USING btree ("google_books_id") WHERE "book_metadata"."google_books_id" is not null;--> statement-breakpoint
CREATE INDEX "bm_goodreads_id_idx" ON "book_metadata" USING btree ("goodreads_id") WHERE "book_metadata"."goodreads_id" is not null;--> statement-breakpoint
CREATE INDEX "narrators_name_normalized_key_idx" ON "narrators" USING btree (lower(btrim(regexp_replace(replace("name", chr(160), ' '), '[[:space:]]+', ' ', 'g'))));--> statement-breakpoint
CREATE INDEX "scan_jobs_history_idx" ON "scan_jobs" USING btree (coalesce("completed_at", "started_at") desc,"id" desc) WHERE "scan_jobs"."status" in ('completed', 'failed') and not ("scan_jobs"."status" = 'completed' and "scan_jobs"."triggered_by" <> 'manual' and "scan_jobs"."added_count" = 0 and "scan_jobs"."updated_count" = 0 and "scan_jobs"."missing_count" = 0);--> statement-breakpoint
CREATE INDEX "book_dock_files_dock_id_idx" ON "book_dock_files" USING btree ("dock_id");--> statement-breakpoint
CREATE INDEX "book_requests_fulfiller_user_id_idx" ON "book_requests" USING btree ("fulfiller_user_id");--> statement-breakpoint
CREATE INDEX "kps_user_file_page_start_idx" ON "koreader_page_stats" USING btree ("user_id","book_file_id","page","start_time");--> statement-breakpoint
CREATE INDEX "read_aloud_jobs_user_started_idx" ON "read_aloud_jobs" USING btree ("requested_by_user_id","started_at" desc);--> statement-breakpoint
CREATE INDEX "read_aloud_jobs_user_lane_idx" ON "read_aloud_jobs" USING btree ("requested_by_user_id","user_order") WHERE "read_aloud_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "read_aloud_jobs_finish_idx" ON "read_aloud_jobs" USING btree (coalesce("completed_at", "updated_at") desc,"id" desc) WHERE "read_aloud_jobs"."status" in ('completed', 'completed_with_warnings', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "read_aloud_jobs_user_finish_idx" ON "read_aloud_jobs" USING btree ("requested_by_user_id",coalesce("completed_at", "updated_at") desc,"id" desc) WHERE "read_aloud_jobs"."status" in ('completed', 'completed_with_warnings', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "book_duplicate_dismissals" ADD CONSTRAINT "book_duplicate_dismissals_kind_chk" CHECK ("book_duplicate_dismissals"."kind" in ('duplicate', 'other_format', 'other_edition'));--> statement-breakpoint
ALTER TABLE "book_duplicate_groups" ADD CONSTRAINT "book_duplicate_groups_kind_chk" CHECK ("book_duplicate_groups"."kind" in ('duplicate', 'other_format', 'other_edition'));--> statement-breakpoint
ALTER TABLE "book_duplicate_pairs" ADD CONSTRAINT "book_duplicate_pairs_kind_chk" CHECK ("book_duplicate_pairs"."kind" in ('duplicate', 'other_format', 'other_edition'));--> statement-breakpoint
ALTER TABLE "book_series_memberships" ADD CONSTRAINT "book_series_memberships_covered_volumes_range_chk" CHECK (cardinality("book_series_memberships"."covered_volumes") <= 10000
        AND 0 < ALL("book_series_memberships"."covered_volumes") AND 10000 >= ALL("book_series_memberships"."covered_volumes")
        AND array_position("book_series_memberships"."covered_volumes", NULL) IS NULL);--> statement-breakpoint
ALTER TABLE "authors" ADD CONSTRAINT "authors_gender_chk" CHECK ("authors"."gender" is null or "authors"."gender" in ('female', 'male', 'non_binary'));--> statement-breakpoint
ALTER TABLE "book_metadata" ADD CONSTRAINT "book_metadata_original_published_year_range_chk" CHECK ("book_metadata"."original_published_year" is null or ("book_metadata"."original_published_year" >= 1000 and "book_metadata"."original_published_year" <= 2200));--> statement-breakpoint
ALTER TABLE "book_dock_files" ADD CONSTRAINT "book_dock_files_hold_reason_chk" CHECK ("book_dock_files"."hold_reason" is null or "book_dock_files"."hold_reason" in ('low_confidence', 'no_destination', 'no_folder', 'not_allowed_in_library', 'duplicate', 'destination_conflict', 'unsupported_layout', 'waiting_for_manager'));