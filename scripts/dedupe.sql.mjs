/**
 * NUM · the SQL that collapses a place stored twice into a place stored once.
 *
 * OSM maps a lot of businesses as both a node and a building way. Our place id
 * is a hash of name and position to four decimals, so the node and the way get
 * two different ids and land as two rows — the same restaurant, twice, one of
 * them missing the phone number. Adding a second source (Overture) doubled the
 * ways this can happen.
 *
 * Pure string builders, so the whole thing can be read and tested without a
 * database.
 */

/** ~110m at Taiwan's latitude. Two rows this close with the same name, in the
 *  same destination, are the same place written down twice. */
export const PRECISION = 3;

/** Phone punctuation varies by whoever typed it: +886 5 227 0661 and
 *  +88652270661 are one number. Compared as digits, they are equal. */
export const phoneExpr = (col) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'(',''),')',''),'+','')`;

/**
 * How much a row is worth keeping. Contact details count one each; a photo or
 * a rating counts four because somebody paid to get it. A claimed listing or a
 * rated one counts a hundred, which is another way of saying it is never the
 * row that gets deleted.
 */
export const RICHNESS = `
        (CASE WHEN phone IS NOT NULL THEN 1 ELSE 0 END)
       +(CASE WHEN website IS NOT NULL THEN 1 ELSE 0 END)
       +(CASE WHEN address IS NOT NULL THEN 1 ELSE 0 END)
       +(CASE WHEN hours IS NOT NULL THEN 1 ELSE 0 END)
       +(CASE WHEN email IS NOT NULL THEN 1 ELSE 0 END)
       +(CASE WHEN name_local IS NOT NULL THEN 1 ELSE 0 END)
       +(CASE WHEN cuisine IS NOT NULL THEN 1 ELSE 0 END)
       + 4*(CASE WHEN photo_url IS NOT NULL THEN 1 ELSE 0 END)
       + 4*(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END)
       + 100*(CASE WHEN business_id IS NOT NULL THEN 1 ELSE 0 END)
       + 100*(CASE WHEN COALESCE(num_rating_n,0) > 0 THEN 1 ELSE 0 END)`;

export const PROTECTED = 100;

/** Fields merged from the rows being removed into the row being kept. */
export const MERGED = Object.freeze(['phone', 'website', 'email', 'address', 'hours', 'cuisine', 'name_local']);

const scopeWhere = (country) => (country ? `WHERE country = '${String(country).replace(/'/g, "''")}'` : '');

/**
 * Pairs of (survivor, doomed).
 *
 * Two rows are only collapsed when their phone numbers agree or one is
 * missing. Two shops of the same name a hundred metres apart with two
 * different phone numbers are two shops — 7-Eleven has more than one branch
 * per neighbourhood in Taipei, and merging them would delete a real place.
 */
export const pairsSql = (country) => `WITH t AS (
  SELECT id, dest, lower(trim(name)) nm,
         CAST(ROUND(lat,${PRECISION}) AS TEXT) la, CAST(ROUND(lng,${PRECISION}) AS TEXT) lo,
         ${phoneExpr('phone')} ph,${RICHNESS} AS rich
    FROM places ${scopeWhere(country)}
),
r AS (SELECT t.*, dest||'|'||nm||'|'||la||'|'||lo AS g,
             ROW_NUMBER() OVER (PARTITION BY dest||'|'||nm||'|'||la||'|'||lo
                                ORDER BY rich DESC, id) AS rn FROM t),
keep AS (SELECT g, id, ph FROM r WHERE rn = 1)
SELECT k.id AS keep_id, r.id AS drop_id
  FROM r JOIN keep k ON k.g = r.g
 WHERE r.rn > 1 AND r.rich < ${PROTECTED}
   AND (r.ph = '' OR k.ph = '' OR r.ph = k.ph)`;

export const CREATE_WORK = 'CREATE TABLE IF NOT EXISTS _dedupe (keep_id TEXT NOT NULL, drop_id TEXT NOT NULL PRIMARY KEY)';
export const DROP_WORK = 'DROP TABLE IF EXISTS _dedupe';
export const fillWorkSql = (country) => `INSERT OR IGNORE INTO _dedupe (keep_id, drop_id)\n${pairsSql(country)}`;

/** Nothing is deleted before what it knows has been moved somewhere it survives. */
export const mergeSql = () => MERGED.map((c) =>
  `UPDATE places SET ${c} = (SELECT p.${c} FROM _dedupe d JOIN places p ON p.id = d.drop_id`
  + ` WHERE d.keep_id = places.id AND p.${c} IS NOT NULL LIMIT 1)`
  + ` WHERE ${c} IS NULL AND id IN (SELECT keep_id FROM _dedupe)`);

export const deleteSql = () => 'DELETE FROM places WHERE id IN (SELECT drop_id FROM _dedupe)';

export const countSql = () => 'SELECT COUNT(*) n FROM _dedupe';
