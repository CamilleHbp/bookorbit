ALTER TABLE "fanfiction_sources" ADD COLUMN "raw_labels" jsonb;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ADD COLUMN "label_mapping_version" integer;