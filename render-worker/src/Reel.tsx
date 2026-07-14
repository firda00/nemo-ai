import React from 'react'
import {
  AbsoluteFill,
  Img,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  type CalculateMetadataFunction,
} from 'remotion'
import { TransitionSeries, linearTiming } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { loadFont } from '@remotion/google-fonts/Montserrat'

// Montserrat ships a Cyrillic subset — deterministic text rendering on a headless box
// that may not have Cyrillic system fonts. Restrict to the weights/subsets we actually use
// so a render makes a handful of font requests instead of ~90.
const { fontFamily } = loadFont('normal', {
  weights: ['700', '800'],
  subsets: ['cyrillic', 'latin'],
  ignoreTooManyRequestsWarning: true,
})

export const FPS = 30
const TRANSITION = 15 // frames of cross-fade between scenes
const DEFAULT_SCENE_SEC = 3

// Vertical Reels canvas per quality tier. The worker maps its OWN allowlist —
// callers send an enum, never dimensions. 1080p is the design reference: all
// typography/spacing below scales by width/1080.
export const QUALITY_CANVAS: Record<string, { width: number; height: number }> = {
  '720p': { width: 720, height: 1280 },
  '1080p': { width: 1080, height: 1920 },
  '4k': { width: 2160, height: 3840 },
}

export type Scene = { imageUrl?: string; caption?: string; durationSec?: number }
export type ReelProps = {
  title?: string
  brand?: string
  accent?: string
  scenes: Scene[]
  audioUrl?: string
  quality?: string
}

export const reelDefaults: ReelProps = {
  title: 'Как выучить английский за 3 месяца',
  brand: 'Nemo AI',
  accent: '#8B7CF8',
  audioUrl: undefined,
  scenes: [
    { caption: 'Устали учить, но не говорить?', durationSec: 3 },
    { caption: '3 месяца — реальный план, а не обещание', durationSec: 3 },
    { caption: 'Начни говорить уже на первой неделе', durationSec: 3 },
  ],
}

const sceneFrames = (s: Scene) => Math.max(FPS, Math.round((s.durationSec ?? DEFAULT_SCENE_SEC) * FPS))

export const calcReelMetadata: CalculateMetadataFunction<ReelProps> = ({ props }) => {
  const scenes = props.scenes?.length ? props.scenes : reelDefaults.scenes
  const total = scenes.reduce((a, s) => a + sceneFrames(s), 0) - Math.max(0, scenes.length - 1) * TRANSITION
  const canvas = QUALITY_CANVAS[props.quality ?? ''] ?? QUALITY_CANVAS['1080p']
  return { durationInFrames: Math.max(FPS, total), fps: FPS, width: canvas.width, height: canvas.height }
}

const SceneView: React.FC<{ scene: Scene; accent: string; title?: string; brand?: string }> = ({ scene, accent, title, brand }) => {
  const frame = useCurrentFrame()
  const { fps, width } = useVideoConfig()
  // scale factor vs the 1080p design reference, so 720p/4K keep identical composition
  const k = width / 1080

  // Ken Burns — slow zoom keeps a still image alive.
  const zoom = interpolate(frame, [0, 6 * fps], [1.06, 1.18], { extrapolateRight: 'clamp' })
  // Caption entrance — spring fade + slide up from its reserved slot.
  const appear = spring({ frame, fps, config: { damping: 200 }, durationInFrames: Math.round(0.8 * fps) })
  const slide = interpolate(appear, [0, 1], [46 * k, 0])

  return (
    <AbsoluteFill style={{ backgroundColor: '#0A0D1C' }}>
      {scene.imageUrl ? (
        <AbsoluteFill>
          <Img src={scene.imageUrl} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})` }} />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ background: `radial-gradient(120% 80% at 50% 20%, ${accent}44, #0A0D1C 70%)` }} />
      )}

      {/* readability scrim at the bottom third */}
      <AbsoluteFill style={{ background: 'linear-gradient(to top, rgba(5,7,15,0.94) 4%, rgba(5,7,15,0.45) 34%, rgba(0,0,0,0) 60%)' }} />

      {/* content column — everything lives in a layout slot (no manual overlap) */}
      <AbsoluteFill style={{ padding: `0 ${80 * k}px ${160 * k}px`, justifyContent: 'flex-end', alignItems: 'center', textAlign: 'center', fontFamily }}>
        {title ? (
          <div style={{ color: '#fff', fontSize: 84 * k, lineHeight: 1.08, fontWeight: 800, marginBottom: 28 * k, textShadow: `0 ${6 * k}px ${30 * k}px rgba(0,0,0,0.65)` }}>{title}</div>
        ) : null}
        {scene.caption ? (
          <div style={{ opacity: appear, transform: `translateY(${slide}px)`, color: '#fff', fontSize: (title ? 48 : 72) * k, lineHeight: 1.16, fontWeight: 700, textShadow: `0 ${4 * k}px ${24 * k}px rgba(0,0,0,0.6)` }}>{scene.caption}</div>
        ) : null}
        {brand ? (
          <div style={{ marginTop: 34 * k, color: accent, fontSize: 34 * k, fontWeight: 700, letterSpacing: 1 * k }}>{brand}</div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

export const Reel: React.FC<ReelProps> = ({ title, brand, accent = '#8B7CF8', scenes, audioUrl }) => {
  const list = scenes?.length ? scenes.slice(0, 8) : reelDefaults.scenes

  // Build a flat, alternating [Sequence, Transition, Sequence, ...] child list.
  const children: React.ReactNode[] = []
  list.forEach((s, i) => {
    children.push(
      <TransitionSeries.Sequence key={`s${i}`} durationInFrames={sceneFrames(s)}>
        <SceneView scene={s} accent={accent} title={i === 0 ? title : undefined} brand={brand} />
      </TransitionSeries.Sequence>,
    )
    if (i < list.length - 1) {
      children.push(
        <TransitionSeries.Transition key={`t${i}`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />,
      )
    }
  })

  return (
    <AbsoluteFill style={{ backgroundColor: '#0A0D1C' }}>
      <TransitionSeries>{children}</TransitionSeries>
      {audioUrl ? <Audio src={audioUrl} /> : null}
    </AbsoluteFill>
  )
}
