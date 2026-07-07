import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ReactFlow, { 
  addEdge, 
  Background, 
  Controls, 
  useNodesState, 
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Button } from '../../../components/ui/Button'
import { ArrowLeft, Save, Play, Cpu, Settings, Plus, Send, Bot, Sparkles, X, Check, Image, Search, PenLine, Megaphone, Trash2 } from 'lucide-react'
import { useAgentStore } from '../../../store/useAgentStore'
import { useI18n } from '../../../i18n'

const agentPresets = [
  { id: 'research', label: 'Deep Research Agent', role: 'RESEARCH', tool: 'Deep research API', Icon: Search },
  { id: 'content', label: 'Content Creator', role: 'CONTENT', tool: 'LLM content API', Icon: PenLine },
  { id: 'image', label: 'Image Generator', role: 'IMAGE', tool: 'Image generation API', Icon: Image },
  { id: 'publishing', label: 'Publishing Agent', role: 'PUBLISH', tool: 'Publishing API', Icon: Megaphone },
]

function agentOutput(capability: string, task: string, teamPurpose: string) {
  const brief = task.trim() || teamPurpose
  if (capability === 'research') {
    return `Research result for: “${brief}”\n- Query plan: market, competitors, pricing, objections\n- Sources to check: search/API, company docs, public pages\n- Output: concise report + 3 recommended actions`
  }
  if (capability === 'content') {
    return `Content package for: “${brief}”\n1. Hook: solve the customer's exact pain\n2. Main message: explain value in plain language\n3. CTA: ask for phone/demo/start date\n4. Variants: short post, story, sales reply`
  }
  if (capability === 'image') {
    return `Image generation brief for: “${brief}”\nPrompt: premium dark SaaS visual, clear product benefit, Uzbek/CIS SMB audience, high contrast, no clutter\nSizes: 1:1 post, 9:16 story, 16:9 hero`
  }
  if (capability === 'publishing') {
    return `Publishing plan for: “${brief}”\n- Telegram: publish concise post + CTA\n- Instagram: carousel/reels caption + hashtags\n- CRM/operator: send qualified leads after response\nStatus: ready, waiting for connected channel token`
  }
  return `Master plan for: “${brief}”\n- Split task into research, content, image and publishing\n- Verify result with quality checks\n- Ask for missing API/channel keys if needed`
}

