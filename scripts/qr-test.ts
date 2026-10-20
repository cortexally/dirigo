#!/usr/bin/env bun
// QR-энкодер (V2-4.4): структурные самотесты + вывод SVG для глаза.
// Запуск: bun run scripts/qr-test.ts
import { qrMatrix, qrSvg } from "../src/qr";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

/** Проверка структуры матрицы: finder'ы, тайминги, тёмный модуль. */
function structural(qr: { size: number; modules: boolean[][]; version: number }, label: string) {
  const { size, modules: m } = qr;
  // finder 7×7 в трёх углах с бордером
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]] as [number, number][]) {
    let ok = true;
    for (let r = 0; r < 7 && ok; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (m[fr + r]![fc + c] !== (ring || core)) { ok = false; break; }
      }
    }
    check(`${label}: finder (${fr},${fc})`, ok);
  }
  // тайминги
  let t = true;
  for (let i = 8; i < size - 8; i++) if (m[6]![i] !== (i % 2 === 0) || m[i]![6] !== (i % 2 === 0)) { t = false; break; }
  check(`${label}: тайминги`, t);
  // тёмный модуль
  check(`${label}: тёмный модуль`, m[size - 8]![8] === true);
  // размер соответствуte версии
  check(`${label}: размер = 4*v+17`, size === qr.version * 4 + 17, `v=${qr.version} size=${size}`);
}

// короткий URL → v1/v2
{
  const qr = qrMatrix("HELLO");
  structural(qr, "HELLO");
  check("HELLO: версия ≤ 2", qr.version <= 2, `v${qr.version}`);
}
// средний URL (типичная pair-ссылка ~60-90 символов)
{
  const url = "http://127.0.0.1:7171/#pair=abc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
  const qr = qrMatrix(url);
  structural(qr, "PAIR-URL");
  check("PAIR-URL: версия 3-6", qr.version >= 3 && qr.version <= 6, `v${qr.version}`);
  const svg = qrSvg(url, { scale: 4 });
  check("PAIR-URL: SVG валиден", svg.startsWith("<svg") && svg.includes("</svg>") && svg.split("<rect").length > 100, `${svg.length} байт`);
}
// длинный URL (граничные версии)
{
  const long = "http://127.0.0.1:7171/#pair=" + "z".repeat(180);
  const qr = qrMatrix(long);
  structural(qr, "LONG-URL");
  check("LONG-URL: версия 7-10", qr.version >= 7 && qr.version <= 10, `v${qr.version}`);
}
// перебор всех длин: матрица строится без исключений на любой корректной длине
{
  let ok = true;
  let badLen = 0;
  for (let len = 1; len <= 270; len += 1) {
    try { qrMatrix("x".repeat(len)); } catch { ok = false; badLen = len; break; }
  }
  check("все длины 1..270 кодируются", ok, ok ? "" : `сломано на ${badLen}`);
}
// UTF-8 (кириллица) — байт-режим
{
  const qr = qrMatrix("привет");
  structural(qr, "UTF-8");
}

