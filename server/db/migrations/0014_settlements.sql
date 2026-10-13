ALTER TABLE settlements ADD COLUMN revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE settlement_hexes (
  settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  hex_id uuid NOT NULL REFERENCES hexes(id) ON DELETE CASCADE,
  PRIMARY KEY (settlement_id, hex_id)
);
--> statement-breakpoint
CREATE INDEX settlement_hexes_hex_idx ON settlement_hexes(hex_id);
--> statement-breakpoint
INSERT INTO settlement_hexes(settlement_id,hex_id)
SELECT settlement_id,hex_id FROM tokens WHERE settlement_id IS NOT NULL AND hex_id IS NOT NULL ON CONFLICT DO NOTHING;
