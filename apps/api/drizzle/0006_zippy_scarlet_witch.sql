CREATE TYPE "public"."provider_connection_kind" AS ENUM('anthropic', 'openai_compatible');--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" "provider_connection_kind" NOT NULL,
	"base_url" text NOT NULL,
	"api_key_ciphertext" "bytea",
	"api_key_nonce" "bytea",
	"api_key_last4" text,
	"model_id" text NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;