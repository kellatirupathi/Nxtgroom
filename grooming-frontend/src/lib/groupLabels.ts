// Naming the people in a group photo from the labels printed in it, with no
// face recognition: the text the browser reads (Tesseract.js) is turned into
// labels ("Dharani" over "NW2000317"), each label is checked against the
// institute's instructor list, and each person gets the label nearest to them
// side to side. Nothing is guessed: an unreadable, unknown or ambiguous label
// leaves that person for the submitter to choose.

// Positions are fractions of the photo (0-1), measured from its top-left.
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// One word Tesseract read, with where it is. Words are used rather than
// lines: Tesseract joins labels standing side by side into one long line.
export interface OcrWord {
  text: string;
  confidence: number;
  box: Box;
}

export interface RosterEntry {
  id: string;
  name: string;
  employee_id: string;
}

export interface ReadLabel {
  text: string;
  // The name and id as printed (the id with look-alike letters put right).
  nameText: string | null;
  idText: string | null;
  // The institute's instructor this label is, when one matches.
  instructor: RosterEntry | null;
  box: Box;
  centerX: number;
}

export interface PersonSpot {
  centerX: number;
  width: number;
}

// Letters Tesseract commonly reads in place of digits.
const DIGIT_LOOKALIKES: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', '!': '1', Z: '2', S: '5', B: '8', G: '6', T: '7' };

function compact(text: string): string {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9|!]/g, '');
}

