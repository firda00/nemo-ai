// Shim: the report exporters live in supabase/functions/_shared so the SAME module serves the
// browser downloads and the server-side artifact generation. Import from here in src/.
export * from '../../supabase/functions/_shared/marginReportExport.ts'
