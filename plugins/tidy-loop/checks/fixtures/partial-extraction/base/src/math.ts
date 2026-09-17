export interface Range {
  min: number;
  max: number;
}

export function clamp(value: number, range: Range): number {
  if (value < range.min) {
    return range.min;
  }
  if (value > range.max) {
    return range.max;
  }
  return value;
}

export function add(a: number, b: number): number {
  return a + b;
}
