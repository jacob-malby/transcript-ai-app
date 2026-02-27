// lib/docx-builders.ts
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
  TextRun,
} from "docx";

export type TranscriptRow = { time: string; speaker: string; text: string };

export async function buildTranscriptTableDoc(rows: TranscriptRow[]) {
  const tableRows: TableRow[] = rows.map(
    (r) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 12, type: WidthType.PERCENTAGE },
            children: [new Paragraph(r.time)],
          }),
          new TableCell({
            width: { size: 12, type: WidthType.PERCENTAGE },
            children: [new Paragraph(r.speaker)],
          }),
          new TableCell({
            width: { size: 76, type: WidthType.PERCENTAGE },
            children: [new Paragraph(r.text)],
          }),
        ],
      })
  );

  const doc = new Document({
    sections: [
      {
        children: [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

export async function buildSimpleParagraphDoc(title: string, body: string) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: title, bold: true })],
          }),
          new Paragraph(""),
          ...body.split("\n").map((p) => new Paragraph(p)),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

export async function buildQuizDoc(items: { q: string; wrong: string; torf: string }[]) {
  const children: Paragraph[] = [];
  items.forEach((it, idx) => {
    children.push(new Paragraph(`Question ${idx + 1}: ${it.q}`));
    children.push(new Paragraph(`Other multiple choice options: ${it.wrong}`));
    children.push(new Paragraph(`True or False Question: ${it.torf}`));
    children.push(new Paragraph(""));
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildVirtualInterviewDoc(
  items: { question: string; summary: string }[]
) {
  const children: Paragraph[] = [];
  items.forEach((it, idx) => {
    children.push(new Paragraph(`Question ${idx + 1}: ${it.question}`));
    children.push(new Paragraph(it.summary));
    children.push(new Paragraph(""));
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildSummaryDoc(lines: string[]) {
  const doc = new Document({
    sections: [{ children: lines.map((l) => new Paragraph(l)) }],
  });
  return Packer.toBuffer(doc);
}