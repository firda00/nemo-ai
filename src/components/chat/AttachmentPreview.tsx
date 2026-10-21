import { useEffect, useRef } from 'react'

/** Local preview only; no upload until the user sends the message. */
export function AttachmentPreview({ file }: { file: File }) {
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return
    const next = URL.createObjectURL(file)
    if (image.current) image.current.src = next
    return () => URL.revokeObjectURL(next)
  }, [file])
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return null
  return <img ref={image} alt={file.name} className="h-12 w-16 shrink-0 rounded-lg object-cover" />
}
