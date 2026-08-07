/**
 * What a pasted API key actually looks like.
 *
 * People copy keys out of documentation and out of curl examples, so one arrives wrapped: a
 * "Bearer " prefix, a whole "Authorization:" line, quotes from a JSON snippet, a trailing
 * newline, the zero-width characters a web page leaves behind.
 *
 * For Uzum this is not tidiness. Its OpenAPI wants the RAW token and answers a Bearer prefix with
 * 403 — the same status it returns when a key genuinely lacks permission. A seller pasting the
 * documented curl line would be told their key cannot read their own shop, and nothing anywhere
 * would point at the two extra words.
 *
 * Lives here rather than inside the edge function so it can be tested outside Deno: that file
 * imports the Supabase client over https, which Node cannot resolve.
 */
export function normalizeKey(value: unknown): string {
  return String(value ?? '')
    // Zero-width joiners and the BOM. Written as escapes on purpose — as literal characters they
    // are invisible in the source, and one stray hyphen inside this class would silently strip
    // hyphens out of every key that contains them.
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^Authorization\s*:\s*/i, '')
    // \b rather than \s+: after the earlier trim, "Bearer " has lost its trailing space, and a
    // key consisting of nothing but the word is empty, not a six-character key.
    .replace(/^Bearer\b\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
}
