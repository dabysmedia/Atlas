CREATE TABLE "map_model" (
	"map_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"name" text DEFAULT 'model.glb' NOT NULL,
	"placement" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "daylight" jsonb;--> statement-breakpoint
ALTER TABLE "map_model" ADD CONSTRAINT "map_model_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE cascade ON UPDATE no action;