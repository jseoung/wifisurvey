/**
 * report-docx.ts - the report as a Word document (.docx), from the same
 * model as the preview (report.ts). A4, a cover page, then the sections,
 * with page numbers in the footer. Works in the browser and in Node.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import type { ReportBlock, ReportModel } from "./report";

/** A4 in twips (1/1440 inch), and the margins. */
const PAGE = { width: 11906, height: 16838 };
const MARGIN = 900;
/** The text width in pixels at 96 to the inch, for scaling images. */
export const CONTENT_WIDTH_PX = Math.floor(
  ((PAGE.width - 2 * MARGIN) / 1440) * 96,
);

const MUTED = "4B5563";
const RULE = "D5D9DE";
const FONT = "Calibri";
/** Font sizes in half-points. */
const SIZE = { body: 21, small: 17, table: 16, h1: 52, h2: 30, sub: 30 };

/** Typed line breaks become breaks inside one paragraph. */
function runs(
  text: string,
  opts: { bold?: boolean; color?: string; size?: number } = {},
): TextRun[] {
  return text.split("\n").map(
    (line, i) =>
      new TextRun({
        text: line,
        break: i > 0 ? 1 : undefined,
        bold: opts.bold,
        color: opts.color,
        size: opts.size,
        font: FONT,
      }),
  );
}

const imageType = (src: string): "png" | "jpg" | null =>
  src.startsWith("data:image/png;base64,")
    ? "png"
    : src.startsWith("data:image/jpeg;base64,")
      ? "jpg"
      : null;

/** Fit width x height into the text width, keeping the shape. */
function fit(width: number, height: number, maxW: number, maxH = 900) {
  const k = Math.min(1, maxW / width, maxH / height);
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
};
const noBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

function factsTable(rows: [string, string][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([k, v]) =>
        new TableRow({
          children: [
            new TableCell({
              borders: noBorders,
              width: { size: 45, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({ children: runs(k, { color: MUTED }) }),
              ],
            }),
            new TableCell({
              borders: noBorders,
              children: [new Paragraph({ children: runs(v, { bold: true }) })],
            }),
          ],
        }),
    ),
  });
}

function block(b: ReportBlock): (Paragraph | Table)[] {
  switch (b.kind) {
    case "text":
      return [
        new Paragraph({
          spacing: { after: 120 },
          children: runs(
            b.text,
            b.muted ? { color: MUTED, size: SIZE.small } : {},
          ),
        }),
      ];
    case "list":
      return b.items.map(
        (item) =>
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: runs(item),
          }),
      );
    case "facts":
      return [factsTable(b.rows), new Paragraph({ children: [] })];
    case "table": {
      const right = (i: number) =>
        b.align?.[i] === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
      const cell = (text: string, i: number, head: boolean) =>
        new TableCell({
          borders: cellBorders,
          shading: head
            ? { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" }
            : undefined,
          margins: { top: 30, bottom: 30, left: 70, right: 70 },
          children: [
            new Paragraph({
              alignment: right(i),
              children: runs(text, { bold: head, size: SIZE.table }),
            }),
          ],
        });
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              tableHeader: true,
              cantSplit: true,
              children: b.head.map((h, i) => cell(h, i, true)),
            }),
            ...b.rows.map(
              (r) =>
                new TableRow({
                  cantSplit: true,
                  children: r.map((c, i) => cell(c, i, false)),
                }),
            ),
          ],
        }),
        new Paragraph({ children: [] }),
      ];
    }
    case "image": {
      const type = imageType(b.image.src);
      if (!type) return [];
      return [
        new Paragraph({
          keepNext: true,
          children: [
            new ImageRun({
              type,
              data: b.image.src,
              transformation: fit(
                b.image.width,
                b.image.height,
                CONTENT_WIDTH_PX,
              ),
              altText: {
                name: b.image.title,
                description: b.image.caption,
                title: b.image.title,
              },
            }),
          ],
        }),
        new Paragraph({
          spacing: { after: 160 },
          children: runs(b.image.caption, { color: MUTED, size: SIZE.small }),
        }),
      ];
    }
  }
}

export interface DocxOptions {
  /** the logo's size in pixels, to keep its shape */
  logoSize?: { width: number; height: number };
}

/** The report as a docx Document (Packer turns it into a file). */
export function reportDocument(
  model: ReportModel,
  { logoSize }: DocxOptions = {},
): Document {
  const cover: (Paragraph | Table)[] = [];
  const logoType = model.logo ? imageType(model.logo) : null;
  const brand: ParagraphChild[] = [];
  if (model.logo && logoType) {
    brand.push(
      new ImageRun({
        type: logoType,
        data: model.logo,
        transformation: fit(
          logoSize?.width ?? 200,
          logoSize?.height ?? 80,
          220,
          80,
        ),
        altText: {
          name: "Logo",
          description: model.companyName,
          title: "Logo",
        },
      }),
    );
  }
  if (model.companyName) {
    if (brand.length) brand.push(new TextRun({ text: "   " }));
    brand.push(
      new TextRun({
        text: model.companyName,
        bold: true,
        size: 26,
        font: FONT,
      }),
    );
  }
  if (brand.length) cover.push(new Paragraph({ children: brand }));
  cover.push(
    new Paragraph({
      spacing: { before: 2400, after: 80 },
      children: runs(model.title, { bold: true, size: SIZE.h1 }),
    }),
    new Paragraph({
      spacing: { after: 800 },
      children: runs(model.subtitle, { color: MUTED, size: SIZE.sub }),
    }),
    factsTable(model.cover),
  );

  const body: (Paragraph | Table)[] = [];
  model.sections.forEach((s, i) => {
    body.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: i > 0 && !!s.newPage,
        spacing: { before: i > 0 && !s.newPage ? 240 : 0, after: 160 },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: 12,
            color: "14181F",
            space: 2,
          },
        },
        children: runs(s.heading, {
          bold: true,
          size: SIZE.h2,
          color: "14181F",
        }),
      }),
    );
    for (const b of s.blocks) body.push(...block(b));
  });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            children: [
              model.footer ? `${model.footer}   ·   Page ` : "Page ",
              PageNumber.CURRENT,
              " of ",
              PageNumber.TOTAL_PAGES,
            ],
            size: SIZE.small,
            color: MUTED,
            font: FONT,
          }),
        ],
      }),
    ],
  });

  const page = {
    size: PAGE,
    margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  };
  return new Document({
    creator: model.companyName || "Wi-Fi Heatmapper",
    title: [model.title, model.subtitle].filter(Boolean).join(" – "),
    styles: {
      default: { document: { run: { font: FONT, size: SIZE.body } } },
    },
    sections: [
      { properties: { page }, children: cover },
      { properties: { page }, footers: { default: footer }, children: body },
    ],
  });
}
