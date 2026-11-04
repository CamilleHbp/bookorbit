CREATE TABLE "book_genre_sources" (
	"book_id" integer NOT NULL,
	"genre_id" integer NOT NULL,
	"source_key" varchar(100) NOT NULL,
	CONSTRAINT "book_genre_sources_book_id_genre_id_source_key_pk" PRIMARY KEY("book_id","genre_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "library_tag_rulebooks" (
	"library_id" integer PRIMARY KEY NOT NULL,
	"rulebook_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_matching_exclusions" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"tag_id" integer,
	"genre_id" integer,
	CONSTRAINT "tag_match_exclusion_one_chk" CHECK (num_nonnulls("tag_matching_exclusions"."tag_id","tag_matching_exclusions"."genre_id")=1)
);
--> statement-breakpoint
CREATE TABLE "tag_matching_job_items" (
	"job_id" uuid NOT NULL,
	"book_id" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"change" jsonb NOT NULL,
	"override_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	CONSTRAINT "tag_matching_job_items_job_id_book_id_pk" PRIMARY KEY("job_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "tag_matching_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"rulebook_id" integer NOT NULL,
	"version" integer NOT NULL,
	"state" varchar(20) DEFAULT 'previewing' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_matching_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"source_key" varchar(100) NOT NULL,
	"rulebook_id" integer NOT NULL,
	"source" varchar(200) NOT NULL,
	"field" varchar(20) NOT NULL,
	"key" varchar(1000) NOT NULL,
	"value" varchar(500) NOT NULL,
	"status" varchar(12) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_matching_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rulebook_id" integer NOT NULL,
	"source" varchar(200) DEFAULT '' NOT NULL,
	"field" varchar(20) NOT NULL,
	"value" varchar(500) NOT NULL,
	"key" varchar(1000) NOT NULL,
	"action" varchar(10) NOT NULL,
	CONSTRAINT "tag_match_rule_action_chk" CHECK ("tag_matching_rules"."action" in ('match','ignore')),
	CONSTRAINT "tag_match_rule_field_chk" CHECK ("tag_matching_rules"."field" in ('tags','genres','fandoms','characters','relationships','warnings','rating'))
);
--> statement-breakpoint
CREATE TABLE "tag_matching_snapshots" (
	"book_id" integer NOT NULL,
	"source_key" varchar(100) NOT NULL,
	"source" varchar(200) NOT NULL,
	"user_id" integer NOT NULL,
	"rulebook_id" integer NOT NULL,
	"version" integer NOT NULL,
	"labels" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_matching_snapshots_book_id_source_key_pk" PRIMARY KEY("book_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "tag_matching_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"tag_id" integer,
	"genre_id" integer,
	CONSTRAINT "tag_match_target_one_chk" CHECK (num_nonnulls("tag_matching_targets"."tag_id","tag_matching_targets"."genre_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "tag_rulebooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_rulebooks_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "book_genres" ADD COLUMN "managed_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "book_genre_sources" ADD CONSTRAINT "book_genre_sources_book_id_genre_id_book_genres_book_id_genre_id_fk" FOREIGN KEY ("book_id","genre_id") REFERENCES "public"."book_genres"("book_id","genre_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_tag_rulebooks" ADD CONSTRAINT "library_tag_rulebooks_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_tag_rulebooks" ADD CONSTRAINT "library_tag_rulebooks_rulebook_id_tag_rulebooks_id_fk" FOREIGN KEY ("rulebook_id") REFERENCES "public"."tag_rulebooks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_exclusions" ADD CONSTRAINT "tag_matching_exclusions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_exclusions" ADD CONSTRAINT "tag_matching_exclusions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_exclusions" ADD CONSTRAINT "tag_matching_exclusions_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_exclusions" ADD CONSTRAINT "tag_matching_exclusions_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_job_items" ADD CONSTRAINT "tag_matching_job_items_job_id_tag_matching_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."tag_matching_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_job_items" ADD CONSTRAINT "tag_matching_job_items_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_jobs" ADD CONSTRAINT "tag_matching_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_jobs" ADD CONSTRAINT "tag_matching_jobs_rulebook_id_tag_rulebooks_id_fk" FOREIGN KEY ("rulebook_id") REFERENCES "public"."tag_rulebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_observations" ADD CONSTRAINT "tag_matching_observations_rulebook_id_tag_rulebooks_id_fk" FOREIGN KEY ("rulebook_id") REFERENCES "public"."tag_rulebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_observations" ADD CONSTRAINT "tag_matching_observations_book_id_source_key_tag_matching_snapshots_book_id_source_key_fk" FOREIGN KEY ("book_id","source_key") REFERENCES "public"."tag_matching_snapshots"("book_id","source_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_rules" ADD CONSTRAINT "tag_matching_rules_rulebook_id_tag_rulebooks_id_fk" FOREIGN KEY ("rulebook_id") REFERENCES "public"."tag_rulebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_snapshots" ADD CONSTRAINT "tag_matching_snapshots_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_snapshots" ADD CONSTRAINT "tag_matching_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_snapshots" ADD CONSTRAINT "tag_matching_snapshots_rulebook_id_tag_rulebooks_id_fk" FOREIGN KEY ("rulebook_id") REFERENCES "public"."tag_rulebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_targets" ADD CONSTRAINT "tag_matching_targets_rule_id_tag_matching_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."tag_matching_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_targets" ADD CONSTRAINT "tag_matching_targets_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_matching_targets" ADD CONSTRAINT "tag_matching_targets_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_rulebooks" ADD CONSTRAINT "tag_rulebooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_genre_sources_book_source_idx" ON "book_genre_sources" USING btree ("book_id","source_key");--> statement-breakpoint
CREATE INDEX "library_tag_rulebook_idx" ON "library_tag_rulebooks" USING btree ("rulebook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_match_exclusion_tag_idx" ON "tag_matching_exclusions" USING btree ("book_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_match_exclusion_genre_idx" ON "tag_matching_exclusions" USING btree ("book_id","genre_id");--> statement-breakpoint
CREATE INDEX "tag_match_exclusion_user_idx" ON "tag_matching_exclusions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tag_match_job_owner_idx" ON "tag_matching_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_match_observation_key_idx" ON "tag_matching_observations" USING btree ("book_id","source_key","field","key");--> statement-breakpoint
CREATE INDEX "tag_match_observation_review_idx" ON "tag_matching_observations" USING btree ("rulebook_id","status","source","field");--> statement-breakpoint
CREATE INDEX "tag_match_observation_lookup_idx" ON "tag_matching_observations" USING btree ("rulebook_id","field","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_match_rule_key_idx" ON "tag_matching_rules" USING btree ("rulebook_id","source","field","key");--> statement-breakpoint
CREATE INDEX "tag_match_snapshots_owner_idx" ON "tag_matching_snapshots" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "tag_match_snapshots_rulebook_idx" ON "tag_matching_snapshots" USING btree ("rulebook_id","book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_match_target_tag_idx" ON "tag_matching_targets" USING btree ("rule_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_match_target_genre_idx" ON "tag_matching_targets" USING btree ("rule_id","genre_id");--> statement-breakpoint
CREATE INDEX "tag_match_target_tag_reverse_idx" ON "tag_matching_targets" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tag_match_target_genre_reverse_idx" ON "tag_matching_targets" USING btree ("genre_id");