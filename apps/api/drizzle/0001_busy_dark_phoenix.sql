CREATE TYPE "public"."session_status" AS ENUM('WAITING_FOR_PLAYERS', 'DM_GENERATING', 'WAITING_FOR_ROLL', 'PAUSED', 'SESSION_ENDED');--> statement-breakpoint
CREATE TABLE "commands" (
	"command_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"type" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"state_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_session_id_sequence_pk" PRIMARY KEY("session_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'WAITING_FOR_PLAYERS' NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"scene_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commands_session_id_idx" ON "commands" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_campaign_id_idx" ON "sessions" USING btree ("campaign_id");