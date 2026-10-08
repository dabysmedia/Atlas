CREATE TABLE "map_art" (
	"map_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"placement" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "demo" text;--> statement-breakpoint
ALTER TABLE "map_art" ADD CONSTRAINT "map_art_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps" DROP COLUMN "background_url";--> statement-breakpoint
UPDATE "worlds" SET "demo" = 'reach-v1' WHERE "name" = 'The Sundered Reach' AND "id" IN (SELECT "world_id" FROM "maps" WHERE "layout"->>'cols' = '22' AND "layout"->>'rows' = '16');
