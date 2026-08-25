import { useEffect, useRef } from 'react'

export type OfficeAgentState = 'idle' | 'working' | 'complete' | 'waiting_approval'
export type OfficeAgentRole = 'coordinator' | 'copywriter' | 'finance' | 'media' | 'specialist'

export interface OfficeAgentNode {
  id: string
  name: string
  role: OfficeAgentRole
  state: OfficeAgentState
  status: string
}

interface DeskSlot { x: number; y: number; scale: number }
interface RenderAgent extends OfficeAgentNode {
  slot: number
  spawnProgress: number
  bubbleUntil: number
  lastStatus: string
  stateSince: number
}

const WORLD = { width: 1000, height: 700 }
const BACKGROUND = '/assets/office/team-lead-hq.jpg'
const DESKS: Record<OfficeAgentRole, string> = {
  coordinator: '/assets/office/workstations/engineer-desk.png',
  copywriter: '/assets/office/workstations/creative-desk.png',
  finance: '/assets/office/workstations/finance-desk.png',
  media: '/assets/office/workstations/media-desk.png',
  specialist: '/assets/office/workstations/engineer-desk.png',
}
const COMPLETE: Record<OfficeAgentRole, string> = {
  coordinator: '/assets/office/workstations/lead-complete.png',
  copywriter: '/assets/office/workstations/copy-complete.png',
  finance: '/assets/office/workstations/engineer-complete.png',
  media: '/assets/office/workstations/media-complete.png',
  specialist: '/assets/office/workstations/engineer-complete.png',
}

const SLOTS: DeskSlot[] = [
  { x: 0.40, y: 0.27, scale: 0.145 },
  { x: 0.50, y: 0.24, scale: 0.15 },
  { x: 0.60, y: 0.27, scale: 0.145 },
  { x: 0.40, y: 0.57, scale: 0.15 },
  { x: 0.50, y: 0.55, scale: 0.155 },
  { x: 0.60, y: 0.57, scale: 0.15 },
  { x: 0.50, y: 0.77, scale: 0.14 },
]

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

function drawSpeechBubble(context: CanvasRenderingContext2D, x: number, y: number, status: string, tone: string) {
  context.save()
  context.font = '700 13px Inter, ui-sans-serif, system-ui'
  const safeStatus = status.slice(0, 44)
  const width = Math.min(190, Math.max(120, context.measureText(safeStatus).width + 28))
  const left = Math.max(12, Math.min(WORLD.width - width - 12, x - width / 2))
  const top = Math.max(12, y - 56)
  roundedRect(context, left, top, width, 40, 15)
  context.fillStyle = 'rgba(255,255,255,.97)'
  context.shadowColor = 'rgba(3,7,18,.32)'
  context.shadowBlur = 20
  context.fill()
  context.shadowBlur = 0
  context.strokeStyle = tone
  context.lineWidth = 1.5
  context.stroke()
  context.fillStyle = '#0f172a'
  context.textAlign = 'center'
  context.fillText(safeStatus, left + width / 2, top + 25)
  context.beginPath()
  context.moveTo(x - 7, top + 40)
  context.lineTo(x + 7, top + 40)
  context.lineTo(x, top + 49)
  context.closePath()
  context.fillStyle = '#fff'
  context.fill()
  context.restore()
}

