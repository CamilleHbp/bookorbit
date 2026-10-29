ALTER TABLE "revision_publications" ADD COLUMN "owner_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_publications_owner_idx" ON "revision_publications" USING btree ("owner_key");