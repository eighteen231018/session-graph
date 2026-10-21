import type { HostDeps } from './host'
import type { GraphSnapshot } from '../types'
import { connectorPath } from './lines'
import { layoutCardTree } from './tree'

export type ExportDeps = Pick<HostDeps, 'sessionId' | 'sessionCwd' | 'fsWrite'>

export async function exportHtml(deps: ExportDeps, snapshot: GraphSnapshot): Promise<string> {
  const sessionId = await deps.sessionId()
  const cwd = await deps.sessionCwd()
  // The full id, not a short prefix: app session ids share the `local_`
  // prefix, and a short stem would make two exports overwrite each other.
  const path = `${cwd}/session-graph-${sessionId}.html`
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : []
  const layout = layoutCardTree(cards, 110)

  const data = JSON.stringify({
    nodes: snapshot.nodes,
    sessions: snapshot.sessions,
    cards,
    source: snapshot.source,
    generatedAt: snapshot.scannedAt,
  }).replace(/</g, '\\u003c')

  const light = snapshot.theme === 'light'
  const background = light ? '#ffffff' : '#0d1117'
  const foreground = light ? '#1f2328' : '#e6edf3'
  const muted = light ? '#6e7781' : '#8b949e'
  const normalBorder = light ? '#424a53' : '#ffffff'
  const cardBackground = light ? '#f6f8fa' : '#161b22'
  const levelColors = light
    ? ['#0969da', '#1a7f37', '#9a6700', '#8250df', '#cf222e', '#1b7c83', '#bc4c00', '#bf3989', '#0550ae', '#116329', '#7d4e00', '#6639ba']
    : ['#79c0ff', '#56d364', '#e3b341', '#d2a8ff', '#ff7b72', '#56d4dd', '#ffa657', '#ff9bce', '#a5d6ff', '#7ee787', '#f2cc60', '#e2c5ff']
  const accentColor = light ? '#c2410c' : '#ff9f0a'
  const scaleX = 8
  const scaleY = 16

  const titleById = new Map(cards.map(card => [card.sessionId, card.title]))
  const lineHtml = layout.connectors.map((connector, index) => {
    const color = levelColors[(Math.max(1, connector.level) - 1) % levelColors.length]
    const d = connectorPath(connector, scaleX, scaleY)
    const delay = (-((index * 0.37) % 2.8)).toFixed(2)
    return `<path class="connector" style="stroke:${color}" d="${d}" />` +
      `<path class="flow" style="animation-delay:${delay}s" d="${d}" />`
  }).join('')

  const cardsHtml = cards.map(card => {
    const position = layout.positions.get(card.sessionId)
    if (position === undefined) return ''
    const parent = card.parentSessionId === null
      ? '根会话'
      : `从「${escapeHtml(titleById.get(card.parentSessionId) ?? card.parentSessionId.slice(0, 8))}」分出`
    const fork = card.forkAtPreview === null ? '' : ` · 分叉点：${escapeHtml(card.forkAtPreview.slice(0, 60))}`
    return `<article class="card${card.isCurrent ? ' current' : ''}" style="left:${position.x * scaleX}px;top:${position.y * scaleY}px;width:${position.width * scaleX}px;height:${position.height * scaleY}px">
  <h2>${card.isCurrent ? '★ ' : ''}${escapeHtml(card.title)}</h2>
  <p class="meta">${parent}${fork}</p>
  <p class="body">${escapeHtml(card.firstUserMessage)}</p>
  <p class="meta">会话 ID：<code>${escapeHtml(card.sessionId)}</code></p>
</article>`
  }).join('')

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话分支卡片树 ${sessionId.slice(0, 8)}</title>
<style>
  body { margin: 0; padding: 24px; background: ${background}; color: ${foreground}; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 16px; color: ${muted}; }
  .tree { position: relative; margin: 0 auto; }
  .lines { position: absolute; inset: 0; overflow: visible; }
  .connector { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0.55; }
  .flow { fill: none; stroke: ${foreground}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 9 35; animation: flow 2.8s linear infinite; }
  @keyframes flow { from { stroke-dashoffset: 44; } to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) { .flow { animation: none; opacity: 0.45; } }
  .card { position: absolute; z-index: 1; box-sizing: border-box; overflow: hidden; border: 1px solid ${normalBorder}; border-radius: 10px; padding: 8px 10px; background: ${cardBackground}; }
  .card.current { border: 2px solid ${accentColor}; }
  .card.current h2, .card.current .body { color: ${accentColor}; }
  .card.current .meta { color: ${accentColor}; opacity: 0.85; }
  .card h2 { margin: 0 0 2px; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .meta { margin: 0 0 6px; color: ${muted}; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .body { margin: 0; white-space: pre-wrap; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
  .note { margin-top: 16px; color: ${muted}; font-size: 12px; }
</style>
</head>
<body>
<h1>会话分支卡片树</h1>
<p>${cards.length} 个分支 · ${layout.width}×${layout.height} 格 · 生成于 ${new Date(snapshot.scannedAt).toLocaleString('zh-CN')}</p>
${snapshot.notice === undefined ? '' : `<p>⚠ ${escapeHtml(snapshot.notice)}</p>`}
<div class="tree" style="width:${layout.width * scaleX}px;height:${layout.height * scaleY}px">
<svg class="lines" width="${layout.width * scaleX}" height="${layout.height * scaleY}" viewBox="0 0 ${layout.width * scaleX} ${layout.height * scaleY}" aria-hidden="true">
${lineHtml}
</svg>
${cardsHtml}
</div>
<p class="note">静态导出不执行跳转；在插件 Pane 中点击卡片会尝试打开对应会话。父卡片居中于子卡片上方，连接线按分支层级着色，亮色短线沿线流动。</p>
<script type="application/json" id="session-graph-data">${data}</script>
</body>
</html>`

  await deps.fsWrite(path, html)
  return path
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
