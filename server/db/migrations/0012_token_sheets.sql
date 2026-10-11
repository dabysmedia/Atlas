CREATE TABLE "rulesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_portraits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_rules" (
	"world_id" uuid PRIMARY KEY NOT NULL,
	"active_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "token_portraits" ADD CONSTRAINT "token_portraits_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "token_sheets" ADD CONSTRAINT "token_sheets_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "token_sheets" ADD CONSTRAINT "token_sheets_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "token_sheets" ADD CONSTRAINT "token_sheets_ruleset_id_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."rulesets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "world_rules" ADD CONSTRAINT "world_rules_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "world_rules" ADD CONSTRAINT "world_rules_active_id_rulesets_id_fk" FOREIGN KEY ("active_id") REFERENCES "public"."rulesets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rulesets_world_key_uq" ON "rulesets" USING btree ("world_id","key");
--> statement-breakpoint
CREATE INDEX "token_portraits_world_idx" ON "token_portraits" USING btree ("world_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "token_sheets_token_rules_uq" ON "token_sheets" USING btree ("token_id","ruleset_id");
--> statement-breakpoint
CREATE INDEX "token_sheets_world_idx" ON "token_sheets" USING btree ("world_id");