// An employee id as read ("NW2OOO3I7") with look-alike letters in its number
// part turned back into digits ("NW2000317"). The leading letters are kept.
export function normalizeIdText(text: string): string {
  const raw = compact(text);
  const match = raw.match(/^([A-Z]{1,4})(.*)$/);
  if (!match) return raw.replace(/[|!]/g, '1');
  const digits = match[2].split('').map((char) => DIGIT_LOOKALIKES[char] ?? char).join('');
  return `${match[1]}${digits}`;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

// The instructor whose employee id this is: an exact match, or one character
// off when only one instructor is that close.
export function instructorById(text: string, roster: readonly RosterEntry[]): RosterEntry | null {
  const wanted = normalizeIdText(text);
  if (wanted.length < 4) return null;
  const exact = roster.find((entry) => normalizeIdText(entry.employee_id) === wanted);
  if (exact) return exact;
  if (wanted.length < 6) return null;
  const near = roster.filter((entry) => {
    const id = normalizeIdText(entry.employee_id);
    return Math.abs(id.length - wanted.length) <= 1 && editDistance(id, wanted) <= 1;
  });
  return near.length === 1 ? near[0] : null;
}

function nameWords(text: string): string[] {
  return String(text ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((word) => word.length >= 2);
}

// The instructor a printed name belongs to, only when exactly one instructor
// fits: the same name, or the printed name is their first name(s).
export function instructorByName(text: string, roster: readonly RosterEntry[]): RosterEntry | null {
  const printed = nameWords(text);
  if (!printed.length) return null;
  const joined = printed.join(' ');
  const exact = roster.filter((entry) => nameWords(entry.name).join(' ') === joined);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const starts = roster.filter((entry) => {
    const words = nameWords(entry.name);
    return printed.every((word, index) => words[index] === word);
  });
  return starts.length === 1 ? starts[0] : null;
}

// A word that looks like an employee id: a few letters then mostly digits.
export function looksLikeId(text: string): boolean {
  const normalized = normalizeIdText(String(text ?? '').replace(/[^A-Za-z0-9|!]/g, ''));
  const digits = normalized.replace(/[^0-9]/g, '').length;
  return normalized.length >= 5 && digits >= 4 && digits >= normalized.length - 4;
}

// A word that can be part of a printed name: mostly letters, two or more.
function looksLikeNameWord(text: string): boolean {
  const letters = String(text ?? '').replace(/[^A-Za-z]/g, '').length;
  return letters >= 2 && letters >= String(text).replace(/\s/g, '').length * 0.7;
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

function sharedArea(a: Box, b: Box): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.min(a.width * a.height, b.width * b.height);
}

// The photo is read more than once (as it is, and in black and white); the
// same word read twice is kept once, from its more confident reading.
export function mergeWords(words: readonly OcrWord[]): OcrWord[] {
  const kept: OcrWord[] = [];
  for (const word of [...words].sort((a, b) => b.confidence - a.confidence)) {
    if (!word.text.trim()) continue;
    if (kept.some((other) => sharedArea(word.box, other.box) > 0.5)) continue;
    kept.push(word);
  }
  return kept;
}

interface Phrase {
  text: string;
  box: Box;
  confidence: number;
}

// Name words next to each other on the same row joined into one name
// ("Sai" "Kiran" -> "Sai Kiran"). `aspect` is the photo's width / height, to
// compare gaps across with heights down.
function namePhrases(words: readonly OcrWord[], aspect: number): Phrase[] {
  const sorted = [...words].sort((a, b) => a.box.left - b.box.left);
  const phrases: { words: OcrWord[]; box: Box }[] = [];
  for (const word of sorted) {
    const centre = word.box.top + word.box.height / 2;
    const heightAcross = word.box.height / aspect;
    const row = phrases.find((phrase) => {
      const last = phrase.words[phrase.words.length - 1];
      const lastCentre = last.box.top + last.box.height / 2;
      const gap = word.box.left - (last.box.left + last.box.width);
      return Math.abs(centre - lastCentre) < Math.max(word.box.height, last.box.height) * 0.5
        && gap > -heightAcross * 0.5 && gap < heightAcross * 1.2;
    });
    if (row) {
      row.words.push(word);
      row.box = union([row.box, word.box]);
    } else {
      phrases.push({ words: [word], box: word.box });
    }
  }
  return phrases.map((phrase) => ({
    text: phrase.words.map((word) => word.text.replace(/[^A-Za-z.'-]/g, '')).join(' ').trim(),
    box: phrase.box,
    confidence: Math.min(...phrase.words.map((word) => word.confidence)),
  }));
}

// The labels in the photo: each id joined with the name printed just above it
// (or just before it on the same row), plus names printed on their own. Each
// instructor appears once, from their most confident reading. `aspect` is the
// photo's width divided by its height.
export function readLabels(words: readonly OcrWord[], roster: readonly RosterEntry[], aspect = 1): ReadLabel[] {
  const usable = words.filter((word) => word.text.trim() && word.box.width > 0 && word.box.height > 0);
  const ids = usable.filter((word) => looksLikeId(word.text));
  const names = namePhrases(usable.filter((word) => !looksLikeId(word.text) && looksLikeNameWord(word.text)), aspect);
  const usedNames = new Set<Phrase>();
  const labels: (ReadLabel & { confidence: number })[] = [];

  for (const id of ids) {
    const idText = normalizeIdText(id.text.replace(/[^A-Za-z0-9|!]/g, ''));
    const idCentre = id.box.left + id.box.width / 2;
    const heightAcross = id.box.height / aspect;
    // Just above: within about two and a half id heights, centred over it.
    const above = names
      .map((phrase) => ({
        phrase,
        gap: id.box.top - (phrase.box.top + phrase.box.height),
        offset: Math.abs((phrase.box.left + phrase.box.width / 2) - idCentre),
      }))
      .filter(({ phrase, gap, offset }) => gap > -id.box.height * 0.5 && gap < id.box.height * 2.5
        && offset < Math.max(phrase.box.width, id.box.width) * 0.75)
      .sort((a, b) => a.gap + a.offset - (b.gap + b.offset))[0]?.phrase;
    // Or just before it on the same row.
    const before = names
      .map((phrase) => ({
        phrase,
        gap: id.box.left - (phrase.box.left + phrase.box.width),
        drift: Math.abs((phrase.box.top + phrase.box.height / 2) - (id.box.top + id.box.height / 2)),
      }))
      .filter(({ gap, drift }) => gap > -heightAcross * 0.5 && gap < heightAcross * 2 && drift < id.box.height * 0.6)
      .sort((a, b) => a.gap - b.gap)[0]?.phrase;
    const name = above ?? before ?? null;
    if (name) usedNames.add(name);
    const instructor = instructorById(idText, roster) ?? (name ? instructorByName(name.text, roster) : null);
    const box = name ? union([id.box, name.box]) : id.box;
    labels.push({
      text: [name?.text, idText].filter(Boolean).join(' '),
      nameText: name?.text || null,
      idText,
      instructor,
      box,
      centerX: box.left + box.width / 2,
      confidence: Math.min(id.confidence, name?.confidence ?? 100),
    });
  }

  for (const phrase of names) {
    if (usedNames.has(phrase)) continue;
    const instructor = instructorByName(phrase.text, roster);
    if (!instructor) continue;
    labels.push({
      text: phrase.text,
      nameText: phrase.text,
      idText: null,
      instructor,
      box: phrase.box,
      centerX: phrase.box.left + phrase.box.width / 2,
      confidence: phrase.confidence,
    });
  }

  const best = new Map<string, ReadLabel & { confidence: number }>();
  const unknown: ReadLabel[] = [];
  for (const label of labels) {
    if (!label.instructor) {
      unknown.push(label);
      continue;
    }
    const existing = best.get(label.instructor.id);
    if (!existing || label.confidence > existing.confidence) best.set(label.instructor.id, label);
  }
  return [...[...best.values()].map(({ confidence: _confidence, ...label }) => label), ...unknown]
    .sort((a, b) => a.centerX - b.centerX);
}

// Whether a label carries something to name a person with: a matched
// instructor, or a printed id (a name alone that matched nobody may be any
// word in the photo, so it is not used).
export function usableLabel(label: ReadLabel): boolean {
  return Boolean(label.instructor || (label.idText && label.idText.length >= 6));
}

// The label for each person (by index), the one nearest side to side. A label
// goes to one person only; one that is about as near to two people, or too
// far from everyone, is left out rather than guessed.
export function assignLabels(people: readonly PersonSpot[], labels: readonly ReadLabel[]): (ReadLabel | null)[] {
  const result: (ReadLabel | null)[] = people.map(() => null);
  const pairs: { person: number; label: number; distance: number }[] = [];
  labels.forEach((label, labelIndex) => {
    if (!usableLabel(label)) return;
    const distances = people
      .map((person, personIndex) => ({ personIndex, distance: Math.abs(person.centerX - label.centerX), width: person.width }))
      .sort((a, b) => a.distance - b.distance);
    const [nearest, next] = distances;
    if (!nearest) return;
    const reach = Math.max(0.06, nearest.width * 0.9);
    if (nearest.distance > reach) return;
    if (next && next.distance - nearest.distance < Math.max(0.02, nearest.width * 0.25)) return;
    pairs.push({ person: nearest.personIndex, label: labelIndex, distance: nearest.distance });
  });
  pairs.sort((a, b) => a.distance - b.distance);
  const usedLabels = new Set<number>();
  for (const pair of pairs) {
    if (result[pair.person] || usedLabels.has(pair.label)) continue;
    result[pair.person] = labels[pair.label];
    usedLabels.add(pair.label);
  }
  return result;
}
