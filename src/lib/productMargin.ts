// Shim: the deterministic margin engine lives in supabase/functions/_shared so the SAME module
// serves the browser and the Deno edge function. Import from here in src/.
export * from '../../supabase/functions/_shared/productMargin.ts'
