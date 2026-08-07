export interface RetrieveOptions {
  /** Restrict to one repo (repo_source). Omitted = all repos ($4 binds SQL NULL). */
  repoSource?: string;
  /** Per-leg candidate limit before fusion. */
  perLegLimit?: number;
  /** Score added to a chunk whose symbol_name exactly matches the query. */
  symbolBoost?: number;
  /** RRF k constant. */
  rrfK?: number;
  /** Number of fused results to return. */
  topK?: number;
  /** Weight applied to the dense leg's RRF term. */
  denseWeight?: number;
  /** Weight applied to the lexical leg's RRF term. */
  lexicalWeight?: number;
}

export const PER_LEG_LIMIT = 30;
export const SYMBOL_BOOST = 1.0;
export const RRF_K = 60;
export const DEFAULT_TOP_K = 10;
export const DEFAULT_DENSE_WEIGHT = 1.0;
export const DEFAULT_LEXICAL_WEIGHT = 1.0;

// Executed as written against the live dev database (plans/03-retrieval.md, Verified 1, 2).
// Do not "simplify" the nested ORDER BY/LIMIT per leg — that's what keeps the HNSW index scan
// instead of ranking the whole table before limiting (Verified 7). Do not collapse the two
// COALESCE calls into one around the sum — a one-leg row's NULL rank would zero the whole score
// instead of crediting the leg that found it.
export const HYBRID_SQL = `
WITH dense AS (
  SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist ASC, id ASC) AS dense_rank
  FROM ( SELECT c.id, c.embedding <=> $1 AS dist
         FROM chunks c
         WHERE $4::text IS NULL OR c.repo_source = $4
         ORDER BY c.embedding <=> $1
         LIMIT $3 ) d
),
lexical AS (
  SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC, id ASC) AS lexical_rank
  FROM ( SELECT c.id,
                ts_rank(c.tsv, websearch_to_tsquery('english', $2), 1)
                  + CASE WHEN lower(c.symbol_name) = lower(btrim($2)) THEN $5 ELSE 0 END AS score
         FROM chunks c
         WHERE ($4::text IS NULL OR c.repo_source = $4)
           AND ( c.tsv @@ websearch_to_tsquery('english', $2)
                 OR lower(c.symbol_name) = lower(btrim($2)) )
         ORDER BY score DESC, c.id ASC
         LIMIT $3 ) l
)
SELECT c.id, c.repo_source, c.file_path, c.symbol_name, c.kind, c.signature,
       c.start_line, c.end_line, c.language, c.chunker_kind, c.content,
       d.dense_rank, l.lexical_rank, d.dist AS dense_distance, l.score AS lexical_score,
       COALESCE($8 / ($6 + d.dense_rank), 0)
         + COALESCE($9 / ($6 + l.lexical_rank), 0) AS fused_score
FROM dense d
FULL OUTER JOIN lexical l USING (id)
JOIN chunks c ON c.id = COALESCE(d.id, l.id)
ORDER BY COALESCE($8 / ($6 + d.dense_rank), 0)
       + COALESCE($9 / ($6 + l.lexical_rank), 0) DESC, c.id ASC
LIMIT $7;
`;

/**
 * Maps a RetrieveOptions bag onto the statement's nine positional params, applying documented
 * defaults. $4 (repoSource) always binds JS null when omitted — never undefined (accidental-NULL
 * today, one pg version from throwing) and never the string 'null' (would match no repo and
 * silently return nothing).
 */
export function buildParams(
  vectorLiteral: string,
  query: string,
  options: RetrieveOptions = {},
): unknown[] {
  const {
    repoSource,
    perLegLimit = PER_LEG_LIMIT,
    symbolBoost = SYMBOL_BOOST,
    rrfK = RRF_K,
    topK = DEFAULT_TOP_K,
    denseWeight = DEFAULT_DENSE_WEIGHT,
    lexicalWeight = DEFAULT_LEXICAL_WEIGHT,
  } = options;

  return [
    vectorLiteral, // $1
    query, // $2
    perLegLimit, // $3
    repoSource ?? null, // $4
    symbolBoost, // $5
    rrfK, // $6
    topK, // $7
    denseWeight, // $8
    lexicalWeight, // $9
  ];
}
