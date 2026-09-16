import { clamp, type Range } from './math';

export function mean(values: number[], range: Range): number {
  if (values.length === 0) {
    return range.min;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return clamp(total / values.length, range);
}
