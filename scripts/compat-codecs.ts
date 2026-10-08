/** Keep strict schemas for 0.1 and expose the same schemas through 0.2 factories. */
export function withCodecFactories(source: string): string {
  return source.replace(/^(\s*)schema: ([\w$]+\$schema),$/gm, '$&\n$1create: () => $2,')
}
