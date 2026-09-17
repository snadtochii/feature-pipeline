export function pad(text: string, width: number): string {
  if (text.length >= width) {
    return text;
  }
  return ' '.repeat(width - text.length) + text;
}
