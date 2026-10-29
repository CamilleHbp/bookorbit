CREATE TABLE "fanfiction_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"created_by" integer,
	"name" varchar(120) NOT NULL,
	"document" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fanfiction_profiles" ADD CONSTRAINT "fanfiction_profiles_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fanfiction_profiles" ADD CONSTRAINT "fanfiction_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fanfiction_profiles_library_id_idx" ON "fanfiction_profiles" USING btree ("library_id","id");--> statement-breakpoint
CREATE INDEX "fanfiction_profiles_created_by_idx" ON "fanfiction_profiles" USING btree ("created_by");