// Dirigo — QR-энкодер (V2-4.4): byte-mode, ECC-L, авто-версия 1–10.
// Ноль зависимостей: Reed-Solomon + маски + форматирование по спецификации
// ISO/IEC 18004. Хватает для URL паринга (≤ 200 символов при L).
//
// Использование: qrSvgMatrix(text) → булева матрица модулей; qrSvg(text) → SVG.

const ECC_L_BLOCKS: { version: number; total: number; ecPerBlock: number; group1: number; group2: number }[] = [
  { version: 1, total: 26, ecPerBlock: 7, group1: 1, group2: 0 },
  { version: 2, total: 44, ecPerBlock: 10, group1: 1, group2: 0 },
  { version: 3, total: 70, ecPerBlock: 15, group1: 1, group2: 0 },
  { version: 4, total: 100, ecPerBlock: 20, group1: 1, group2: 0 },
  { version: 5, total: 134, ecPerBlock: 26, group1: 1, group2: 0 },
  { version: 6, total: 172, ecPerBlock: 18, group1: 2, group2: 0 },
  { version: 7, total: 196, ecPerBlock: 20, group1: 2, group2: 0 },
  { version: 8, total: 242, ecPerBlock: 24, group1: 2, group2: 0 },
  { version: 9, total: 292, ecPerBlock: 30, group1: 2, group2: 0 },
  { version: 10, total: 346, ecPerBlock: 18, group1: 2, group2: 2 },
];

/** Спеки ECC-L по версии (для тестов/верификации). */
export const QR_SPECS = ECC_L_BLOCKS;

/** Таблица логарифмов GF(256) для Reed-Solomon (примитивный полином 0x11d). */
export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Полином генератора степени ecCount. */
function rsGenerator(ecCount: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** RS-код для одного блока. */
function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ res[0]!;
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) res[i] ^= gfMul(gen[i + 1]!, factor);
    }
  }
  return res;
}

/** Битовый поток с счётчиком. */
class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** UTF-8 байты текста. */
function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Ёмкость данных (без EC) для версии: total - ec × блоков. */
function dataCapacity(spec: (typeof ECC_L_BLOCKS)[number]): number {
  return spec.total - spec.ecPerBlock * (spec.group1 + spec.group2);
}

/** Выбор версии по длине (byte-mode, ECC-L). */
function chooseVersion(byteLen: number): (typeof ECC_L_BLOCKS)[number] {
  for (const spec of ECC_L_BLOCKS) {
    const capacityBits = dataCapacity(spec) * 8;
    // mode(4) + count(8 для v1-9, 16 для v10+) + data
    const countBits = spec.version >= 10 ? 16 : 8;
    if (4 + countBits + byteLen * 8 <= capacityBits) return spec;
  }
  throw new Error("текст слишком длинный для QR (≤ ~270 байт при ECC-L v10)");
}

/** Сборка финального битового потока с чередованием блоков. */
function buildCodewords(text: string, spec: (typeof ECC_L_BLOCKS)[number]): Uint8Array {
  const bytes = toBytes(text);
  const countBits = spec.version >= 10 ? 16 : 8;
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(bytes.length, countBits);
  for (const b of bytes) bb.put(b, 8);
  // терминатор + выравнивание до границы байта
  const capacityBits = dataCapacity(spec) * 8;
  bb.put(0, Math.min(4, capacityBits - bb.bits.length));
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  const data = new Uint8Array(bb.bits.length / 8);
  for (let i = 0; i < data.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i * 8 + j]!;
    data[i] = v;
  }
  // добор байтами-заполнителями до ёмкости данных
  const nBlocks = spec.group1 + spec.group2;
  const dataLen = dataCapacity(spec);
  const padded = new Uint8Array(dataLen);
  padded.set(data);
  for (let i = data.length; i < dataLen; i++) padded[i] = (i - data.length) % 2 === 0 ? 0xec : 0x11;
  // разбиение: group1 коротких, group2 длинных (на 1 байт длиннее)
  const shortLen = Math.floor(dataLen / nBlocks);
  const longLen = spec.group2 > 0 && dataLen - shortLen * spec.group1 >= spec.group2 ? shortLen + 1 : shortLen;
  const blocks: Uint8Array[] = [];
  let offset = 0;
  for (let g = 0; g < spec.group1; g++) { blocks.push(padded.slice(offset, offset + shortLen)); offset += shortLen; }
  for (let g = 0; g < spec.group2; g++) { blocks.push(padded.slice(offset, offset + longLen)); offset += longLen; }
  if (offset < dataLen) blocks.push(padded.slice(offset));
  // RS на каждый блок + интерливинг (данные, затем EC)
  const ecBlocks = blocks.map((b) => rsEncode(b, spec.ecPerBlock));
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < spec.ecPerBlock; i++) for (const b of ecBlocks) out.push(b[i]!);
  return new Uint8Array(out);
}

