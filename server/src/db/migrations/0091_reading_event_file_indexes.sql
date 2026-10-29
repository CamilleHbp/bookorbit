CREATE INDEX "canonical_reading_events_file_idx" ON "canonical_reading_events" USING btree ("book_file_id");--> statement-breakpoint
CREATE INDEX "reading_event_heads_file_idx" ON "reading_event_heads" USING btree ("book_file_id");--> statement-breakpoint
CREATE INDEX "reading_position_acknowledgements_file_idx" ON "reading_position_acknowledgements" USING btree ("book_file_id");