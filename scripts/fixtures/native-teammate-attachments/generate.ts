import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface FixtureCdp {
  evaluate<T>(expression: string): Promise<T>;
}

export interface GeneratedArtifacts {
  expected: {
    imageToken: string;
    colorOrder: string[];
    layoutCode: string;
    textToken: string;
    pdfToken: string;
  };
  files: { image: string; text: string; pdf: string };
  digests: Record<'image' | 'text' | 'pdf', string>;
}

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

function literal(value: unknown): string {
  return JSON.stringify(value);
}

async function digest(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function makeValidPdf(title: string, marker: string): Buffer {
  const stream = [
    'BT',
    '/F1 18 Tf',
    '48 730 Td',
    `(${title.replace(/[()\\]/g, '\\$&')}) Tj`,
    '0 -32 Td',
    `(${marker.replace(/[()\\]/g, '\\$&')}) Tj`,
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

export async function generateArtifacts(
  cdp: FixtureCdp,
  runRoot: string
): Promise<GeneratedArtifacts> {
  const manifest = JSON.parse(
    await readFile(path.join(fixtureRoot, 'fixture-manifest.json'), 'utf8')
  ) as { schemaVersion: number };
  assert.equal(manifest.schemaVersion, 1);
  const textSource = await readFile(path.join(fixtureRoot, 'text-marker.txt'), 'utf8');
  const pdfSource = await readFile(path.join(fixtureRoot, 'pdf-source.txt'), 'utf8');
  const expected = {
    imageToken: randomBytes(8).toString('hex').toUpperCase(),
    colorOrder: ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PURPLE', 'CYAN']
      .sort(() => randomBytes(1).readUInt8(0) - 128)
      .slice(0, 3),
    layoutCode: randomBytes(3).toString('hex').toUpperCase(),
    textToken: randomBytes(8).toString('hex').toUpperCase(),
    pdfToken: randomBytes(8).toString('hex').toUpperCase(),
  };
  const artifactRoot = path.join(runRoot, 'generated-fixtures');
  await mkdir(artifactRoot, { recursive: true });
  const randomName = (): string => randomBytes(10).toString('hex');
  const files = {
    image: path.join(artifactRoot, `${randomName()}.png`),
    text: path.join(artifactRoot, `${randomName()}.txt`),
    pdf: path.join(artifactRoot, `${randomName()}.pdf`),
  };
  const imageDataUrl = await cdp.evaluate<string>(
    `(() => { const expected = ${literal(expected)}; const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 600; const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable'); ctx.fillStyle = '#f5f7fa'; ctx.fillRect(0, 0, 960, 600); ctx.fillStyle = '#141923'; ctx.font = 'bold 64px sans-serif'; ctx.fillText('NATIVE IMAGE', 55, 95); ctx.font = 'bold 44px monospace'; ctx.fillText('TOKEN ' + expected.imageToken, 55, 175); const colors = { RED: '#e12d37', GREEN: '#23b95a', BLUE: '#2d69e6', YELLOW: '#f5c32d', PURPLE: '#9b4bd2', CYAN: '#23cddc' }; expected.colorOrder.forEach((name, index) => { const x = 75 + index * 300; ctx.fillStyle = colors[name]; ctx.fillRect(x, 245, 235, 180); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 38px sans-serif'; ctx.fillText(name, x + 30, 355); }); ctx.fillStyle = '#141923'; ctx.font = 'bold 44px monospace'; ctx.fillText('LAYOUT ' + expected.layoutCode, 55, 535); return canvas.toDataURL('image/png'); })()`
  );
  await Promise.all([
    writeFile(
      files.image,
      Buffer.from(imageDataUrl.slice('data:image/png;base64,'.length), 'base64')
    ),
    writeFile(files.text, `${textSource.trimEnd()}\nTEXT ${expected.textToken}\n`),
    writeFile(files.pdf, makeValidPdf(pdfSource.trim(), `PDF ${expected.pdfToken}`)),
  ]);
  return {
    expected,
    files,
    digests: {
      image: await digest(files.image),
      text: await digest(files.text),
      pdf: await digest(files.pdf),
    },
  };
}