/** Центры выравнивающих паттернов по версии (таблица ISO/IEC 18004, v1–v10). */
function alignmentCenters(version: number, size: number): number[] {
  const table: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  return table[version] ?? [];
}

interface QrMatrix { size: number; modules: boolean[][]; version: number; mask: number; reserved: boolean[][]; }

/** Размещение модулей: finder'ы, выравнивание, тайминги, тёмные модули, данные+маска. */
function buildMatrix(text: string): QrMatrix {
  const spec = chooseVersion(toBytes(text).length);
  const size = spec.version * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, v: boolean, res = true) => { m[r]![c] = v; if (res) reserved[r]![c] = true; };

  // finder'ы + разделители
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]] as [number, number][]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r, cc = fc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const ring = inner && (r === 0 || r === 6 || c === 0 || c === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, ring || core);
      }
    }
  }
  // тайминги
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // выравнивание (v2+)
  if (spec.version >= 2) {
    const centers = alignmentCenters(spec.version, size);
    for (const r of centers) {
      for (const c of centers) {
        if (reserved[r]?.[c]) continue; // пересекается с finder'ом — не ставим
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }
  }
  // тёмный модуль + резерв форматаa
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!reserved[8]![i]) set(8, i, false); if (!reserved[i]![8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (!reserved[8]![size - 1 - i]) set(8, size - 1 - i, false); if (!reserved[size - 1 - i]![8]) set(size - 1 - i, 8, false); }

  // version-info (v7+) резервируем ДО данных и маски (не маскируется)
  reserveVersionInfo(reserved, spec.version, size);
  // данные
  const codewords = buildCodewords(text, spec);
  const bits: number[] = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // тайминг-колонка: сдвигаем пару влево (5,4) — все колонки покрыты
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[r]![c]) continue;
        const bit = bitIdx < bits.length ? bits[bitIdx++]! : 0;
        m[r]![c] = bit === 1;
      }
    }
    upward = !upward;
  }

  // маски: выбираем по наименьшей штрафной оценке
  let best = m, bestPenalty = Infinity, bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(m, reserved, mask, size);
    const p = penalty(candidate, size);
    if (p < bestPenalty) { bestPenalty = p; best = candidate; bestMask = mask; }
  }
  // формат-информация (ECC-L = 01) + version-info (v7+)
  const fmtBits = formatInfoBits(maskLevel(bestMask));
  placeFormat(best, reserved, fmtBits, size);
  placeVersionInfo(best, reserved, spec.version, size);
  return { size, modules: best, version: spec.version, mask: bestMask, reserved };
}

function maskLevel(mask: number): number { return mask; }

/** BCH(18,6) для version-info (генератор 0x1f25). */
function versionInfoBits(version: number): number[] {
  let v = version << 12;
  for (let i = 17; i >= 12; i--) if ((v >>> i) & 1) v ^= 0b1111100100101 << (i - 12);
  const bits = (version << 12) | v;
  const out: number[] = [];
  for (let i = 17; i >= 0; i--) out.push((bits >>> i) & 1);
  return out;
}

