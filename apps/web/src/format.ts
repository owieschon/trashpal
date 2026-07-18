export function formatCaseTime(value: string, timeZone: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Time not available'
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(parsed)
}

export function formatTimeRange(start: string, end: string, timeZone: string): string {
  const startLabel = formatCaseTime(start, timeZone)
  const endDate = new Date(end)
  if (Number.isNaN(endDate.getTime())) return startLabel
  const endLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(endDate)
  return `${startLabel}–${endLabel.replace(' CDT', '').replace(' CST', '')}`
}

export function humanize(value: string): string {
  return value
    .replaceAll(/[_-]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function shortDigest(value: string): string {
  return value.length > 17 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value
}