function drawAgentDesk(
  context: CanvasRenderingContext2D,
  agent: RenderAgent,
  desk: HTMLImageElement | undefined,
  complete: HTMLImageElement | undefined,
  now: number,
  reducedMotion: boolean,
) {
  const slot = SLOTS[agent.slot % SLOTS.length]
  const x = slot.x * WORLD.width
  const y = slot.y * WORLD.height
  const workingPulse = agent.state === 'working' && !reducedMotion ? (Math.sin(now / 155) + 1) / 2 : 0
  const completeBounce = agent.state === 'complete' && !reducedMotion ? Math.abs(Math.sin((now - agent.stateSince) / 210)) * 10 : 0
  const spawnEase = 1 - Math.pow(1 - Math.min(1, agent.spawnProgress), 3)
  const deskSize = WORLD.width * slot.scale
  const imageRatio = desk?.naturalWidth && desk?.naturalHeight ? desk.naturalHeight / desk.naturalWidth : 1
  const deskHeight = deskSize * imageRatio
  const scale = (0.88 + spawnEase * 0.12) * (agent.state === 'working' ? 1 + workingPulse * 0.012 : 1)
  const drawWidth = deskSize * scale
  const drawHeight = deskHeight * scale
  const left = x - drawWidth / 2
  const top = y - drawHeight / 2 - completeBounce
  const active = agent.state === 'working' || agent.state === 'complete' || agent.state === 'waiting_approval'
  const tone = agent.state === 'waiting_approval' ? '#f59e0b' : agent.state === 'complete' ? '#10b981' : '#22d3ee'

  context.save()
  context.globalAlpha = spawnEase * (agent.state === 'idle' ? 0.9 : 1)
  context.shadowColor = active ? tone : 'rgba(3,7,18,.42)'
  context.shadowBlur = active ? 20 + workingPulse * 18 : 12
  if (desk?.complete && desk.naturalWidth) context.drawImage(desk, left, top, drawWidth, drawHeight)
  context.restore()

  if (agent.state === 'working') {
    context.save()
    const glow = context.createRadialGradient(x, y - drawHeight * 0.13, 4, x, y - drawHeight * 0.13, drawWidth * 0.3)
    glow.addColorStop(0, `rgba(34,211,238,${0.24 + workingPulse * 0.22})`)
    glow.addColorStop(1, 'rgba(34,211,238,0)')
    context.fillStyle = glow
    context.fillRect(left, top, drawWidth, drawHeight)
    context.restore()
  }

  if (agent.state === 'complete' && complete?.complete && complete.naturalWidth) {
    const resultHeight = drawHeight * 0.62
    const resultWidth = resultHeight * (complete.naturalWidth / complete.naturalHeight)
    context.save()
    context.shadowColor = '#10b981'
    context.shadowBlur = 18
    context.drawImage(complete, x + drawWidth * 0.12, top + drawHeight * 0.08 - completeBounce, resultWidth, resultHeight)
    context.restore()
  }

  context.save()
  const labelWidth = Math.min(190, Math.max(112, context.measureText(agent.name).width + 42))
  roundedRect(context, x - labelWidth / 2, y + drawHeight * 0.38, labelWidth, 31, 11)
  context.fillStyle = 'rgba(3,7,18,.86)'
  context.fill()
  context.strokeStyle = active ? tone : 'rgba(255,255,255,.22)'
  context.lineWidth = 1.3
  context.stroke()
  context.fillStyle = '#f8fafc'
  context.font = '700 12px Inter, ui-sans-serif, system-ui'
  context.textAlign = 'center'
  context.fillText(agent.name, x, y + drawHeight * 0.38 + 20)
  context.restore()

  if (agent.bubbleUntil > now || agent.state === 'waiting_approval' || agent.state === 'complete') {
    const bubbleOffset = (agent.slot % 3) * 44
    drawSpeechBubble(context, x, top + drawHeight * 0.04 + bubbleOffset, agent.status, tone)
  }
}

