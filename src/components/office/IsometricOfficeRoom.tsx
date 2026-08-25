import { useEffect, useRef } from 'react'

export type OfficeAgentState = 'idle' | 'walking' | 'working' | 'waiting_approval'
export type OfficeAgentRole = 'coordinator' | 'copywriter' | 'finance' | 'media' | 'specialist'

export interface OfficeAgentNode {
  id: string
  name: string
  role: OfficeAgentRole
  state: Exclude<OfficeAgentState, 'walking'>
  status: string
}

interface Point { x: number; y: number }

interface AnimatedAgent extends OfficeAgentNode {
  position: Point
  target: Point
  visualState: OfficeAgentState
  bubbleUntil: number
  lastStatus: string
}

const WORLD = { width: 1000, height: 700 }
const BACKGROUND = '/assets/office/team-lead-hq.jpg'
const SPRITES: Record<OfficeAgentRole, string> = {
  coordinator: '/assets/office/sprites/coordinator.png',
  copywriter: '/assets/office/sprites/copywriter.png',
  finance: '/assets/office/sprites/finance.png',
  media: '/assets/office/sprites/media.png',
  specialist: '/assets/office/sprites/finance.png',
}

const WORKSTATIONS: Record<OfficeAgentRole, Point> = {
  coordinator: { x: 0.50, y: 0.47 },
  copywriter: { x: 0.33, y: 0.56 },
  finance: { x: 0.61, y: 0.30 },
  media: { x: 0.69, y: 0.54 },
  specialist: { x: 0.62, y: 0.68 },
}

const IDLE_SPOTS: Point[] = [
  { x: 0.35, y: 0.76 },
  { x: 0.43, y: 0.77 },
  { x: 0.33, y: 0.39 },
  { x: 0.68, y: 0.73 },
  { x: 0.65, y: 0.78 },
  { x: 0.58, y: 0.77 },
]

const MEETING_SPOTS: Point[] = [
  { x: 0.45, y: 0.51 }, { x: 0.54, y: 0.51 }, { x: 0.49, y: 0.58 },
]

function destination(agent: OfficeAgentNode, index: number): Point {
  if (agent.state === 'waiting_approval') return MEETING_SPOTS[index % MEETING_SPOTS.length]
  if (agent.state === 'working') {
    if (agent.role === 'specialist') {
      return { x: WORKSTATIONS.specialist.x + (index % 3) * 0.07, y: WORKSTATIONS.specialist.y - (index % 2) * 0.09 }
    }
    return WORKSTATIONS[agent.role]
  }
  return IDLE_SPOTS[index % IDLE_SPOTS.length]
}

function initialPosition(agent: OfficeAgentNode, index: number): Point {
  if (agent.role === 'coordinator') return WORKSTATIONS.coordinator
  return IDLE_SPOTS[index % IDLE_SPOTS.length]
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const ratio = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawnWidth = image.naturalWidth * ratio
  const drawnHeight = image.naturalHeight * ratio
  context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight)
}

