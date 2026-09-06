/** Match the unsigned 32-bit depth accepted by the native boundary. */
export function positiveDepth(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const depth = Number(value);
  return Number.isInteger(depth) && depth > 0 && depth <= 0xffff_ffff ? depth : null;
}
