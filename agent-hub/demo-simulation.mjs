// Interactive CLI simulation of Nemo AI Multi-Agent Orchestration.
// Run using: node agent-hub/demo-simulation.mjs

import { setTimeout } from 'node:timers/promises'

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  violet: '\x1b[35m',
  teal: '\x1b[32m',
  blue: '\x1b[34m',
  amber: '\x1b[33m',
  gray: '\x1b[90m',
}

const agents = [
  { id: 'leader', name: 'Team Leader', role: 'Routes intent', color: colors.violet, desc: 'Analyzing intent...' },
  { id: 'knowledge', name: 'Knowledge Agent', role: 'RAG Search', color: colors.cyan, desc: 'Searching Company Brain...' },
  { id: 'sales', name: 'Sales Qualifier', role: 'Qualifies customer', color: colors.teal, desc: 'Structuring customer requirements...' },
  { id: 'crm', name: 'CRM Handoff', role: 'Updates database', color: colors.blue, desc: 'Writing lead payload to database...' },
  { id: 'quality', name: 'Quality Reviewer', role: 'Guardrails check', color: colors.amber, desc: 'Verifying tone & constraints...' },
]

const trace = [
  'Team Leader: Buying intent identified (Interested in product & timeline)',
  'Knowledge Agent: Found matching pricing policies & scheduler limits in Knowledge Docs',
  'Sales Qualifier: Validated phone structure & scheduled follow-up reminder',
  'CRM Handoff: Created lead row in public.leads (concurrency token locked)',
  'Quality Reviewer: Passed guardrail check (0 violations, professional tone)',
]

async function run() {
  console.clear()
  console.log(`${colors.bold}${colors.cyan}====================================================${colors.reset}`)
  console.log(`${colors.bold}🚀 NEMO AI — MULTI-AGENT SWARM SIMULATOR${colors.reset}`)
  console.log(`${colors.bold}${colors.cyan}====================================================${colors.reset}\n`)

  console.log(`${colors.bold}📥 Customer Input:${colors.reset} "How much is the plan and can I connect a bot today?"\n`)
  await setTimeout(1000)

  console.log(`${colors.bold}🧠 Swarm orchestration started...${colors.reset}\n`)
  await setTimeout(1000)

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]
    console.log(`${agent.color}[ACTIVE] ${agent.name} (${agent.role}) is starting...${colors.reset}`)
    console.log(`${colors.gray}   └─ ${agent.desc}${colors.reset}`)
    await setTimeout(1500)
    console.log(`${agent.color}   ✔ Done: ${trace[i]}${colors.reset}\n`)
    await setTimeout(800)
  }

  console.log(`${colors.bold}${colors.cyan}====================================================${colors.reset}`)
  console.log(`${colors.bold}🎯 Swarm Result Metrics:${colors.reset}`)
  console.log(` - ${colors.bold}Nemo Score:${colors.reset} 94%`)
  console.log(` - ${colors.bold}Response time:${colors.reset} 0.8s`)
  console.log(` - ${colors.bold}Token Cost:${colors.reset} $0.03`)
  console.log(` - ${colors.bold}Lead payload status:${colors.reset} Created in CRM`)
  console.log(` - ${colors.bold}Quality status:${colors.reset} PASS (Green)`)
  console.log(`${colors.bold}${colors.cyan}====================================================${colors.reset}\n`)

  console.log(`${colors.bold}📤 Final Response to Client:${colors.reset}`)
  console.log(`${colors.teal}"Yes, absolutely! The standard plan is $199/month. Please share your phone number so our advisor can confirm your schedule and help you connect a bot."${colors.reset}\n`)
}

run().catch(console.error)
