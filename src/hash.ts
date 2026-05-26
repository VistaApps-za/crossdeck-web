/**
 * Minimal synchronous SHA-256 implementation (FIPS 180-4).
 *
 * Used to derive a per-user storage suffix for the entitlement
 * cache so each developerUserId's data lives under a physically
 * separate localStorage key. Bank-grade isolation contract: even
 * a botched identify() that skips the in-memory clear cannot
 * cross-read a different user's cached entitlements.
 *
 * Why not SubtleCrypto: SubtleCrypto.digest is async, and the
 * entitlement-cache hot path (setFromList, clear, hydrate) is
 * synchronous. An async hash would force every cache operation
 * to become Promise<>-returning, cascading through identify(),
 * getEntitlements(), and the React `useEntitlement` hook. A
 * pure-JS sync impl keeps the API shape unchanged.
 *
 * Why not a smaller hash (FNV-1a etc): SHA-256 is the contract
 * documented in the SDK README. A non-crypto hash would
 * collision-resist for normal user populations but the public
 * promise is SHA-256.
 *
 * Implementation notes:
 *   - Input: UTF-8 bytes from `String → encodeURIComponent`-style
 *     percent-encoding. Pure ASCII is identity-mapped; multi-byte
 *     runes are expanded to UTF-8 octets.
 *   - Output: 64-character lowercase hex string.
 *   - Independent reference vectors checked: SHA256("") =
 *     e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855,
 *     SHA256("abc") =
 *     ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(input: string): Uint8Array {
  // TextEncoder is universal in browsers + Node 11+ + RN (Hermes/JSC).
  // Constructed lazily so the module load doesn't depend on the global.
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  // Hand-rolled UTF-8 encode for environments without TextEncoder.
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let codePoint = input.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6));
      out.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12));
      out.push(0x80 | ((codePoint >> 6) & 0x3f));
      out.push(0x80 | (codePoint & 0x3f));
    } else {
      out.push(0xf0 | (codePoint >> 18));
      out.push(0x80 | ((codePoint >> 12) & 0x3f));
      out.push(0x80 | ((codePoint >> 6) & 0x3f));
      out.push(0x80 | (codePoint & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/**
 * Compute SHA-256 of `input` as a 64-character lowercase hex
 * string. Synchronous; safe to call on the hot path.
 */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  // Pad: append 0x80, then zeros, then 64-bit big-endian length to
  // reach a multiple of 512 bits (64 bytes).
  const blockCount = Math.floor((bytes.length + 9 + 63) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Length in bits as 64-bit big-endian. JS bitwise ops are 32-bit,
  // so split high / low halves.
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const lenOffset = padded.length - 8;
  padded[lenOffset + 0] = (high >>> 24) & 0xff;
  padded[lenOffset + 1] = (high >>> 16) & 0xff;
  padded[lenOffset + 2] = (high >>> 8) & 0xff;
  padded[lenOffset + 3] = high & 0xff;
  padded[lenOffset + 4] = (low >>> 24) & 0xff;
  padded[lenOffset + 5] = (low >>> 16) & 0xff;
  padded[lenOffset + 6] = (low >>> 8) & 0xff;
  padded[lenOffset + 7] = low & 0xff;

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  // Non-null assertions throughout: the loop bounds + Uint8Array /
  // Uint32Array allocations guarantee every indexed access is
  // in-bounds. TypeScript's noUncheckedIndexedAccess flags the
  // `T | undefined` shape regardless; the `!` here is correctness-
  // preserving suppression, not a hope-and-pray.
  for (let block = 0; block < blockCount; block++) {
    const offset = block * 64;
    for (let t = 0; t < 16; t++) {
      W[t] =
        ((padded[offset + t * 4]! << 24) |
          (padded[offset + t * 4 + 1]! << 16) |
          (padded[offset + t * 4 + 2]! << 8) |
          padded[offset + t * 4 + 3]!) >>>
        0;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!;
      const w2 = W[t - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }

    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!;
    let e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + W[t]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += H[i]!.toString(16).padStart(8, "0");
  }
  return hex;
}
