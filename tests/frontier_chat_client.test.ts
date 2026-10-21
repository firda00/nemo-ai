import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchFrontierAnswer } from '../src/lib/frontierChatClient'
const selection={provider:'openai' as const,model:'gpt-6-astra' as const,effort:'low' as const}
const payload=()=>({ok:true,message:{role:'assistant',content:'Completed answer',tool_calls:[]},model:'gpt-6-astra',frontier:{selection,continuation:'opaque-test-value',status:'completed'}})
const invoke=(data:unknown)=>async()=>({data,error:null})
afterEach(()=>vi.useRealTimers())
describe('frontier chat result contract',()=>{
  it('accepts completed exact-model output and opaque context',async()=>{
    expect(await fetchFrontierAnswer(invoke(payload()),selection)).toMatchObject({ok:true,model:selection.model,continuation:'opaque-test-value'})
  })
  it.each(['model','effort','provider','status','tools','empty','context'])('rejects mismatched or unusable result: %s',async(field)=>{
    const data=payload()
    if(field==='model')data.model='other'
    if(field==='effort')data.frontier.selection={...selection,effort:'high' as 'low'}
    if(field==='provider')data.frontier.selection={...selection,provider:'anthropic' as 'openai'}
    if(field==='status')data.frontier.status='tool_calls'
    if(field==='tools')Object.assign(data.message,{tool_calls:[{id:'pending'}]})
    if(field==='empty')data.message.content=''
    if(field==='context')data.frontier.continuation=''
    expect(await fetchFrontierAnswer(invoke(data),selection)).toEqual({ok:false,code:'INVALID_PROVIDER_RESPONSE'})
  })
  it('surfaces missing key without inventing a completed answer',async()=>{
    expect(await fetchFrontierAnswer(invoke({ok:false,code:'NEED_KEY'}),selection)).toEqual({ok:false,code:'NEED_KEY'})
  })
  it('releases a hung request without retry',async()=>{
    vi.useFakeTimers()
    const call=vi.fn(()=>new Promise<{data:unknown;error:null}>(()=>{}))
    const task=fetchFrontierAnswer(call,selection)
    await vi.advanceTimersByTimeAsync(90_001)
    expect(await task).toEqual({ok:false,code:'PROVIDER_UNAVAILABLE'})
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('recovers with retry when first attempt returns RATE_LIMITED', async () => {
    vi.useFakeTimers()
    const call = vi
      .fn()
      .mockImplementationOnce(invoke({ ok: false, code: 'RATE_LIMITED' }))
      .mockImplementationOnce(invoke(payload()))
    const task = fetchFrontierAnswer(call, selection, { backoffBaseMs: 10 })
    await vi.advanceTimersByTimeAsync(100)
    const result = await task
    expect(result).toMatchObject({ ok: true, model: selection.model })
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('exhausts retries and returns final error code if server remains overloaded', async () => {
    vi.useFakeTimers()
    const call = vi.fn().mockImplementation(invoke({ ok: false, code: 'RATE_LIMITED' }))
    const task = fetchFrontierAnswer(call, selection, { maxRetries: 2, backoffBaseMs: 10 })
    await vi.advanceTimersByTimeAsync(300)
    const result = await task
    expect(result).toEqual({ ok: false, code: 'RATE_LIMITED' })
    expect(call).toHaveBeenCalledTimes(3)
  })
})
