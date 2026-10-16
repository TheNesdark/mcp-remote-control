/**
 * Constant-time secret comparison (enrollment tokens, bearer credentials).
 * Length is compared first so `timingSafeEqual` never throws on mismatched
 * buffer sizes.
 */
import { timingSafeEqual } from "node:crypto";

export function sameSecret(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}