export function IsometricOfficeRoom({ agents, deskCount }: { agents: OfficeAgentNode[]; deskCount: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<number | null>(null)
  const runtimeRef = useRef<RenderAgent[]>([])
  const backgroundRef = useRef<HTMLImageElement | null>(null)
  const deskImagesRef = useRef<Partial<Record<OfficeAgentRole, HTMLImageElement>>>({})
  const completeImagesRef = useRef<Partial<Record<OfficeAgentRole, HTMLImageElement>>>({})
  const reducedMotionRef = useRef(false)

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const background = new Image()
    background.decoding = 'async'
    background.src = BACKGROUND
    backgroundRef.current = background
    ;(Object.entries(DESKS) as [OfficeAgentRole, string][]).forEach(([role, source]) => {
      const image = new Image()
      image.decoding = 'async'
      image.src = source
      deskImagesRef.current[role] = image
    })
    ;(Object.entries(COMPLETE) as [OfficeAgentRole, string][]).forEach(([role, source]) => {
      const image = new Image()
      image.decoding = 'async'
      image.src = source
      completeImagesRef.current[role] = image
    })
    return () => {
      backgroundRef.current = null
      deskImagesRef.current = {}
      completeImagesRef.current = {}
    }
  }, [])

  useEffect(() => {
    const now = performance.now()
    const previous = new Map(runtimeRef.current.map((agent) => [agent.id, agent]))
    runtimeRef.current = agents.map((agent, index) => {
      const current = previous.get(agent.id)
      if (!current) {
        return { ...agent, slot: index, spawnProgress: reducedMotionRef.current ? 1 : 0, bubbleUntil: now + 3200, lastStatus: agent.status, stateSince: now }
      }
      const changed = current.state !== agent.state || current.lastStatus !== agent.status
      return {
        ...current,
        ...agent,
        slot: index,
        bubbleUntil: changed ? now + 3200 : current.bubbleUntil,
        lastStatus: agent.status,
        stateSince: changed ? now : current.stateSince,
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
    let fpsWindowStart = lastFrame
    let fpsFrameCount = 0
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
      fpsFrameCount += 1
      if (now - fpsWindowStart >= 1000) {
        canvas.dataset.renderFps = String(Math.round((fpsFrameCount * 1000) / (now - fpsWindowStart)))
        fpsWindowStart = now
        fpsFrameCount = 0
      }
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      const worldScale = Math.max(cssWidth / WORLD.width, cssHeight / WORLD.height)
      const offsetX = (cssWidth - WORLD.width * worldScale) / 2
      const offsetY = (cssHeight - WORLD.height * worldScale) / 2
      context.setTransform(deviceScale * worldScale, 0, 0, deviceScale * worldScale, deviceScale * offsetX, deviceScale * offsetY)

      const background = backgroundRef.current
      if (background?.complete && background.naturalWidth) drawCover(context, background, WORLD.width, WORLD.height)
      else {
        context.fillStyle = '#07101d'
        context.fillRect(0, 0, WORLD.width, WORLD.height)
      }
      context.fillStyle = 'rgba(3,7,18,.52)'
      context.fillRect(0, 0, WORLD.width, WORLD.height)

      runtimeRef.current.forEach((agent) => {
        agent.spawnProgress = Math.min(1, agent.spawnProgress + delta * 2.4)
        drawAgentDesk(context, agent, deskImagesRef.current[agent.role], completeImagesRef.current[agent.role], now, reducedMotionRef.current)
      })
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
    <div className="relative h-full min-h-[500px] overflow-hidden bg-[#07101d] lg:min-h-[720px]">
      <canvas
        ref={canvasRef}
        className="h-full min-h-[500px] w-full lg:min-h-[720px]"
        role="img"
        aria-label="Живой изометрический офис Nemo: полноценные рабочие места появляются вместе с агентами и отражают их реальный статус"
        data-testid="isometric-office-canvas"
      />
      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-center justify-between gap-3">
        <span className="rounded-full border border-white/15 bg-[#06101c]/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-xl backdrop-blur-md">Live team floor</span>
        <span className="hidden rounded-full border border-cyan-300/20 bg-[#06101c]/80 px-3 py-1.5 text-[11px] font-medium text-cyan-100 backdrop-blur-md sm:inline-flex">Canvas · managed rAF</span>
      </div>
      <div className="pointer-events-none absolute bottom-4 left-4 flex gap-2 text-[11px] font-medium text-white">
        <span className="rounded-full border border-white/15 bg-[#06101c]/80 px-3 py-1.5 backdrop-blur-md">{agents.length} online</span>
        <span className="rounded-full border border-white/15 bg-[#06101c]/80 px-3 py-1.5 backdrop-blur-md">{deskCount} workstations</span>
      </div>
    </div>
  )
}
