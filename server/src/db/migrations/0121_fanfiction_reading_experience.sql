ALTER TABLE "fanfiction_sources" ADD COLUMN "categories" jsonb;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "tag_policy" varchar(20) DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD CONSTRAINT "fanfiction_sources_tag_policy_chk" CHECK ("fanfiction_sources"."tag_policy" in ('review', 'automatic'));