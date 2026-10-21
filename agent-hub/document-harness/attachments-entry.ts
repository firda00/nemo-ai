import './desk-entry'
import '../../src/index.css'
import { extractDocumentSources } from '../../src/lib/documentSourceClient'
// Browser smoke only: actual parser/worker entry, no test extraction substitute.
Object.assign(globalThis, { __extractDocumentSources: extractDocumentSources })
