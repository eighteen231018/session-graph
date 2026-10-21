import { connectorPath } from './lines'
import type { CardTreeLayout } from './tree'

/**
 * Mid-tone colours that stay readable on both the light and the dark desktop
 * theme; the desktop surface does not expose the person's theme to plugins.
 */
export const SVG_LEVEL_COLORS = [
  '#3b82f6',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#dc2626',
  '#0d9488',
  '#ea580c',
  '#db2777',
  '#2563eb',
  '#15803d',
  '#b45309',
  '#6d28d9',
] as const

const FLOW_DURATION = 2.8

/**
 * The desktop pane's connector layer. It is drawn under the cards, in cell
 * units, and stretched to their grid; `preserveAspectRatio="none"` maps the
 * viewBox onto the pane's non-square cells. The bright dash travels along each
 * path with SMIL, which needs no plugin redraw.
 */
export function buildConnectorSvg(layout: CardTreeLayout): string {
  const paths = layout.connectors.map((connector, index) => {
    const color = SVG_LEVEL_COLORS[(Math.max(1, connector.level) - 1) % SVG_LEVEL_COLORS.length]!
    const d = connectorPath(connector)
    const begin = (-((index * 0.37) % FLOW_DURATION)).toFixed(2)
    const base = `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity="0.8"/>`
    const flow = `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" stroke-dasharray="0.7 2.3"><animate attributeName="stroke-dashoffset" values="3;0" dur="${FLOW_DURATION}s" begin="${begin}s" repeatCount="indefinite"/></path>`
    return base + flow
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="none">${paths}</svg>`
}
