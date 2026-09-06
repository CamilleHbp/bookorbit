CREATE TABLE "book_tag_sources" (
	"book_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	"source_key" varchar(100) NOT NULL,
	CONSTRAINT "book_tag_sources_book_id_tag_id_source_key_pk" PRIMARY KEY("book_id","tag_id","source_key")
);
--> statement-breakpoint
ALTER TABLE "book_tags" ADD COLUMN "managed_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "book_dock_managed_imports" ADD COLUMN "metadata_source_key" varchar(100);--> statement-breakpoint
ALTER TABLE "book_tag_sources" ADD CONSTRAINT "book_tag_sources_book_id_tag_id_book_tags_book_id_tag_id_fk" FOREIGN KEY ("book_id","tag_id") REFERENCES "public"."book_tags"("book_id","tag_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_tag_sources_book_source_idx" ON "book_tag_sources" USING btree ("book_id","source_key");