function drawAvatar(
  context: CanvasRenderingContext2D,
  agent: AnimatedAgent,
  image: HTMLImageElement | undefined,
  now: number,
  reducedMotion: boolean,
) {
  const x = agent.position.x * WORLD.width
  const walkingBob = agent.visualState === 'walking' && !reducedMotion ? Math.sin(now / 90) * 4 : 0
  const y = agent.position.y * WORLD.height + walkingBob
  const radius = agent.role === 'coordinator' ? 34 : 30
  const active = agent.visualState === 'working' || agent.visualState === 'waiting_approval'

  context.save()
  context.shadowColor = active ? '#22d3ee' : 'rgba(15,23,42,.55)'
  context.shadowBlur = active ? 22 : 10
  context.fillStyle = active ? '#ecfeff' : '#f8fafc'
  context.beginPath()
  context.arc(x, y, radius + 5, 0, Math.PI * 2)
  context.fill()
  context.shadowBlur = 0

  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.clip()
  if (image?.complete && image.naturalWidth) {
    context.drawImage(image, x - radius, y - radius, radius * 2, radius * 2)
  } else {
    context.fillStyle = '#111827'
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }
  context.restore()

  context.save()
  context.font = '600 12px Inter, ui-sans-serif, system-ui'
  context.textAlign = 'center'
  const labelWidth = Math.min(138, Math.max(70, context.measureText(agent.name).width + 22))
  roundedRect(context, x - labelWidth / 2, y + radius + 8, labelWidth, 25, 12)
  context.fillStyle = 'rgba(3,7,18,.82)'
  context.fill()
  context.strokeStyle = active ? 'rgba(34,211,238,.72)' : 'rgba(255,255,255,.22)'
  context.stroke()
  context.fillStyle = '#f8fafc'
  context.fillText(agent.name, x, y + radius + 25)
  context.restore()

  if (agent.bubbleUntil > now) {
    context.save()
    context.font = '600 13px Inter, ui-sans-serif, system-ui'
    const safeStatus = agent.status.slice(0, 42)
    const bubbleWidth = Math.min(230, Math.max(122, context.measureText(safeStatus).width + 30))
    const bubbleX = Math.min(WORLD.width - bubbleWidth - 12, Math.max(12, x - bubbleWidth / 2))
    const bubbleY = Math.max(14, y - radius - 58)
    roundedRect(context, bubbleX, bubbleY, bubbleWidth, 38, 16)
    context.fillStyle = 'rgba(255,255,255,.96)'
    context.shadowColor = 'rgba(15,23,42,.24)'
    context.shadowBlur = 18
    context.fill()
    context.shadowBlur = 0
    context.fillStyle = '#111827'
    context.textAlign = 'center'
    context.fillText(safeStatus, bubbleX + bubbleWidth / 2, bubbleY + 24)
    context.beginPath()
    context.moveTo(x - 7, bubbleY + 38)
    context.lineTo(x + 7, bubbleY + 38)
    context.lineTo(x, bubbleY + 47)
    context.closePath()
    context.fillStyle = 'rgba(255,255,255,.96)'
    context.fill()
    context.restore()
  }
}