/** Размещение version-info (v7+): два блока 3×6 у finder'ов. */
function reserveVersionInfo(reserved: boolean[][], version: number, size: number): void {
  if (version < 7) return;
  for (let c = 0; c < 6; c++) for (let r = 0; r < 3; r++) reserved[size - 11 + r]![c] = true;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) reserved[r]![size - 11 + c] = true;
}

function placeVersionInfo(m: boolean[][], reserved: boolean[][], version: number, size: number): void {
  if (version < 7) return;
  const bits = versionInfoBits(version);
  let idx = 0;
  for (let c = 0; c < 6; c++) for (let r = 0; r < 3; r++) m[size - 11 + r]![c] = bits[idx++] === 1;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 3; c++) m[r]![size - 11 + c] = bits[idx++] === 1;
  void reserved;
}

function formatInfoBits(mask: number): number[] {
  // ECC уровень L (01) + маска (3 бита) + BCH15
  const data = (0b01 << 3) | mask;
  let v = data << 10;
  for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= 0b10100110111 << (i - 10);
  const bits = ((data << 10) | v) ^ 0b101010000010010;
  const out: number[] = [];
  for (let i = 14; i >= 0; i--) out.push((bits >>> i) & 1);
  return out;
}

function placeFormat(m: boolean[][], reserved: boolean[][], bits: number[], size: number): void {
  for (let i = 0; i <= 5; i++) m[8]![i] = bits[i] === 1;
  m[8]![7] = bits[6] === 1;
  m[8]![8] = bits[7] === 1;
  m[7]![8] = bits[8] === 1;
  for (let i = 9; i <= 14; i++) m[14 - i]![8] = bits[i] === 1;
  for (let i = 0; i <= 7; i++) m[size - 1 - i]![8] = bits[i] === 1;
  for (let i = 8; i <= 14; i++) m[8]![size - 15 + i] = bits[i] === 1;
  m[size - 8]![8] = true; // тёмный модуль
  void reserved;
}

function applyMask(m: boolean[][], reserved: boolean[][], mask: number, size: number): boolean[][] {
  const out = m.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r]![c]) continue;
      let flip = false;
      switch (mask) {
        case 0: flip = (r + c) % 2 === 0; break;
        case 1: flip = r % 2 === 0; break;
        case 2: flip = c % 3 === 0; break;
        case 3: flip = (r + c) % 3 === 0; break;
        case 4: flip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: flip = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: flip = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        case 7: flip = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
      }
      if (flip) out[r]![c] = !out[r]![c];
    }
  }
  return out;
}

function penalty(m: boolean[][], size: number): number {
  let score = 0;
  // серии одного цвета
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r]![c] === m[r]![c - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r]![c] === m[r - 1]![c]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  return score;
}

/** Булева матрица модулей. */
export function qrMatrix(text: string): QrMatrix {
  return buildMatrix(text);
}

/** Карта служебных модулей (для верификации/тестов). */
export function qrReserved(text: string): boolean[][] {
  // недостающий модуль относительно ёмкости = 1 клетка — диагностика через тест
  return buildMatrix(text).reserved;
}

/** Кодовые слова текста (для верификации/тестов — round-trip). */
export function qrCodewords(text: string): Uint8Array {
  const spec = chooseVersion(toBytes(text).length);
  return buildCodewords(text, spec);
}

/** SVG-строка с QR (quiet zone 4 модуля). */
export function qrSvg(text: string, opts: { scale?: number; dark?: string; light?: string } = {}): string {
  const { modules, size } = buildMatrix(text);
  const q = 4;
  const total = size + q * 2;
  const scale = opts.scale ?? 4;
  const dark = opts.dark ?? "#0b0e14";
  const light = opts.light ?? "#ffffff";
  let rects = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r]![c]) rects += `<rect x="${(c + q) * scale}" y="${(r + q) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * scale}" height="${total * scale}" viewBox="0 0 ${total} ${total}"><rect width="${total * scale}" height="${total * scale}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}
