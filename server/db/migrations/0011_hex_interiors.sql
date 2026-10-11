CREATE TABLE "interior_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interior_positions" (
	"token_id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"interior_id" uuid NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interiors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"hex_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT '2d' NOT NULL,
	"cols" integer DEFAULT 24 NOT NULL,
	"rows" integer DEFAULT 18 NOT NULL,
	"entry_x" integer DEFAULT 0 NOT NULL,
	"entry_y" integer DEFAULT 0 NOT NULL,
	"visible_to_players" boolean DEFAULT false NOT NULL,
	"asset_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interior_grid_ck" CHECK ("interiors"."cols" between 1 and 200 and "interiors"."rows" between 1 and 200 and "interiors"."entry_x" >= 0 and "interiors"."entry_x" < "interiors"."cols" and "interiors"."entry_y" >= 0 and "interiors"."entry_y" < "interiors"."rows"),
	CONSTRAINT "interior_mode_ck" CHECK ("interiors"."mode" in ('2d','3d'))
);
--> statement-breakpoint
ALTER TABLE "interior_assets" ADD CONSTRAINT "interior_assets_id_interiors_id_fk" FOREIGN KEY ("id") REFERENCES "public"."interiors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interior_assets" ADD CONSTRAINT "interior_assets_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interior_positions" ADD CONSTRAINT "interior_positions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interior_positions" ADD CONSTRAINT "interior_positions_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interior_positions" ADD CONSTRAINT "interior_positions_interior_id_interiors_id_fk" FOREIGN KEY ("interior_id") REFERENCES "public"."interiors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interiors" ADD CONSTRAINT "interiors_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interiors" ADD CONSTRAINT "interiors_hex_id_hexes_id_fk" FOREIGN KEY ("hex_id") REFERENCES "public"."hexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interiors_world_hex_idx" ON "interiors" USING btree ("world_id","hex_id");