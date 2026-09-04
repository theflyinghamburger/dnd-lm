CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sheet" jsonb NOT NULL,
	"level" integer GENERATED ALWAYS AS (((sheet->>'level')::integer)) STORED,
	"state_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"character_id" uuid,
	"expression" text NOT NULL,
	"dice" integer[] NOT NULL,
	"modifiers" jsonb NOT NULL,
	"total" integer NOT NULL,
	"visibility" "message_visibility" DEFAULT 'public' NOT NULL,
	"requester_id" uuid NOT NULL,
	"authorized_roller_id" uuid,
	"pending_action_id" uuid,
	"state_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_authorized_roller_id_users_id_fk" FOREIGN KEY ("authorized_roller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_campaign_id_idx" ON "characters" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "rolls_session_id_idx" ON "rolls" USING btree ("session_id");