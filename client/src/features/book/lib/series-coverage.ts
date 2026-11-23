const MAX_VOLUME = 10_000

export function parseCoveredVolumes(value: string | undefined): number[] | null {
  if (!value?.trim()) return []
  const volumes = new Set<number>()
  for (const part of value.split(',')) {
    const range = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part.trim())
    if (!range) return null
    const first = Number(range[1])
    const last = Number(range[2] ?? range[1])
    if (first < 1 || first > last || last > MAX_VOLUME) return null
    for (let volume = first; volume <= last; volume++) volumes.add(volume)
  }
  return [...volumes].sort((a, b) => a - b)
}

export function formatCoveredVolumes(volumes: readonly number[]): string {
  const ranges: string[] = []
  let first: number | undefined
  let last: number | undefined
  for (const volume of volumes) {
    if (first === undefined || last === undefined || volume !== last + 1) {
      if (first !== undefined) ranges.push(first === last ? String(first) : `${first}-${last}`)
      first = volume
    }
    last = volume
  }
  if (first !== undefined) ranges.push(first === last ? String(first) : `${first}-${last}`)
  return ranges.join(', ')
}
