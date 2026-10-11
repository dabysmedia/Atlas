CREATE TABLE "hex_artwork" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hex_presentations" (
	"hex_id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"hero_id" uuid,
	"hero_focus" integer DEFAULT 50 NOT NULL,
	"lore" text DEFAULT '' NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hex_artwork" ADD CONSTRAINT "hex_artwork_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hex_presentations" ADD CONSTRAINT "hex_presentations_hex_id_hexes_id_fk" FOREIGN KEY ("hex_id") REFERENCES "public"."hexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hex_presentations" ADD CONSTRAINT "hex_presentations_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hex_presentations" ADD CONSTRAINT "hex_presentations_hero_id_hex_artwork_id_fk" FOREIGN KEY ("hero_id") REFERENCES "public"."hex_artwork"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hex_artwork_world_idx" ON "hex_artwork" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "hex_presentations_world_idx" ON "hex_presentations" USING btree ("world_id");