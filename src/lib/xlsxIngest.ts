// Shim: the bounded XLSX engine lives in supabase/functions/_shared so the SAME module serves
// the browser (panel/worker/chat card) and the Deno edge function. Import from here in src/.
export * from '../../supabase/functions/_shared/xlsxIngest.ts'
