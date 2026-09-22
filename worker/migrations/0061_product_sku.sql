-- SKU numbers on a venue's own menu (num_products), the way a business
-- labels and organises what it sells. Digits only, 4 to 12, unique within one
-- business. The owner types their own or NUM assigns the next free one.
-- growth/sku.mjs has the rules and draws the barcode.
--
-- One ALTER, then a partial unique index. An ADD COLUMN is not re-runnable:
-- a second pass stops at 'duplicate column name: sku', which means it is
-- already applied, and changes nothing. The index is IF NOT EXISTS.
ALTER TABLE num_products ADD COLUMN sku TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku
  ON num_products(business_id, sku) WHERE sku IS NOT NULL;
