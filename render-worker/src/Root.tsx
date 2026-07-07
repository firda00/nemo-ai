import React from 'react'
import { Composition } from 'remotion'
import { Reel, reelDefaults, calcReelMetadata, FPS } from './Reel'

// Vertical short (Reels/Shorts/TikTok). Duration is derived from the scenes via
// calculateMetadata, so inputProps alone determine the length at render time.
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Reel"
      component={Reel}
      durationInFrames={270}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={reelDefaults}
      calculateMetadata={calcReelMetadata}
    />
  )
}
