CREATE TYPE "public"."source_status" AS ENUM('pending', 'extracting', 'review', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"status" "source_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"pages_total" integer,
	"pages_done" integer DEFAULT 0 NOT NULL,
	"notes_extracted" integer DEFAULT 0 NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "campaign_sources" ADD CONSTRAINT "campaign_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sources" ADD CONSTRAINT "campaign_sources_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sources_one_in_flight_key" ON "campaign_sources" USING btree ("campaign_id") WHERE status in ('pending', 'extracting');--> statement-breakpoint
CREATE INDEX "campaign_sources_campaign_idx" ON "campaign_sources" USING btree ("campaign_id","created_at");--> statement-breakpoint
ALTER TABLE "campaign_notes" ADD CONSTRAINT "campaign_notes_source_id_campaign_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."campaign_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_notes_source_id_idx" ON "campaign_notes" USING btree ("source_id");