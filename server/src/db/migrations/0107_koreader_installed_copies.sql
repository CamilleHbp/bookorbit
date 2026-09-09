CREATE TABLE "koreader_delivery_devices" (
	"user_id" integer NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"plugin_version" varchar(64) NOT NULL,
	"contact_sequence" bigint DEFAULT 0 NOT NULL,
	"delivery_capability_version" integer DEFAULT 0 NOT NULL,
	"position_capability_version" integer DEFAULT 0 NOT NULL,
	"policy" varchar(20) DEFAULT 'notify' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"last_contact_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "koreader_delivery_devices_user_id_device_id_pk" PRIMARY KEY("user_id","device_id"),
	CONSTRAINT "koreader_delivery_devices_policy_chk" CHECK ("koreader_delivery_devices"."policy" in ('notify', 'automatic', 'ignore')),
	CONSTRAINT "koreader_delivery_devices_versions_chk" CHECK ("koreader_delivery_devices"."policy_version" > 0 and "koreader_delivery_devices"."contact_sequence" >= 0 and "koreader_delivery_devices"."delivery_capability_version" >= 0 and "koreader_delivery_devices"."position_capability_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "koreader_installed_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"copy_id" uuid NOT NULL,
	"book_file_id" integer NOT NULL,
	"pathname" varchar(4096) NOT NULL,
	"pathname_hash" varchar(64) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"revision_id" uuid,
	"report_sequence" bigint NOT NULL,
	"report_hash" varchar(64) NOT NULL,
	"policy" varchar(20),
	"policy_version" integer DEFAULT 1 NOT NULL,
	"policy_acknowledgement" varchar(50),
	"last_contact_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "koreader_copies_policy_chk" CHECK ("koreader_installed_copies"."policy" is null or "koreader_installed_copies"."policy" in ('notify', 'automatic', 'ignore')),
	CONSTRAINT "koreader_copies_values_chk" CHECK ("koreader_installed_copies"."policy_version" > 0 and "koreader_installed_copies"."report_sequence" > 0 and "koreader_installed_copies"."size_bytes" >= 0 and "koreader_installed_copies"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "koreader_delivery_devices" ADD CONSTRAINT "koreader_delivery_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "koreader_installed_copies" ADD CONSTRAINT "koreader_installed_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "koreader_installed_copies" ADD CONSTRAINT "koreader_installed_copies_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "koreader_installed_copies" ADD CONSTRAINT "koreader_installed_copies_revision_id_book_file_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."book_file_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "koreader_installed_copies" ADD CONSTRAINT "koreader_copies_device_fk" FOREIGN KEY ("user_id","device_id") REFERENCES "public"."koreader_delivery_devices"("user_id","device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "koreader_copies_identity_idx" ON "koreader_installed_copies" USING btree ("user_id","device_id","copy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "koreader_copies_path_idx" ON "koreader_installed_copies" USING btree ("user_id","device_id","pathname_hash");--> statement-breakpoint
CREATE INDEX "koreader_copies_user_page_idx" ON "koreader_installed_copies" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "koreader_copies_user_file_idx" ON "koreader_installed_copies" USING btree ("user_id","book_file_id","id");--> statement-breakpoint
CREATE INDEX "koreader_copies_file_idx" ON "koreader_installed_copies" USING btree ("book_file_id");--> statement-breakpoint
CREATE INDEX "koreader_copies_revision_idx" ON "koreader_installed_copies" USING btree ("revision_id");