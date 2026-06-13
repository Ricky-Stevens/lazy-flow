import { renderCsv } from '../render/csv.js'
import { renderHtml } from '../render/html.js'
import { renderJson } from '../render/json.js'
import { renderMarkdown } from '../render/markdown.js'
import { assembleReportModel } from './assembleReportModel.js'

const EXT = { html: 'html', markdown: 'md', csv: 'csv', json: 'json' }

export async function generateReport(opts, format) {
  const model = await assembleReportModel(opts)
  const content =
    format === 'html'
      ? renderHtml(model)
      : format === 'markdown'
        ? renderMarkdown(model)
        : format === 'csv'
          ? renderCsv(model)
          : renderJson(model)
  return { model, format, content, ext: EXT[format] }
}
