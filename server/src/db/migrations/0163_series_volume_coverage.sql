ALTER TABLE "book_series_memberships" ADD COLUMN "covered_volumes" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "book_series_memberships" ADD CONSTRAINT "book_series_memberships_covered_volumes_range_chk" CHECK (cardinality("book_series_memberships"."covered_volumes") <= 10000
        AND 0 < ALL("book_series_memberships"."covered_volumes") AND 10000 >= ALL("book_series_memberships"."covered_volumes")
        AND array_position("book_series_memberships"."covered_volumes", NULL) IS NULL);