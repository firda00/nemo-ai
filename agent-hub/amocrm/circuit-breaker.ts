import type { RuntimeClient } from '../../supabase/functions/_shared/runtime.ts'

const CONNECTOR = 'amocrm'
const OPERATION = 'enrich_deal'

export async function acquireAmoPermit(runtime: RuntimeClient, accountId: string) {
  return runtime.acquireConnectorPermit({
    accountId, connectorId: CONNECTOR, operation: OPERATION, permitTtlSeconds: 30,
  })
}

export async function recordAmoSuccess(runtime: RuntimeClient, accountId: string, permitToken: string) {
  return runtime.recordConnectorSuccess({
    accountId, connectorId: CONNECTOR, operation: OPERATION, permitToken,
  })
}

export async function recordAmoFailure(
  runtime: RuntimeClient,
  accountId: string,
  permitToken: string,
  errorCode: string,
) {
  return runtime.recordConnectorFailure({
    accountId, connectorId: CONNECTOR, operation: OPERATION, permitToken, errorCode,
  })
}
