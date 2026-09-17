export interface Range {
  readonly min: number;
  readonly max: number;
}

export function clamp(value: number, range: Range): number {
  if (value < range.min) {
    return range.min;
  }
  return value > range.max ? range.max : value;
}
