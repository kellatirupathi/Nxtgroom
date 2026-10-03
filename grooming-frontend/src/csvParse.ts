export interface CsvRow {
  row: number;
  cells: string[];
}

const SEPARATORS = [',', ';', '\t'] as const;

function detectSeparator(text: string): string {
  let firstLine = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    firstLine += quoted ? '' : char;
  }
  let best: string = ',';
  let bestCount = 0;
  for (const separator of SEPARATORS) {
    const count = firstLine.split(separator).length - 1;
    if (count > bestCount) {
      best = separator;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(input: string): CsvRow[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const separator = detectSeparator(text);
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let rowNumber = 1;

  const endRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== '')) rows.push({ row: rowNumber, cells });
    rowNumber += 1;
    cells = [];
    cell = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (char === separator) {
      cells.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRow();
    } else {
      cell += char;
    }
  }
  if (cell !== '' || cells.length) endRow();
  return rows;
}
