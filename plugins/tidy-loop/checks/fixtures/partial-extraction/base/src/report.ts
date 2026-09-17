import { clamp, type Range } from './math';

export function format(value: number, range: Range): string {
  return String(clamp(value, range));
}
