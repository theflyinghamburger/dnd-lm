CREATE TYPE "public"."pending_action_status" AS ENUM('open', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"requester_id" uuid NOT NULL,
	"authorized_character_ids" uuid[] DEFAULT '{}' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "pending_action_status" DEFAULT 'open' NOT NULL,
	"resolution_id" uuid,
	"graph_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "paused_from" "session_status";--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_actions_session_id_idx" ON "pending_actions" USING btree ("session_id");