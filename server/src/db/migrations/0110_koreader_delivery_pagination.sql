DROP INDEX "koreader_delivery_user_page_idx";--> statement-breakpoint
DROP INDEX "koreader_delivery_copy_page_idx";--> statement-breakpoint
CREATE INDEX "koreader_delivery_copy_restoration_idx" ON "koreader_delivery_jobs" USING btree ("installed_copy_id","installed_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "koreader_delivery_jobs"."installation_state" = 'installed';--> statement-breakpoint
CREATE INDEX "koreader_delivery_user_page_idx" ON "koreader_delivery_jobs" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "koreader_delivery_copy_page_idx" ON "koreader_delivery_jobs" USING btree ("installed_copy_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);