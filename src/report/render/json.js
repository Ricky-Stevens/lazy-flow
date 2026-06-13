/** Render a ReportModel as pretty JSON. */
export function renderJson(model) {
  return JSON.stringify(model, null, 2)
}

/** Generic JSON serialization for the export tool (raw rows / arbitrary values). */
export function toJson(value) {
  return JSON.stringify(value, null, 2)
}