export function IsometricOfficeRoom({ agents, deskCount }: { agents: OfficeAgentNode[]; deskCount: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<number | null>(null)
  const runtimeRef = useRef<AnimatedAgent[]>([])
  const backgroundRef = useRef<HTMLImageElement | null>(null)
  const spriteRef = useRef<Partial<Record<OfficeAgentRole, HTMLImageElement>>>({})
  const reducedMotionRef = useRef(false)

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const background = new Image()
    background.decoding = 'async'
    background.src = BACKGROUND
    backgroundRef.current = background
    ;(Object.entries(SPRITES) as [OfficeAgentRole, string][]).forEach(([role, source]) => {
      const image = new Image()
      image.decoding = 'async'
      image.src = source
      spriteRef.current[role] = image
    })
    return () => {
      backgroundRef.current = null
      spriteRef.current = {}
    }
  }, [])

  useEffect(() => {
    const now = performance.now()
    const currentById = new Map(runtimeRef.current.map((agent) => [agent.id, agent]))
    runtimeRef.current = agents.map((agent, index) => {
      const current = currentById.get(agent.id)
      const target = destination(agent, index)
      if (!current) {
        const position = initialPosition(agent, index)
        return { ...agent, position, target, visualState: agent.state, bubbleUntil: now + 3200, lastStatus: agent.status }
      }
      const statusChanged = current.lastStatus !== agent.status || current.state !== agent.state
      return {
        ...current,
        ...agent,
        target,
        bubbleUntil: statusChanged ? now + 3200 : current.bubbleUntil,
        lastStatus: agent.status,
      }
    })
  }, [agents])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    let disposed = false
    let lastFrame = performance.now()
    let cssWidth = 1
    let cssHeight = 1
    let deviceScale = 1

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      deviceScale = Math.min(2, window.devicePixelRatio || 1)
      cssWidth = Math.max(1, rect.width)
      cssHeight = Math.max(1, rect.height)
      const width = Math.max(1, Math.round(cssWidth * deviceScale))
      const height = Math.max(1, Math.round(cssHeight * deviceScale))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const render = (now: number) => {
      if (disposed) return
      const delta = Math.min(0.034, Math.max(0, (now - lastFrame) / 1000))
      lastFrame = now
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      const worldScale = Math.max(cssWidth / WORLD.width, cssHeight / WORLD.height)
      const offsetX = (cssWidth - WORLD.width * worldScale) / 2
      const offsetY = (cssHeight - WORLD.height * worldScale) / 2
      context.setTransform(
        deviceScale * worldScale, 0, 0, deviceScale * worldScale,
        deviceScale * offsetX, deviceScale * offsetY,
      )
      context.clearRect(0, 0, WORLD.width, WORLD.height)
      const background = backgroundRef.current
      if (background?.complete && background.naturalWidth) drawCover(context, background, WORLD.width, WORLD.height)
      else {
        context.fillStyle = '#0b1220'
        context.fillRect(0, 0, WORLD.width, WORLD.height)
      }

      const shade = context.createLinearGradient(0, 0, 0, WORLD.height)
      shade.addColorStop(0, 'rgba(4,9,20,.05)')
      shade.addColorStop(1, 'rgba(4,9,20,.28)')
      context.fillStyle = shade
      context.fillRect(0, 0, WORLD.width, WORLD.height)

      const agentsByDepth = [...runtimeRef.current].sort((a, b) => a.position.y - b.position.y)
      agentsByDepth.forEach((agent) => {
        const dx = agent.target.x - agent.position.x
        const dy = agent.target.y - agent.position.y
        const distance = Math.hypot(dx, dy)
        if (distance > 0.004 && !reducedMotionRef.current) {
          const step = Math.min(distance, delta * 0.17)
          agent.position.x += (dx / distance) * step
          agent.position.y += (dy / distance) * step
          agent.visualState = 'walking'
        } else {
          agent.position = { ...agent.target }
          agent.visualState = agent.state
        }
        drawAvatar(context, agent, spriteRef.current[agent.role], now, reducedMotionRef.current)
      })

      const freeDesks = Math.max(0, deskCount - agents.length)
      if (freeDesks) {
        context.save()
        roundedRect(context, 610, 620, 218, 44, 16)
        context.fillStyle = 'rgba(3,7,18,.78)'
        context.fill()
        context.fillStyle = '#e2e8f0'
        context.font = '600 13px Inter, ui-sans-serif, system-ui'
        context.textAlign = 'center'
        context.fillText(`${freeDesks} свободных рабочих мест`, 719, 647)
        context.restore()
      }

      frameRef.current = requestAnimationFrame(render)
    }
    frameRef.current = requestAnimationFrame(render)
    return () => {
      disposed = true
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [deskCount])

  return (
    <div className="relative h-full min-h-[430px] overflow-hidden bg-[#07101d] lg:min-h-[680px]">
      <canvas
        ref={canvasRef}
        className="h-full min-h-[430px] w-full lg:min-h-[680px]"
        role="img"
        aria-label="Живой изометрический офис Nemo: агенты перемещаются между рабочими местами, зоной отдыха и переговорной"
        data-testid="isometric-office-canvas"
      />
      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-center justify-between gap-3">
        <div className="rounded-full border border-white/15 bg-[#06101c]/75 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-xl backdrop-blur-md">
          Isometric workspace · Live
        </div>
        <div className="rounded-full border border-cyan-300/20 bg-[#06101c]/75 px-3 py-1.5 text-[11px] font-medium text-cyan-100 backdrop-blur-md">
          rAF · 60 FPS target
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-wrap gap-2 text-[11px] font-medium text-white">
        <span className="rounded-full border border-white/15 bg-[#06101c]/75 px-3 py-1.5 backdrop-blur-md">{agents.length} агентов</span>
        <span className="rounded-full border border-white/15 bg-[#06101c]/75 px-3 py-1.5 backdrop-blur-md">{deskCount} столов</span>
      </div>
    </div>
  )
}
