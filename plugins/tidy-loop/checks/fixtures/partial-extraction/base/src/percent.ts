function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function percent(part: number, whole: number): number {
  return clamp((part / whole) * 100);
}
