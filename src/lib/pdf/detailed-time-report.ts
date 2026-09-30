import PDFDocument from 'pdfkit';
import type { Settings } from '../settings.ts';
import { formatHours } from '../format.ts';

export interface DetailedTimeReportRow {
  spent_date: string;
  client: string;
  project: string;
  project_code: string | null;
  task: string;
  notes: string | null;
  roles: string | null;
  person: string;
  duration_seconds: number;
}

export interface DetailedTimeReportInput {
  companyName: string;
  from: string;
  to: string;
  client: string;
  project: string;
  task: string;
  team: string;
  billable: string;
  rows: DetailedTimeReportRow[];
  totalSeconds: number;
  uninvoicedSeconds: number;
  settings: Settings;
}

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const COLORS = { ink: '#222222', rule: '#b9b9b9', shade: '#eeeeee' };

export async function detailedTimeReportPdf(input: DetailedTimeReportInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true, info: {
    Title: `Detailed time report ${input.from} to ${input.to}`,
    Author: input.companyName,
  } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const tableWidth = right - left;
  const cols = [0, 0.33, 0.56, 0.74, 0.81, 0.93, 1].map((part) => left + tableWidth * part);
  const hours = (seconds: number) => formatHours(seconds, input.settings);

  const rule = (y: number) => doc.save().strokeColor(COLORS.rule).lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke().restore();
  const pair = (label: string, value: string, x: number, y: number, labelWidth: number, valueWidth: number) => {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.ink).text(label, x, y, { width: labelWidth });
    doc.font('Helvetica-Bold').text(value, x + labelWidth, y, { width: valueWidth });
  };

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(21).fillColor(COLORS.ink).text('Detailed time report', left, 34);
    doc.font('Helvetica').fontSize(18).text(input.companyName || 'No BS Time Tracking', left + 285, 36, {
      width: tableWidth - 285, align: 'right',
    });
    rule(73);

    pair('Timeframe', `${input.from} - ${input.to}`, left, 102, 74, 190);
    pair('Total', `${hours(input.totalSeconds)} Hours`, left, 120, 74, 190);
    doc.font('Helvetica-Bold').fontSize(9).text(`${hours(input.uninvoicedSeconds)} Uninvoiced billable hours`, left + 74, 138, { width: 190 });

    pair('Clients', input.client, left + 292, 102, 50, 173);
    pair('Projects', input.project, left + 292, 120, 50, 173);
    pair('Tasks', input.task, left + 292, 138, 50, 173);
    pair('Billable', input.billable, left + 292, 156, 50, 173);
    pair('Team', input.team, left + 292, 174, 50, 173);
  };

  const tableHeader = (y: number) => {
    doc.save().fillColor(COLORS.shade).rect(left, y, tableWidth, 24).fill().restore();
    rule(y);
    const labels = ['Client', 'Project', 'Task', 'Roles', 'Person', 'Hours'];
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.ink);
    labels.forEach((label, i) => doc.text(label, cols[i]! + 5, y + 8, {
      width: cols[i + 1]! - cols[i]! - 10,
      align: i === labels.length - 1 ? 'right' : 'left',
    }));
    rule(y + 24);
    return y + 24;
  };

  header();
  let y = tableHeader(218);

  const ensureRoom = (height: number) => {
    if (y + height <= PAGE.height - 54) return;
    doc.addPage();
    header();
    y = tableHeader(218);
  };

  let lastDate = '';
  const dateTotals = new Map<string, number>();
  for (const row of input.rows) dateTotals.set(row.spent_date, (dateTotals.get(row.spent_date) ?? 0) + row.duration_seconds);

  for (const row of input.rows) {
    if (row.spent_date !== lastDate) {
      ensureRoom(30);
      doc.save().fillColor(COLORS.shade).rect(left, y, tableWidth, 25).fill().restore();
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.ink).text(row.spent_date, left + 5, y + 8);
      doc.text(hours(dateTotals.get(row.spent_date) ?? 0), cols[5]! + 5, y + 8, { width: cols[6]! - cols[5]! - 10, align: 'right' });
      rule(y + 25);
      y += 25;
      lastDate = row.spent_date;
    }

    const project = `${row.project_code ? `[${row.project_code}] ` : ''}${row.project}${row.notes ? `\n${row.notes}` : ''}`;
    const values = [row.client, project, row.task, row.roles || 'N/A', row.person, hours(row.duration_seconds)];
    doc.font('Helvetica').fontSize(8.2);
    const heights = values.map((value, i) => doc.heightOfString(value, { width: cols[i + 1]! - cols[i]! - 10, lineGap: 1 }));
    const rowHeight = Math.max(31, ...heights.map((height) => height + 14));
    ensureRoom(rowHeight);
    values.forEach((value, i) => doc.text(value, cols[i]! + 5, y + 8, {
      width: cols[i + 1]! - cols[i]! - 10,
      lineGap: 1,
      align: i === values.length - 1 ? 'right' : 'left',
    }));
    y += rowHeight;
    rule(y);
  }

  ensureRoom(28);
  doc.font('Helvetica-Bold').fontSize(9.5).text('Total', cols[4]! + 5, y + 8, { width: cols[5]! - cols[4]! - 10, align: 'right' });
  doc.text(hours(input.totalSeconds), cols[5]! + 5, y + 8, { width: cols[6]! - cols[5]! - 10, align: 'right' });

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.ink).text(`Page ${i + 1} of ${pages.count}`, left, PAGE.height - 50, {
      width: tableWidth, align: 'center', lineBreak: false,
    });
  }

  doc.end();
  return finished;
}
