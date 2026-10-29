ALTER TABLE "fanfiction_jobs" DROP CONSTRAINT "fanfiction_jobs_profile_id_fanfiction_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "fanfiction_sources" DROP CONSTRAINT "fanfiction_sources_profile_id_fanfiction_profiles_id_fk";
--> statement-breakpoint
DROP INDEX "fanfiction_jobs_profile_idx";--> statement-breakpoint
DROP INDEX "fanfiction_sources_profile_idx";--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ALTER COLUMN "updates_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ALTER COLUMN "updates_enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fanfiction_sources" ALTER COLUMN "update_policy" SET DEFAULT 'safe';--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "fanfiction_jobs" DROP COLUMN "access_mode";--> statement-breakpoint
ALTER TABLE "fanfiction_sources" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "fanfiction_sources" DROP COLUMN "access_mode";