DROP INDEX "revision_publications_owner_idx";--> statement-breakpoint
ALTER TABLE "revision_publications" ADD COLUMN "owner_settled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "revision_publications_pending_owner_idx" ON "revision_publications" USING btree ("id") WHERE "revision_publications"."owner_key" is not null and "revision_publications"."owner_settled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_publications_owner_idx" ON "revision_publications" USING btree ("owner_key") WHERE "revision_publications"."state" <> 'failed';