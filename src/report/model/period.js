const DAY_MS = 86_400_000

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDay(day) {
  const m = DAY_RE.exec(day)
  if (m === null) throw new Error(`invalid day (expected YYYY-MM-DD): ${day}`)
  const y = Number(m[1])
  const mo = Number(m[2])
  const da = Number(m[3])
  const d = new Date(Date.UTC(y, mo - 1, da))
  if (Number.isNaN(d.getTime())) throw new Error(`invalid day: ${day}`)
  return d
}

function fmt(d) {
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

function addDays(day, n) {
  return fmt(new Date(parseDay(day).getTime() + n * DAY_MS))
}

/** Inclusive day count between two day strings (to - from + 1). */
function spanDays(from, to) {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS) + 1
}

/** Shift an ISO day string by n days (UTC). Exported for window math in the assembler. */
export function shiftDay(day, n) {
  return addDays(day, n)
}

/** Build a Period (current + prior comparable window) for a cadence and anchor day. */
export function resolvePeriod(opts) {
  const { cadence, periodEnd } = opts
  // Validate the anchor up-front so every branch can rely on it.
  parseDay(periodEnd)

  switch (cadence) {
    case 'weekly':
      return trailingWindow('weekly', periodEnd, 7, (from, to) => `Week of ${from} – ${to}`)

    case 'sprint': {
      if (opts.sprintFrom !== undefined && opts.sprintTo !== undefined) {
        const from = opts.sprintFrom
        const to = opts.sprintTo
        parseDay(from)
        parseDay(to)
        const len = spanDays(from, to)
        const priorTo = addDays(from, -1)
        const priorFrom = addDays(priorTo, -(len - 1))
        return {
          cadence,
          from,
          to,
          label: `Sprint ending ${to}`,
          priorFrom,
          priorTo,
          priorLabel: `Sprint ending ${priorTo}`,
        }
      }
      const len = opts.windowDays ?? 14
      return trailingWindow('sprint', periodEnd, len, (_from, to) => `Sprint ending ${to}`)
    }

    case 'monthly':
      return calendarMonth(periodEnd)

    case 'quarterly':
      return calendarQuarter(periodEnd)

    case 'annual':
      return calendarYear(periodEnd)

    case 'custom':
      return trailingWindow(
        'custom',
        periodEnd,
        opts.windowDays ?? 30,
        (from, to) => `${from} – ${to}`,
      )

    default: {
      // Exhaustiveness guard.
      const never = cadence
      throw new Error(`unsupported cadence: ${String(never)}`)
    }
  }
}

function trailingWindow(cadence, periodEnd, len, label) {
  const to = periodEnd
  const from = addDays(to, -(len - 1))
  const priorTo = addDays(from, -1)
  const priorFrom = addDays(priorTo, -(len - 1))
  return {
    cadence,
    from,
    to,
    label: label(from, to),
    priorFrom,
    priorTo,
    priorLabel: label(priorFrom, priorTo),
  }
}

function calendarMonth(periodEnd) {
  const d = parseDay(periodEnd)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const from = fmt(new Date(Date.UTC(y, m, 1)))
  const to = fmt(new Date(Date.UTC(y, m + 1, 0)))
  const py = m === 0 ? y - 1 : y
  const pm = m === 0 ? 11 : m - 1
  const priorFrom = fmt(new Date(Date.UTC(py, pm, 1)))
  const priorTo = fmt(new Date(Date.UTC(py, pm + 1, 0)))
  return {
    cadence: 'monthly',
    from,
    to,
    label: `${MONTH_NAMES[m]} ${y}`,
    priorFrom,
    priorTo,
    priorLabel: `${MONTH_NAMES[pm]} ${py}`,
  }
}

function calendarQuarter(periodEnd) {
  const d = parseDay(periodEnd)
  const y = d.getUTCFullYear()
  const qi = Math.floor(d.getUTCMonth() / 3)
  const from = fmt(new Date(Date.UTC(y, qi * 3, 1)))
  const to = fmt(new Date(Date.UTC(y, qi * 3 + 3, 0)))
  const pqi = qi === 0 ? 3 : qi - 1
  const py = qi === 0 ? y - 1 : y
  const priorFrom = fmt(new Date(Date.UTC(py, pqi * 3, 1)))
  const priorTo = fmt(new Date(Date.UTC(py, pqi * 3 + 3, 0)))
  return {
    cadence: 'quarterly',
    from,
    to,
    label: `${y}-Q${qi + 1}`,
    priorFrom,
    priorTo,
    priorLabel: `${py}-Q${pqi + 1}`,
  }
}

function calendarYear(periodEnd) {
  const d = parseDay(periodEnd)
  const y = d.getUTCFullYear()
  return {
    cadence: 'annual',
    from: `${y}-01-01`,
    to: `${y}-12-31`,
    label: `FY${y}`,
    priorFrom: `${y - 1}-01-01`,
    priorTo: `${y - 1}-12-31`,
    priorLabel: `FY${y - 1}`,
  }
}
