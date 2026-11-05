import { CsvError, parse } from 'csv-parse/sync';

const columns = ['period', 'source', 'quantity', 'unit'];
const units = new Map([['electricity', ['kWh', 'MWh']], ['natural_gas', ['m3']]]);
const month = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const decimal = /^\d+(?:\.\d+)?$/;

function exactQuantity(quantity, shift) {
  const [integer, fraction = ''] = quantity.split('.');
  const padded = fraction.padEnd(shift, '0');
  const whole = (integer + padded.slice(0, shift)).replace(/^0+(?=\d)/, '');
  const remainder = padded.slice(shift).replace(/0+$/, '');
  return remainder ? `${whole}.${remainder}` : whole;
}

export function previewActivityCsv(csv) {
  const preview = [];
  const issues = [];
  let totalRows = 0;
  const issue = (row, column, code, remedy) => issues.push({row, column, code, severity: 'error', remedy});
  const result = () => ({
    status: issues.length ? 'blocked' : 'ready',
    summary: {totalRows, validRows: preview.length, blockedRows: totalRows - preview.length},
    issues,
    preview
  });

  let records;
  try {
    records = parse(csv, {bom: true, info: true, relax_column_count: true});
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    issue(error.lines ?? 1, 'record', 'INVALID_CSV', '请修正引号或分隔符后重试。');
    return result();
  }

  const [header, ...rows] = records;
  if (header?.record.length !== columns.length || columns.some((column, index) => header.record[index] !== column)) {
    issue(1, 'header', 'INVALID_HEADER', `请使用表头 ${columns.join(',')}。`);
    return result();
  }

  let row = header.info.lines + 1;
  const seen = new Set();
  for (const {record, info} of rows) {
    const line = row;
    row = info.lines + 1;
    if (record.length === 1 && record[0].trim() === '') continue;
    totalRows += 1;
    if (record.length !== columns.length) {
      issue(line, 'record', 'INVALID_COLUMN_COUNT', '请保留四列，空字段也要保留分隔符。');
      continue;
    }

    const [period, source, originalQuantity, originalUnit] = record.map(value => value.trim());
    const allowedUnits = units.get(source);
    const before = issues.length;
    if (!month.test(period)) issue(line, 'period', 'INVALID_PERIOD', '请填写有效的 YYYY-MM。');
    if (!allowedUnits) issue(line, 'source', 'INVALID_SOURCE', '请选择 electricity 或 natural_gas。');
    if (!originalQuantity) {
      issue(line, 'quantity', 'MISSING_QUANTITY', '请填写原始数量，实际为零时填 0。');
    } else if (!decimal.test(originalQuantity)) {
      issue(line, 'quantity', 'INVALID_QUANTITY', '请填写非负十进制数，不带分组符号或科学计数法。');
    }
    if (allowedUnits && !allowedUnits.includes(originalUnit)) {
      issue(line, 'unit', 'INVALID_UNIT', `该活动允许的单位为 ${allowedUnits.join(' 或 ')}。`);
    }
    if (issues.length !== before) continue;

    const key = `${period}:${source}`;
    if (seen.has(key)) {
      issue(line, 'source', 'DUPLICATE_ACTIVITY', '同一文件内每个月份和活动来源保留一行。');
      continue;
    }
    seen.add(key);
    const quantity = exactQuantity(originalQuantity, originalUnit === 'MWh' ? 3 : 0);
    preview.push({row: line, period, source, originalQuantity, originalUnit, quantity, unit: allowedUnits[0]});
  }
  if (totalRows === 0) issue(2, 'record', 'EMPTY_ACTIVITY', '请在表头下至少填写一行活动数据。');
  return result();
}
