CREATE TABLE "canonical_reading_events" (
	"user_id" integer NOT NULL,
	"book_file_id" integer NOT NULL,
	"id" uuid NOT NULL,
	"device_id" varchar(128) NOT NULL,
	"device_sequence" bigint NOT NULL,
	"reset_generation" bigint NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"anchor" jsonb NOT NULL,
	CONSTRAINT "canonical_reading_events_user_id_book_file_id_id_pk" PRIMARY KEY("user_id","book_file_id","id"),
	CONSTRAINT "canonical_reading_events_sequence_chk" CHECK ("canonical_reading_events"."device_sequence" >= 0 and "canonical_reading_events"."device_sequence" <= 9007199254740991),
	CONSTRAINT "canonical_reading_events_generation_chk" CHECK ("canonical_reading_events"."reset_generation" >= 0 and "canonical_reading_events"."reset_generation" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "reading_event_heads" (
	"user_id" integer NOT NULL,
	"book_file_id" integer NOT NULL,
	"reset_generation" bigint DEFAULT 0 NOT NULL,
	"event_id" uuid,
	CONSTRAINT "reading_event_heads_user_id_book_file_id_pk" PRIMARY KEY("user_id","book_file_id"),
	CONSTRAINT "reading_event_heads_generation_chk" CHECK ("reading_event_heads"."reset_generation" >= 0 and "reading_event_heads"."reset_generation" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "reading_position_acknowledgements" (
	"user_id" integer NOT NULL,
	"book_file_id" integer NOT NULL,
	"device_id" varchar(128) NOT NULL,
	"copy_id" uuid NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	CONSTRAINT "reading_position_acknowledgements_user_id_book_file_id_device_id_copy_id_pk" PRIMARY KEY("user_id","book_file_id","device_id","copy_id")
);
--> statement-breakpoint
ALTER TABLE "canonical_reading_events" ADD CONSTRAINT "canonical_reading_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_reading_events" ADD CONSTRAINT "canonical_reading_events_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_event_heads" ADD CONSTRAINT "reading_event_heads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_event_heads" ADD CONSTRAINT "reading_event_heads_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_position_acknowledgements" ADD CONSTRAINT "reading_position_acknowledgements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_position_acknowledgements" ADD CONSTRAINT "reading_position_acknowledgements_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_reading_events_device_sequence_idx" ON "canonical_reading_events" USING btree ("user_id","book_file_id","device_id","reset_generation","device_sequence");