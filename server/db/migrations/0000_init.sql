CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "campaign_fog" (
	"campaign_id" uuid NOT NULL,
	"hex_id" uuid NOT NULL,
	"status" text DEFAULT 'explored' NOT NULL,
	"since_day" integer,
	CONSTRAINT "campaign_fog_campaign_id_hex_id_pk" PRIMARY KEY("campaign_id","hex_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"system" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hex_id" uuid NOT NULL,
	"faction_id" uuid NOT NULL,
	"kind" text DEFAULT 'control' NOT NULL,
	"since_day" integer,
	"note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"campaign_id" uuid,
	"game_day" integer NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text DEFAULT 'gm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#8a6d3b' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"signature_meter_id" uuid,
	"wiki_page_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"q" integer NOT NULL,
	"r" integer NOT NULL,
	"terrain" text DEFAULT 'unknown' NOT NULL,
	"state" text DEFAULT 'wild' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"wiki_page_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"layout" jsonb NOT NULL,
	"parent_hex_id" uuid,
	"background_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"faction_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"old_value" real,
	"new_value" real NOT NULL,
	"cause" text NOT NULL,
	"game_day" integer NOT NULL,
	"source" text DEFAULT 'gm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"min" real,
	"max" real,
	"default_value" real DEFAULT 0 NOT NULL,
	"bands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "meter_kind_ck" CHECK ("meter_definitions"."kind" in ('core','signature','resource'))
);
--> statement-breakpoint
CREATE TABLE "meter_values" (
	"faction_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"value" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meter_values_faction_id_meter_id_pk" PRIMARY KEY("faction_id","meter_id")
);
--> statement-breakpoint
CREATE TABLE "roll_table_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"kind" text DEFAULT 'event' NOT NULL,
	"title" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"approved" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'gm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roll_entry_weight_ck" CHECK ("roll_table_entries"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "roll_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"faction_id" uuid,
	"meter_id" uuid,
	"band" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" text DEFAULT 'town' NOT NULL,
	"population" integer,
	"faction_id" uuid,
	"wiki_page_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"map_id" uuid NOT NULL,
	"hex_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"faction_id" uuid,
	"campaign_id" uuid,
	"settlement_id" uuid,
	"color" text,
	"icon" text,
	"visible_to_players" boolean DEFAULT true NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wiki_links" (
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	CONSTRAINT "wiki_links_from_page_id_to_page_id_pk" PRIMARY KEY("from_page_id","to_page_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'Lore' NOT NULL,
	"content" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"current_day" integer DEFAULT 1 NOT NULL,
	"terrain_types" jsonb NOT NULL,
	"hex_states" jsonb NOT NULL,
	"accent" text DEFAULT '#c8a24a' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_fog" ADD CONSTRAINT "campaign_fog_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_fog" ADD CONSTRAINT "campaign_fog_hex_id_hexes_id_fk" FOREIGN KEY ("hex_id") REFERENCES "public"."hexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_hex_id_hexes_id_fk" FOREIGN KEY ("hex_id") REFERENCES "public"."hexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factions" ADD CONSTRAINT "factions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factions" ADD CONSTRAINT "factions_signature_meter_id_meter_definitions_id_fk" FOREIGN KEY ("signature_meter_id") REFERENCES "public"."meter_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factions" ADD CONSTRAINT "factions_wiki_page_id_wiki_pages_id_fk" FOREIGN KEY ("wiki_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hexes" ADD CONSTRAINT "hexes_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hexes" ADD CONSTRAINT "hexes_wiki_page_id_wiki_pages_id_fk" FOREIGN KEY ("wiki_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps" ADD CONSTRAINT "maps_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_changes" ADD CONSTRAINT "meter_changes_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_changes" ADD CONSTRAINT "meter_changes_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_changes" ADD CONSTRAINT "meter_changes_meter_id_meter_definitions_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."meter_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_definitions" ADD CONSTRAINT "meter_definitions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_meter_id_meter_definitions_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."meter_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_table_entries" ADD CONSTRAINT "roll_table_entries_table_id_roll_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."roll_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_tables" ADD CONSTRAINT "roll_tables_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_tables" ADD CONSTRAINT "roll_tables_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roll_tables" ADD CONSTRAINT "roll_tables_meter_id_meter_definitions_id_fk" FOREIGN KEY ("meter_id") REFERENCES "public"."meter_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_wiki_page_id_wiki_pages_id_fk" FOREIGN KEY ("wiki_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_hex_id_hexes_id_fk" FOREIGN KEY ("hex_id") REFERENCES "public"."hexes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_links" ADD CONSTRAINT "wiki_links_from_page_id_wiki_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_links" ADD CONSTRAINT "wiki_links_to_page_id_wiki_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_world_idx" ON "campaigns" USING btree ("world_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_one_control_uq" ON "claims" USING btree ("hex_id") WHERE "claims"."kind" = 'control';--> statement-breakpoint
CREATE UNIQUE INDEX "claims_hex_faction_kind_uq" ON "claims" USING btree ("hex_id","faction_id","kind");--> statement-breakpoint
CREATE INDEX "claims_faction_idx" ON "claims" USING btree ("faction_id");--> statement-breakpoint
CREATE INDEX "events_world_idx" ON "events" USING btree ("world_id","id");--> statement-breakpoint
CREATE INDEX "factions_world_idx" ON "factions" USING btree ("world_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hexes_map_qr_uq" ON "hexes" USING btree ("map_id","q","r");--> statement-breakpoint
CREATE INDEX "maps_world_idx" ON "maps" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "meter_changes_faction_idx" ON "meter_changes" USING btree ("faction_id","meter_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "meter_def_world_key_uq" ON "meter_definitions" USING btree ("world_id","key");--> statement-breakpoint
CREATE INDEX "roll_entries_table_idx" ON "roll_table_entries" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "roll_tables_world_idx" ON "roll_tables" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "settlements_world_idx" ON "settlements" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "tokens_map_idx" ON "tokens" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "wiki_links_to_idx" ON "wiki_links" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "wiki_world_idx" ON "wiki_pages" USING btree ("world_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_world_title_uq" ON "wiki_pages" USING btree ("world_id",lower("title"));--> statement-breakpoint
CREATE INDEX "wiki_search_idx" ON "wiki_pages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "wiki_title_trgm_idx" ON "wiki_pages" USING gin ("title" gin_trgm_ops);