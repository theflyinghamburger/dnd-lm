CREATE TYPE "public"."note_spoiler_level" AS ENUM('player', 'dm');--> statement-breakpoint
CREATE TYPE "public"."note_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('location', 'npc', 'quest', 'item', 'lore', 'handout');--> statement-breakpoint
CREATE TABLE "campaign_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"type" "note_type" NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spoiler_level" "note_spoiler_level" DEFAULT 'dm' NOT NULL,
	"chapter" integer,
	"status" "note_status" DEFAULT 'published' NOT NULL,
	"source_id" uuid,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body_md, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_notes" ADD CONSTRAINT "campaign_notes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_notes_campaign_slug_key" ON "campaign_notes" USING btree ("campaign_id","slug");--> statement-breakpoint
CREATE INDEX "campaign_notes_campaign_type_idx" ON "campaign_notes" USING btree ("campaign_id","type");--> statement-breakpoint
CREATE INDEX "campaign_notes_tsv_idx" ON "campaign_notes" USING gin ("tsv");