// САМОДЕКОД: читаем матрицу обратно (формат → маска → кодовые слова →
// де-interleave → RS-синдромы). Нулевые синдромы = валидный RS-код,
// ровно это проверяет настоящий сканер.
{
  const { gfMul, GF_EXP } = await import("../src/qr");
  function decodeCheck(text: string): boolean {
    const qr = qrMatrix(text);
    const reservedFromEncoder = qr.reserved;
    const { size, modules: m } = qr;
    // читаем формат-информацию вокруг finder'ов → маска
    let fmtBits: number[] = [];
    for (let i = 0; i <= 5; i++) fmtBits.push(m[8]![i]! ? 1 : 0);
    fmtBits.push(m[8]![7]! ? 1 : 0);
    fmtBits.push(m[8]![8]! ? 1 : 0);
    fmtBits.push(m[7]![8]! ? 1 : 0);
    for (let i = 9; i <= 14; i++) fmtBits.push(m[14 - i]![8]! ? 1 : 0);
    // BCH15: извлекаем data(5 бит: ecc 2 + mask 3) + ecc(10), XOR 0x5412
    let raw = 0;
    for (const b of fmtBits) raw = (raw << 1) | b;
    const unmasked = raw ^ 0b101010000010010;
    const dataField = (unmasked >> 10) & 0b11111;
    const mask = dataField & 0b111;
    // снимаем маску с данных
    const reserved = reservedFromEncoder;
    const data: boolean[][] = m.map((row) => row.slice());
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
        if (flip) data[r]![c] = !data[r]![c];
      }
    }
    // читаем биты в змейке (каноничный сдвиг на тайминг-колонке: col=6 → 5)
    const bits: number[] = [];
    let upward = true;
    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col = 5;
      for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (const c of [col, col - 1]) if (!reserved[r]![c]) bits.push(data[r]![c] ? 1 : 0);
      }
      upward = !upward;
    }
    const total = Math.floor(bits.length / 8);
    const codewords = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!;
      codewords[i] = v;
    }
    // находим спецификацию версии и проверяем RS-синдромы каждого блока
    const spec = SPEC_FOR(size);
    const nBlocks = spec.group1 + spec.group2;
    const dataLen = spec.total - spec.ecPerBlock * nBlocks;
    const shortLen = Math.floor(dataLen / nBlocks);
    const longLen = spec.group2 > 0 && dataLen - shortLen * spec.group1 >= spec.group2 ? shortLen + 1 : shortLen;
    const lens = [...Array(spec.group1).fill(shortLen), ...Array(spec.group2).fill(longLen)];
    let ecOffset = 0;
    // де-interleave данных
    const dataBlocks: Uint8Array[] = lens.map(() => new Uint8Array(0));
    let pos = 0;
    for (let i = 0; i < Math.max(...lens); i++) {
      for (let b = 0; b < lens.length; b++) {
        if (i < lens[b]!) {
          dataBlocks[b] = new Uint8Array([...dataBlocks[b]!, codewords[pos++]!]);
        }
      }
    }
    // де-interleave EC
    const ecBlocks: Uint8Array[] = lens.map(() => new Uint8Array(0));
    for (let i = 0; i < spec.ecPerBlock; i++) {
      for (let b = 0; b < lens.length; b++) {
        ecBlocks[b] = new Uint8Array([...ecBlocks[b]!, codewords[pos++]!]);
      }
    }
    // синдромы: S_j = sum(ec[i] * alpha^(j*(ecCount-1-i))) должны быть 0
    for (let b = 0; b < lens.length; b++) {
      const block = new Uint8Array([...dataBlocks[b]!, ...ecBlocks[b]!]);
      for (let j = 0; j < spec.ecPerBlock; j++) {
        let s = 0;
        for (let i = 0; i < block.length; i++) s ^= gfMul(block[i]!, GF_EXP[(j * (block.length - 1 - i)) % 255]!);
        if (s !== 0) return false;
      }
    }
    ecOffset = 0;
    void ecOffset;
    return true;
  }
  function reservedMap(size: number): boolean[][] {
    const res: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    const mark = (r0: number, c0: number, h: number, w: number) => {
      for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) res[r]![c] = true;
    };
    // finder'ы + разделители
    mark(0, 0, 8, 8); mark(0, size - 8, 8, 8); mark(size - 8, 0, 8, 8);
    // тайминги
    mark(6, 0, 1, size); mark(0, 6, size, 1);
    // выравнивание — покрываем теми же центрами
    const spec = SPEC_FOR(size);
    const centers = ALIGN[spec.version] ?? [];
    for (const r of centers) for (const c of centers) mark(r - 2, c - 2, 5, 5);
    // формат: row 8 (cols 0..8 и size-8..size-1) + col 8 (rows 0..8 и size-8..size-1)
    mark(8, 0, 1, 9); mark(0, 8, 9, 1);
    mark(8, size - 8, 1, 8); mark(size - 8, 8, 8, 1);
    // version-info только для v7+
    if (spec.version >= 7) {
      mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3);
    }
    return res;
  }
  const SPEC_FOR = (size: number) => ECC[(size - 17) / 4 - 1]!; // v = (size-17)/4, индекс = v-1
  const ALIGN: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const { QR_SPECS: ECC } = await import("../src/qr");
  check("самодекод: короткий", decodeCheck("HELLO"));
  check("самодекод: pair-URL", decodeCheck("http://127.0.0.1:7171/#pair=abc123def456ghi789jkl012mno345"));
  check("самодекод: длинный", decodeCheck("http://127.0.0.1:7171/#pair=" + "z".repeat(180)));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
