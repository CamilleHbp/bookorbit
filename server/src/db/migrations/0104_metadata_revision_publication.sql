ALTER TABLE "revision_publications" DROP CONSTRAINT "revision_publications_reason_chk";--> statement-breakpoint
ALTER TABLE "revision_publications" ADD COLUMN "expected_book_id" integer;--> statement-breakpoint
ALTER TABLE "revision_publications" ADD CONSTRAINT "revision_publications_reason_chk" CHECK ("revision_publications"."reason" in ('fanficfare', 'rollback', 'file_write'));