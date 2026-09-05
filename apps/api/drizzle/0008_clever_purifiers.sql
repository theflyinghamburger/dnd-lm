CREATE TYPE "public"."provider_connection_audit_action" AS ENUM('created', 'updated', 'replaced_key', 'deleted', 'enabled', 'disabled');--> statement-breakpoint
CREATE TABLE "provider_connection_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" "provider_connection_audit_action" NOT NULL,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_connection_audit" ADD CONSTRAINT "provider_connection_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_connection_audit_connection_idx" ON "provider_connection_audit" USING btree ("connection_id","at");