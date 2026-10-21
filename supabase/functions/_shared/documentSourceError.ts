export type SourceErrorCode = 'unsupported' | 'too_large' | 'unreadable' | 'incomplete' | 'timeout' | 'cancelled' | 'invalid_selection'
export class DocumentSourceError extends Error {
  readonly code: SourceErrorCode
  readonly fileName: string
  constructor(code: SourceErrorCode, fileName = '') { super(`DOCUMENT_SOURCE_${code}`); this.code = code; this.fileName = fileName }
}
