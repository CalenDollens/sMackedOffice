export const PREVIEW_SCHEME = 'html-preview'
export const ASSET_SCHEME = 'html-asset'
export function htmlPreviewCsp(inspectorNonce?: string): string {
  return [
    "default-src 'none'",
    "base-uri 'self' html-asset:",
    inspectorNonce ? `script-src 'nonce-${inspectorNonce}'` : "script-src 'none'",
    "script-src-attr 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    'img-src html-asset: data: blob:',
    'media-src html-asset: data: blob:',
    'font-src html-asset: data:',
    "style-src 'unsafe-inline' html-asset:",
  ].join('; ')
}

export const HTML_PREVIEW_CSP = htmlPreviewCsp()

/** Add a CSP nonce only when the marked script exactly matches the bundled inspector template. */
export function authorizeInspectorScript(
  text: string,
  inspectorTemplate: string,
  nonce: string,
): string {
  const placeholder = '__GX_VERSION__'
  const placeholderAt = inspectorTemplate.indexOf(placeholder)
  if (placeholderAt < 0 || inspectorTemplate.indexOf(placeholder, placeholderAt + 1) >= 0)
    return text
  const prefix = inspectorTemplate.slice(0, placeholderAt)
  const suffix = inspectorTemplate.slice(placeholderAt + placeholder.length)
  const marker = '<script data-gx-inspector>'
  let searchAt = 0
  while (searchAt < text.length) {
    const scriptAt = text.indexOf(marker, searchAt)
    if (scriptAt < 0) return text
    const bodyAt = scriptAt + marker.length
    const endAt = text.indexOf('</script>', bodyAt)
    if (endAt < 0) return text
    const body = text.slice(bodyAt, endAt)
    if (body.startsWith(prefix) && body.endsWith(suffix)) {
      const version = body.slice(prefix.length, body.length - suffix.length)
      if (/^\d+$/.test(version)) {
        return (
          text.slice(0, scriptAt) +
          `<script data-gx-inspector nonce="${nonce}">` +
          text.slice(bodyAt)
        )
      }
    }
    searchAt = endAt + '</script>'.length
  }
  return text
}

/** Encode an absolute directory as an html-asset base URL with a trailing slash.
 * The scheme is registered as standard, so it needs a host; `local` is a fixed placeholder. */
export function assetBaseHref(documentDir: string): string {
  const normalized = documentDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')
  return `${ASSET_SCHEME}://local${encoded}/`
}

/**
 * The preview copy of the document: the buffer text with a <base> pointing at
 * the document's directory (so relative assets resolve through html-asset://)
 * unless the author already declared one. The saved file never contains it.
 */
interface TagRange {
  start: number
  end: number
}

function tagEnd(text: string, start: number): number {
  let quote = ''
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index + 1
  }
  return -1
}

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

function skipRawText(text: string, index: number, tagName: string): number {
  const closing = new RegExp(`</${tagName}\\s*>`, 'i').exec(text.slice(index))
  return closing ? index + closing.index + closing[0].length : text.length
}

function skipTemplate(text: string, index: number): number {
  let depth = 1
  while (index < text.length) {
    const start = text.indexOf('<', index)
    if (start < 0) return text.length
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4)
      index = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<!', start) || text.startsWith('<?', start)) {
      const end = tagEnd(text, start)
      index = end < 0 ? text.length : end
      continue
    }
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(text.slice(start))
    if (!match) {
      index = start + 1
      continue
    }
    const end = tagEnd(text, start)
    if (end < 0) return text.length
    const closing = match[1] === '/'
    const tagName = match[2].toLowerCase()
    if (tagName === 'template') {
      if (closing) {
        depth -= 1
        if (depth === 0) return end
      } else {
        depth += 1
      }
    }
    index = end
    if (!closing && RAW_TEXT_TAGS.has(tagName)) index = skipRawText(text, index, tagName)
  }
  return text.length
}

function openingTag(text: string, name: string): TagRange | null {
  let index = 0
  while (index < text.length) {
    const start = text.indexOf('<', index)
    if (start < 0) return null
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4)
      index = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<!', start) || text.startsWith('<?', start)) {
      const end = tagEnd(text, start)
      index = end < 0 ? text.length : end
      continue
    }
    const match = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(text.slice(start))
    if (!match) {
      index = start + 1
      continue
    }
    const end = tagEnd(text, start)
    if (end < 0) return null
    const tagName = match[1].toLowerCase()
    if (tagName === name.toLowerCase()) return { start, end }
    if (tagName === 'template') {
      index = skipTemplate(text, end)
      continue
    }
    index = end
    if (RAW_TEXT_TAGS.has(tagName)) index = skipRawText(text, index, tagName)
  }
  return null
}

export function buildPreviewDocument(
  text: string,
  baseHref: string | null,
  inspectorNonce?: string,
): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${htmlPreviewCsp(inspectorNonce)}">`
  const base =
    baseHref && !openingTag(text, 'base') ? `<base href="${baseHref.replace(/"/g, '%22')}">` : ''
  const tags = csp + base
  const head = openingTag(text, 'head')
  if (head) {
    const at = head.end
    return text.slice(0, at) + tags + text.slice(at)
  }
  const html = openingTag(text, 'html')
  if (html) {
    const at = html.end
    return text.slice(0, at) + tags + text.slice(at)
  }
  return tags + text
}

export function previewUrlFor(webContentsId: number): string {
  return `${PREVIEW_SCHEME}://view-${webContentsId}/`
}
