// Seam-merging for windowed ASR: long recordings are transcribed in overlapping
// time windows (the overlap is re-transcribed on both sides), and the duplicated
// words at the seam are removed by finding the longest common contiguous word
// run between the previous window's tail and the next window's head. Pure logic,
// shared by transcribe-file and the offline behavior gate.

const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

// Minimum run of identical words to accept as "the same speech" — below this we
// keep both sides (a short accidental repeat is cheaper than losing a sentence).
export const MIN_SEAM_RUN_WORDS = 8
// How many words of tail/head to consider (30s of speech is ~60–90 words).
export const SEAM_SPAN_WORDS = 220
// The duplicated overlap can only live at the very SEAM: the run must end near
// prev's end and begin near next's start. Without this, a phrase repeated
// elsewhere in the meeting would delete the novel text before its reoccurrence.
export const SEAM_ALIGN_WORDS = 120

export function mergeTranscriptWindows(prev: string, next: string): string {
  const prevTrim = prev.trim()
  const nextTrim = next.trim()
  if (!prevTrim) return nextTrim
  if (!nextTrim) return prevTrim
  const prevWords = prevTrim.split(/\s+/)
  const nextWords = nextTrim.split(/\s+/)
  const tail = prevWords.slice(-SEAM_SPAN_WORDS).map(normWord)
  const head = nextWords.slice(0, SEAM_SPAN_WORDS).map(normWord)
  // longest ALIGNED common contiguous run (classic DP over the two seam spans);
  // a candidate run only qualifies when it ends within SEAM_ALIGN_WORDS of the
  // tail's end and starts within SEAM_ALIGN_WORDS of the head's beginning
  let bestLen = 0
  let bestHeadEnd = 0
  let prevRow = new Array<number>(head.length + 1).fill(0)
  for (let i = 1; i <= tail.length; i++) {
    const row = new Array<number>(head.length + 1).fill(0)
    for (let j = 1; j <= head.length; j++) {
      if (tail[i - 1] && tail[i - 1] === head[j - 1]) {
        row[j] = prevRow[j - 1] + 1
        const runLen = row[j]
        const alignedToTail = tail.length - i <= SEAM_ALIGN_WORDS
        const alignedToHead = j - runLen <= SEAM_ALIGN_WORDS
        if (runLen > bestLen && alignedToTail && alignedToHead) { bestLen = runLen; bestHeadEnd = j }
      }
    }
    prevRow = row
  }
  if (bestLen < MIN_SEAM_RUN_WORDS) return `${prevTrim}\n${nextTrim}`
  // everything in `next` up to (and including) the aligned run duplicates audio
  // already covered by `prev`'s tail
  const rest = nextWords.slice(bestHeadEnd).join(' ').trim()
  return rest ? `${prevTrim}\n${rest}` : prevTrim
}
