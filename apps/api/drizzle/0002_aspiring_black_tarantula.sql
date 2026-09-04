CREATE TYPE "public"."message_channel" AS ENUM('in_character', 'ooc');--> statement-breakpoint
CREATE TYPE "public"."message_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."recipient_type" AS ENUM('dm', 'player', 'party', 'table', 'dice', 'sheet', 'ooc', 'whisper');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_type" "recipient_type" NOT NULL,
	"recipient_ids" uuid[] DEFAULT '{}' NOT NULL,
	"channel" "message_channel" DEFAULT 'in_character' NOT NULL,
	"visibility" "message_visibility" DEFAULT 'public' NOT NULL,
	"content" text NOT NULL,
	"sequence" integer NOT NULL,
	"triggers_dm" boolean DEFAULT false NOT NULL,
	"trigger_definition_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_session_sequence_key" ON "messages" USING btree ("session_id","sequence");