/**
 * The text one MCP / tool answer carries. MCP servers answer `{ content:
 * [{type:"text",text}] }`, `$.tool.call` answers `{ text }`, and some
 * wrappers nest either under `result`. Callers that need the payload parse the
 * returned text; callers that only need the message use it as is.
 */
export function mcpResultText(result: unknown): string {
  if (result === null || typeof result !== 'object') return ''
  const record = result as { text?: unknown; content?: unknown; result?: unknown }

  if (typeof record.text === 'string' && record.text !== '') return record.text
  const direct = textBlocks(record.content)
  if (direct !== '') return direct

  const payload = record.result
  if (typeof payload === 'string') return payload
  if (payload !== null && typeof payload === 'object') {
    const nested = payload as { text?: unknown; content?: unknown }
    if (typeof nested.text === 'string' && nested.text !== '') return nested.text
    return textBlocks(nested.content)
  }
  return ''
}

/** The text blocks of a `content` array, joined in order. */
export function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .filter(block => block !== null && typeof block === 'object')
    .map(block => {
      const typed = block as { type?: unknown; text?: unknown }
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
    })
    .join('')
}

/** JSON text as a value; anything unparseable becomes null. */
export function parseJson(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
