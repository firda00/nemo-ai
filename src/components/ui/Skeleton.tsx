import { cn } from '../../lib/cn'

/** Shimmer skeleton block (TZ 5: loading = skeleton, not a spinner). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />
}

/** A history row-shaped skeleton card. */
export function SkeletonRow() {
  return (
    <div className="flex items-start gap-4 rounded-2xl border border-ice/[0.1] bg-carbon p-4 sm:p-5">
      <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
      <div className="flex-1 space-y-2.5 py-0.5">
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
      <Skeleton className="h-5 w-14 rounded-full" />
    </div>
  )
}
