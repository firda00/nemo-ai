// Production E2E tenants may exercise Nemo's own database and LLM paths, but
// must never contact an external system or create a payment/session on one.
// Fail closed when the account classification cannot be read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function blocksExternalActions(db: any, accountId: string): Promise<boolean> {
  const { data, error } = await db.from('accounts').select('is_production_e2e').eq('id', accountId).maybeSingle()
  return Boolean(error || !data || data.is_production_e2e === true)
}

export const PRODUCTION_E2E_EXTERNAL_BLOCK = {
  ok: false,
  code: 'PRODUCTION_E2E_EXTERNAL_BLOCKED',
  error: 'External actions are disabled for the production test account.',
}
