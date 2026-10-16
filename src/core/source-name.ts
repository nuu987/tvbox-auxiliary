/** A missing display name falls back to the source's normalized URL. */
export function sourceDisplayName(source: { name?: string; url: string }): string {
  return typeof source.name === 'string' && source.name.trim() ? source.name : source.url;
}
