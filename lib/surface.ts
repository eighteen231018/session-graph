export function isTerminalSurface(surface: string | undefined): boolean {
  return surface === 'terminal'
}

export function isTerminalOnly(surfaces: readonly string[]): boolean {
  return surfaces.includes('terminal') && !surfaces.includes('desktop')
}