const AgentNode = ({ data }: NodeProps) => {
  const preset = agentPresets.find((item) => item.id === data.capability)
  const Icon = preset?.Icon ?? Cpu
  return (
    <div className="px-4 py-3 shadow-xl rounded-2xl bg-panel border-2 border-violet text-center min-w-[200px] transition-all hover:border-cyan/50">
      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-violet" />
      <div className="flex flex-col items-center gap-2">
        <div className="p-2 rounded-full bg-violet/20 text-violet">
          <Icon className="w-5 h-5" />
        </div>
        <div className="text-sm font-bold text-text">{data.label}</div>
        <div className="text-[10px] text-muted uppercase tracking-wider">{data.role}</div>
        {data.tool && <div className="rounded-full bg-cyan/10 px-2 py-0.5 text-[9px] font-medium text-cyan">{data.tool}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-violet" />
    </div>
  )
}

const nodeTypes = {
  agentNode: AgentNode,
}

export default function SwarmArchitectPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { id = 'content-os' } = useParams()
  const agent = useAgentStore((s) => s.agents.find((item) => item.id === id))
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('master');
  const [savedAt, setSavedAt] = useState('');
  const [teamSettings, setTeamSettings] = useState({ channels: true, companyBrain: true, qualityChecks: true, crmHandoff: true, runtime: 'shared' })
  const [messages, setMessages] = useState<{role: 'user' | 'agent', content: string, agentId?: string}[]>([]);
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const savedBlueprint = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(`nemo-team-blueprint:${id}`) || '{}') as { tools?: string[]; goal?: string }
    } catch {
      return {}
    }
  }, [id])

  const isSalesTeam = id.includes('sales') || Boolean(agent?.niche?.toLowerCase().includes('sales')) || Boolean(agent?.prompt.tasks.toLowerCase().includes('lead'))
  const teamName = agent?.name || (isSalesTeam ? t('swarmArchitectPage.salesTeamName') : t('swarmArchitectPage.contentTeamName'))
  const teamPurpose = agent?.purpose || agent?.prompt.tasks || (isSalesTeam ? t('swarmArchitectPage.salesTeamPurpose') : t('swarmArchitectPage.contentTeamPurpose'))

  const initialNodes: Node[] = useMemo(() => {
    const enabledTools = savedBlueprint.tools?.length ? savedBlueprint.tools : isSalesTeam ? ['content', 'research', 'publishing'] : ['research', 'content', 'image', 'publishing']
    const toolNodes = enabledTools.slice(0, 4).map((tool, index) => {
      const preset = agentPresets.find((item) => item.id === tool) ?? agentPresets[index % agentPresets.length]
      return {
        id: `spec${index + 1}`,
        type: 'agentNode',
        data: { label: preset.label, role: preset.role, capability: preset.id, tool: preset.tool },
        position: { x: 20 + index * 220, y: 240 },
      }
    })
    return [
      { id: 'master', type: 'agentNode', data: { label: agent?.role || 'Master AI Team Leader', role: 'MASTER', capability: 'master', tool: 'Orchestration' }, position: { x: 300, y: 50 } },
      ...toolNodes,
    ]
  }, [agent?.role, isSalesTeam, savedBlueprint.tools])

  const initialEdges: Edge[] = useMemo(() => initialNodes.filter((node) => node.id !== 'master').map((node) => ({ id: `e-master-${node.id}`, source: 'master', target: node.id, animated: true, style: { stroke: '#8B7CF8', strokeWidth: 2 } })), [initialNodes])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const onConnect = useCallback((params: Connection) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId)

  const addSubAgent = (preset = agentPresets[nodes.length % agentPresets.length]) => {
    const id = `spec${nodes.length}`
    setNodes((items) => [
      ...items,
      {
        id,
        type: 'agentNode',
        data: { label: preset.label, role: preset.role, capability: preset.id, tool: preset.tool },
        position: { x: 120 + nodes.length * 80, y: 380 },
      },
    ])
    setEdges((items) => [
      ...items,
      { id: `e-master-${id}`, source: 'master', target: id, animated: true, style: { stroke: '#22D3EE', strokeWidth: 2 } },
    ])
  }

  const updateSelectedNode = (patch: Record<string, string>) => {
    setNodes((items) => items.map((node) => (node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node)))
  }

  const deleteSelectedNode = () => {
    if (selectedNodeId === 'master') return
    setNodes((items) => items.filter((node) => node.id !== selectedNodeId))
    setEdges((items) => items.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId))
    setSelectedNodeId('master')
  }

  const runAgent = (node = selectedNode) => {
    if (!node) return
    setIsTesting(true)
    const result = agentOutput(String(node.data.capability ?? 'master'), input, teamPurpose)
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: `Run ${node.data.label}: ${input || teamPurpose}` },
      { role: 'agent', content: t('swarmArchitectPage.agentUsesTool', { label: node.data.label, tool: node.data.tool || 'core LLM', task: input || teamPurpose }), agentId: node.id },
      { role: 'agent', content: result, agentId: node.id },
    ])
    setInput('')
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [id, initialNodes, initialEdges, setNodes, setEdges])

  const saveBlueprint = async () => {
    setIsSaving(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    localStorage.setItem(`nemo-team-blueprint:${id}`, JSON.stringify({ nodes, edges, settings: teamSettings, savedAt: new Date().toISOString() }))
    setSavedAt(new Date().toLocaleTimeString())
    setIsSaving(false);
  }

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);

    setMessages(prev => [...prev, { role: 'agent', content: t('swarmArchitectPage.masterAnalyzing'), agentId: 'master' }])
    nodes.filter((node) => node.id !== 'master').forEach((node, index) => {
      window.setTimeout(() => {
        setMessages(prev => [...prev, { role: 'agent', content: `${node.data.label}:\n${agentOutput(String(node.data.capability ?? 'master'), userMsg, teamPurpose)}`, agentId: node.id }])
      }, 700 * (index + 1))
    })
    window.setTimeout(() => {
      setMessages(prev => [...prev, { role: 'agent', content: t('swarmArchitectPage.masterCompiled'), agentId: 'master' }])
    }, 700 * (nodes.length + 1))
  }

  const testButtonClass = isTesting ? 'bg-danger text-white flex items-center' : 'text-muted flex items-center';
  const graphWidth = isTesting ? 'w-[70%]' : 'w-full';

  return (
    <div className="flex flex-col h-screen bg-bg overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b border-border bg-panel shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" className="p-2" onClick={() => navigate('/app/swarms')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="ml-2">
            <h1 className="text-lg font-bold text-text">{t('swarmArchitectPage.title')}</h1>
            <p className="text-xs text-muted">{t('swarmArchitectPage.teamLabel', { name: teamName })}</p>
            <p className="mt-0.5 max-w-xl truncate text-[11px] text-muted">{teamPurpose}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" className="text-muted" onClick={() => setSettingsOpen(true)}>
            <Settings className="w-4 h-4 mr-2" />
            {t('swarmArchitectPage.settingsBtn')}
          </Button>
          <Button 
            onClick={() => setIsTesting(!isTesting)} 
            className={testButtonClass}
          >
            <Play className="w-4 h-4 mr-2" />
            {isTesting ? t('swarmArchitectPage.stopTest') : t('swarmArchitectPage.testTeam')}
          </Button>
          <Button 
            onClick={saveBlueprint} 
            disabled={isSaving}
            className="bg-gradient-to-r from-violet to-cyan text-white shadow-lg"
          >
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? t('swarmArchitectPage.saving') : t('swarmArchitectPage.saveScheme')}
          </Button>
        </div>
      </div>
      {savedAt && <div className="border-b border-border bg-teal/10 px-4 py-2 text-xs text-teal">{t('swarmArchitectPage.savedLocally', { time: savedAt })}</div>}

      <div className="flex-1 relative flex overflow-hidden">
        <div className={`flex-1 relative transition-all ${graphWidth}`}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            nodeTypes={nodeTypes}
            fitView
            className="bg-grid"
            style={{ background: '#070A18' }}
          >
            <Background color="#1e293b" gap={20} />
            <Controls />
          </ReactFlow>
          
          <div className="absolute bottom-6 left-6 flex gap-3">
            <Button className="bg-panel border border-border text-text hover:border-violet transition-colors" onClick={() => addSubAgent()}>
              <Plus className="w-4 h-4 mr-2" />
              {t('swarmArchitectPage.addSubagent')}
            </Button>
          </div>
          <div className="absolute right-6 top-6 w-80 rounded-3xl border border-border bg-panel/95 p-4 shadow-2xl backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan">Selected agent</p>
                <h3 className="mt-1 text-base font-semibold text-text">{selectedNode?.data.label ?? 'Master agent'}</h3>
              </div>
              {selectedNodeId !== 'master' && (
                <button onClick={deleteSelectedNode} className="rounded-lg p-1.5 text-muted hover:bg-danger/10 hover:text-danger">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            {selectedNode && (
              <div className="mt-4 space-y-3">
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted">Agent name</span>
                  <input value={selectedNode.data.label ?? ''} onChange={(e) => updateSelectedNode({ label: e.target.value })} className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-violet" />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted">Role</span>
                  <input value={selectedNode.data.role ?? ''} onChange={(e) => updateSelectedNode({ role: e.target.value })} className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-violet" />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted">API / tool</span>
                  <select
                    value={selectedNode.data.capability ?? 'content'}
                    onChange={(e) => {
                      const preset = agentPresets.find((item) => item.id === e.target.value)
                      if (preset) updateSelectedNode({ capability: preset.id, tool: preset.tool, role: preset.role })
                    }}
                    className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-violet"
                  >
                    <option value="master">Orchestration</option>
                    {agentPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                  </select>
                </label>
                <Button fullWidth onClick={() => runAgent(selectedNode)}>
                  <Play className="h-4 w-4" /> Run this agent
                </Button>
              </div>
            )}
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs font-medium text-muted">Add ready subagent</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {agentPresets.map((preset) => (
                  <button key={preset.id} onClick={() => addSubAgent(preset)} className="rounded-xl border border-border bg-bg p-2 text-left text-[11px] text-muted hover:border-violet/50 hover:text-text">
                    <preset.Icon className="mb-1 h-3.5 w-3.5 text-cyan" /> {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {isTesting && (
          <div className="w-[30%] bg-panel border-l border-border flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
            <div className="p-4 border-b border-border flex items-center justify-between bg-panel/50">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-cyan" />
                <span className="text-sm font-bold text-text">{t('swarmArchitectPage.testTeamTitle')}</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet/20 text-violet border border-violet/30 uppercase font-bold">Realtime</span>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-3 rounded-2xl text-sm ${
                    msg.role === 'user' 
                      ? 'bg-gradient-to-br from-violet to-cyan text-white rounded-tr-none' 
                      : 'bg-bg border border-border text-text rounded-tl-none'
                  }`}>
                    {msg.role === 'agent' && (
                      <div className="flex items-center gap-2 mb-1 text-[10px] font-bold text-violet uppercase">
                        <Bot className="w-3 h-3" />
                        {msg.agentId === 'master' ? 'Master' : 'Specialist'}
                      </div>
                    )}
                    {msg.content}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={sendMessage} className="p-4 bg-panel border-t border-border flex gap-2">
              <input 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('swarmArchitectPage.taskPlaceholder')}
                className="flex-1 bg-bg border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-violet"
              />
              <Button type="submit" className="bg-violet text-white p-2">
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        )}
      </div>

      {settingsOpen && (
        <div className="fixed inset-0 z-[80] flex justify-end bg-black/50 backdrop-blur-sm">
          <button className="flex-1" aria-label={t('swarmArchitectPage.closeSettings')} onClick={() => setSettingsOpen(false)} />
          <div className="h-full w-full max-w-md border-l border-border bg-panel p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text">{t('swarmArchitectPage.settingsTitle')}</h2>
                <p className="mt-1 text-sm text-muted">{t('swarmArchitectPage.settingsSubtitle')}</p>
              </div>
              <button onClick={() => setSettingsOpen(false)} className="rounded-lg p-2 text-muted hover:bg-white/5 hover:text-text">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-6 space-y-3">
              {[
                ['channels', t('swarmArchitectPage.channelsTitle'), t('swarmArchitectPage.channelsDesc')],
                ['companyBrain', 'Company Brain', t('swarmArchitectPage.companyBrainDesc')],
                ['qualityChecks', 'Quality Checks', t('swarmArchitectPage.qualityChecksDesc')],
                ['crmHandoff', 'CRM / operator handoff', t('swarmArchitectPage.crmHandoffDesc')],
              ].map(([key, title, desc]) => {
                const checked = Boolean(teamSettings[key as keyof typeof teamSettings])
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTeamSettings((s) => ({ ...s, [key]: !checked }))}
                    className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left hover:border-violet/40"
                  >
                    <span className={`flex h-8 w-8 items-center justify-center rounded-full border ${checked ? 'border-teal/40 bg-teal/15 text-teal' : 'border-white/10 text-muted'}`}>
                      {checked && <Check className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-text">{title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">{desc}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-sm font-medium text-text">Runtime</p>
              <div className="mt-3 grid gap-2">
                {[
                  ['shared', 'Shared runtime', t('swarmArchitectPage.sharedDesc')],
                  ['dedicated', 'Dedicated VPS', t('swarmArchitectPage.dedicatedDesc')],
                  ['opensource', 'Open-source self-hosted', t('swarmArchitectPage.opensourceDesc')],
                ].map(([id, title, desc]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTeamSettings((s) => ({ ...s, runtime: id }))}
                    className={`rounded-xl border p-3 text-left transition ${teamSettings.runtime === id ? 'border-violet/60 bg-violet/10' : 'border-white/10 hover:border-white/25'}`}
                  >
                    <span className="block text-sm text-text">{title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <Button fullWidth className="mt-6" onClick={() => { void saveBlueprint(); setSettingsOpen(false) }}>
              <Save className="h-4 w-4" /> {t('swarmArchitectPage.saveSettings')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
