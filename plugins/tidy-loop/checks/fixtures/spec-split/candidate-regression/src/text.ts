export function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return ' '.repeat(width - value.length) + value;
}
