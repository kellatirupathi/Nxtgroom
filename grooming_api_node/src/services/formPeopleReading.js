// Who is in an institute form photo, worked out on the server after the form
// is sent (no face recognition: faces are only found, never searched for).
// Given the faces Rekognition found and the words it read in the photo, this
// cuts each person out head to feet and names them from the label printed
// near them ("Dharani" over "NW2000317"), checked against the institute's
// instructor list. Nothing is guessed: an unreadable, unknown or ambiguous
// label leaves that person not named.
//
// Positions are fractions of the photo (0-1), measured from its top-left.
// Words are { text, confidence (0-100), box }; faces are boxes.

// ---- cutting each person out --------------------------------------------

const FACE_BOX_TO_HEAD = 0.78;
// Crown to the soles of the shoes is about 7.5 heads; a whole head more is
// kept below so feet are never cut, and a little room above the hair.
const HEADS_PER_BODY = 8.6;
const HEAD_ROOM = 0.2;
// When the feet would end within this many heads of the bottom of the photo,
// the picture simply runs to the bottom.
const SNAP_TO_BOTTOM_HEADS = 1.5;
const SHOULDERS_PER_FACE_WIDTH = 3.4;
const BODY_SIDE_MARGIN = 0.12;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// When no face is found (a photo of one person facing away, blurred, or too
// small to tell), the whole photo is taken as one person.
export const WHOLE_PHOTO = Object.freeze({ left: 0, top: 0, width: 1, height: 1 });

// The person, head to feet, from their face.
export function bodyCropFromFace(face) {
  const headHeight = face.height / FACE_BOX_TO_HEAD;
  const crownTop = face.top - (headHeight - face.height);
  const bodyHeight = headHeight * HEADS_PER_BODY;
  const centreX = face.left + face.width / 2;
  const bodyWidth = face.width * SHOULDERS_PER_FACE_WIDTH * (1 + BODY_SIDE_MARGIN * 2);
  const left = clamp(centreX - bodyWidth / 2, 0, 1);
  const top = clamp(crownTop - headHeight * HEAD_ROOM, 0, 1);
  const right = clamp(centreX + bodyWidth / 2, 0, 1);
  const feet = crownTop + bodyHeight;
  const bottom = feet >= 1 - headHeight * SNAP_TO_BOTTOM_HEADS ? 1 : clamp(feet, 0, 1);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Things below a person taken for a face: the small photo on their ID card,
// and hands, shoes or the floor near their feet.
const BADGE_SIZE_RATIO = 1.6;
const BADGE_MAX_DROP_FACES = 6;
const LEGS_START_FACES = 5;

export function dropBodyPartFaces(faces) {
  return faces.filter((small) => !faces.some((big) => {
    if (big === small) return false;
    const sideways = Math.abs((big.left + big.width / 2) - (small.left + small.width / 2));
    const below = small.top - (big.top + big.height);
    const drop = (small.top + small.height / 2) - (big.top + big.height / 2);
    const badge = big.width >= small.width * BADGE_SIZE_RATIO
      && sideways < big.width * 1.2
      && below > -small.height * 0.5
      && below < big.height * BADGE_MAX_DROP_FACES;
    const legsOrFeet = small.width < big.width * 1.5
      && sideways < big.width * 1.8
      && drop > big.height * LEGS_START_FACES;
    return badge || legsOrFeet;
  }));
}

// In a group photo everyone's face is about the same size; something at under
// half the usual size (a poster, someone far off behind) is not of the group.
export function dropTinyFaces(faces) {
  if (faces.length < 3) return [...faces];
  const widths = faces.map((face) => face.width).sort((a, b) => a - b);
  const middle = Math.floor(widths.length / 2);
  const median = widths.length % 2 ? widths[middle] : (widths[middle - 1] + widths[middle]) / 2;
  return faces.filter((face) => face.width >= median * 0.45);
}

// People left to right (a back row after the front row it overlaps with).
export function sortLeftToRight(items) {
  return [...items].sort((a, b) => (a.left + a.width / 2) - (b.left + b.width / 2));
}

// ---- reading the name labels ----------------------------------------------

const NAME_ONLY_MIN_CONFIDENCE = 60;
// How far above the top of a face a name printed over that person can be, in
// face heights (a little overlap with the hair is allowed too).
const NAME_ABOVE_HEAD_FACES = 5;

// Letters commonly read in place of digits.
const DIGIT_LOOKALIKES = { O: "0", Q: "0", D: "0", I: "1", L: "1", "|": "1", "!": "1", Z: "2", S: "5", B: "8", G: "6", T: "7" };

function compact(text) {
  return String(text ?? "").toUpperCase().replace(/[^A-Z0-9|!]/g, "");
}

// An employee id as read ("NW2OOO3I7") with look-alike letters in its number
// part turned back into digits ("NW2000317"). The leading letters are kept.
export function normalizeIdText(text) {
  const raw = compact(text);
  const match = raw.match(/^([A-Z]{1,4})(.*)$/);
  if (!match) return raw.replace(/[|!]/g, "1");
  const digits = match[2].split("").map((char) => DIGIT_LOOKALIKES[char] ?? char).join("");
  return `${match[1]}${digits}`;
}

function editDistance(left, right) {
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
export function instructorById(text, roster) {
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

function nameWords(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((word) => word.length >= 2);
}

// The instructor a printed name belongs to, only when exactly one instructor
// fits: the same name, or the printed name is their first name(s).
export function instructorByName(text, roster) {
  const printed = nameWords(text);
  if (!printed.length) return null;
  const joined = printed.join(" ");
  const exact = roster.filter((entry) => nameWords(entry.name).join(" ") === joined);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const starts = roster.filter((entry) => {
    const words = nameWords(entry.name);
    return printed.every((word, index) => words[index] === word);
  });
  return starts.length === 1 ? starts[0] : null;
}

// A word that looks like an employee id: a few letters then mostly digits.
export function looksLikeId(text) {
  const normalized = normalizeIdText(String(text ?? "").replace(/[^A-Za-z0-9|!]/g, ""));
  const digits = normalized.replace(/[^0-9]/g, "").length;
  return normalized.length >= 5 && digits >= 4 && digits >= normalized.length - 4;
}

// A word that can be part of a printed name: mostly letters, two or more.
function looksLikeNameWord(text) {
  const letters = String(text ?? "").replace(/[^A-Za-z]/g, "").length;
  return letters >= 2 && letters >= String(text).replace(/\s/g, "").length * 0.7;
}

function union(boxes) {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

function phraseOf(words) {
  return {
    text: words.map((word) => word.text.replace(/[^A-Za-z.'-]/g, "")).join(" ").trim(),
    box: union(words.map((word) => word.box)),
    confidence: Math.min(...words.map((word) => word.confidence)),
    words,
  };
}

// Name words next to each other on the same row joined into one name ("Sai"
// "Kiran" -> "Sai Kiran"). `aspect` is the photo's width / height.
function namePhrases(words, aspect) {
  const sorted = [...words].sort((a, b) => a.box.left - b.box.left);
  const phrases = [];
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
  return phrases.map((phrase) => phraseOf(phrase.words));
}

// The labels in the photo: each id joined with the name printed just above it
// (or just before it on the same row), plus names printed on their own. Each
// instructor appears once, from their most confident reading.
export function readLabels(words, roster, aspect = 1) {
  const usable = words.filter((word) => String(word.text ?? "").trim() && word.box.width > 0 && word.box.height > 0);
  const ids = usable.filter((word) => looksLikeId(word.text));
  const names = namePhrases(usable.filter((word) => !looksLikeId(word.text) && looksLikeNameWord(word.text)), aspect);
  const usedNames = new Set();
  const labels = [];

  for (const id of ids) {
    const idText = normalizeIdText(id.text.replace(/[^A-Za-z0-9|!]/g, ""));
    const idCentre = id.box.left + id.box.width / 2;
    const heightAcross = id.box.height / aspect;
    const above = names
      .map((phrase) => ({
        phrase,
        gap: id.box.top - (phrase.box.top + phrase.box.height),
        offset: Math.abs((phrase.box.left + phrase.box.width / 2) - idCentre),
      }))
      .filter(({ phrase, gap, offset }) => gap > -id.box.height * 0.5 && gap < id.box.height * 2.5
        && offset < Math.max(phrase.box.width, id.box.width) * 0.75)
      .sort((a, b) => a.gap + a.offset - (b.gap + b.offset))[0]?.phrase;
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
      text: [name?.text, idText].filter(Boolean).join(" "),
      nameText: name?.text || null,
      idText,
      instructor,
      box,
      centerX: box.left + box.width / 2,
      confidence: Math.min(id.confidence, name?.confidence ?? 100),
    });
  }

  const addName = (phrase) => {
    const instructor = instructorByName(phrase.text, roster);
    // A name matching no instructor is kept only when read clearly; it then
    // names a person only if it is printed just above their head.
    if (!instructor && (phrase.confidence < NAME_ONLY_MIN_CONFIDENCE || phrase.text.replace(/[^A-Za-z]/g, "").length < 3)) return false;
    labels.push({
      text: phrase.text,
      nameText: phrase.text,
      idText: null,
      instructor,
      box: phrase.box,
      centerX: phrase.box.left + phrase.box.width / 2,
      confidence: phrase.confidence,
    });
    return Boolean(instructor);
  };
  for (const phrase of names) {
    if (usedNames.has(phrase)) continue;
    const matched = addName(phrase);
    // Two people's names printed close together read as one ("Meghana
    // Sanjana"): each word is offered on its own too.
    if (!matched && phrase.words.length > 1) {
      for (const word of phrase.words) addName(phraseOf([word]));
    }
  }

  const best = new Map();
  const unknown = [];
  for (const label of labels) {
    if (!label.instructor) {
      unknown.push(label);
      continue;
    }
    const existing = best.get(label.instructor.id);
    if (!existing || label.confidence > existing.confidence) best.set(label.instructor.id, label);
  }
  return [...best.values(), ...unknown]
    .map(({ confidence: _confidence, ...label }) => label)
    .sort((a, b) => a.centerX - b.centerX);
}

// Whether a label carries something to name a person with anywhere near
// them: a matched instructor, or a printed id.
export function usableLabel(label) {
  return Boolean(label.instructor || (label.idText && label.idText.length >= 6));
}

function nameOnlyLabel(label) {
  return !usableLabel(label) && Boolean(label.nameText);
}

function aboveHead(label, person) {
  if (person.faceTop === undefined || !person.faceHeight) return false;
  const bottom = label.box.top + label.box.height;
  return bottom <= person.faceTop + person.faceHeight * 0.3
    && bottom >= person.faceTop - person.faceHeight * NAME_ABOVE_HEAD_FACES;
}

// The label for each person (by index), the one nearest side to side. A label
// goes to one person only; one about as near to two people, or too far from
// everyone, is left out rather than guessed.
export function assignLabels(people, labels) {
  const result = people.map(() => null);
  const pairs = [];
  labels.forEach((label, labelIndex) => {
    const nameOnly = nameOnlyLabel(label);
    if (!usableLabel(label) && !nameOnly) return;
    const distances = people
      .map((person, personIndex) => ({ person, personIndex, distance: Math.abs(person.centerX - label.centerX), width: person.width }))
      .filter(({ person }) => !nameOnly || aboveHead(label, person))
      .sort((a, b) => a.distance - b.distance);
    const [nearest, next] = distances;
    if (!nearest) return;
    const reach = Math.max(0.06, nearest.width * 0.9);
    if (nearest.distance > reach) return;
    if (next && next.distance - nearest.distance < Math.max(0.02, nearest.width * 0.25)) return;
    pairs.push({ person: nearest.personIndex, label: labelIndex, distance: nearest.distance });
  });
  pairs.sort((a, b) => a.distance - b.distance);
  const usedLabels = new Set();
  for (const pair of pairs) {
    if (result[pair.person] || usedLabels.has(pair.label)) continue;
    result[pair.person] = labels[pair.label];
    usedLabels.add(pair.label);
  }
  return result;
}

// ---- the people in one photo ----------------------------------------------

// The name kept for a person from their label: the instructor it matches, or
// else the name and id as printed (not in the instructor list), or nothing.
export function personNaming(label) {
  if (label?.instructor) {
    return {
      instructor_id: label.instructor.id,
      name: label.instructor.name,
      employee_id: label.instructor.employee_id || null,
      source: "label",
    };
  }
  if (label && (label.nameText || label.idText)) {
    return { instructor_id: null, name: label.nameText || label.idText, employee_id: label.idText || null, source: "label" };
  }
  return { instructor_id: null, name: null, employee_id: null, source: "none" };
}

// Everyone in one photo, left to right: where to cut them out and their name.
// `faces` are face boxes, `words` the words read in the photo, `roster` the
// institute's instructors ({ id, name, employee_id }), `aspect` the photo's
// width / height.
export function planPhotoPeople({ faces = [], words = [], roster = [], aspect = 1 }) {
  const found = sortLeftToRight(dropTinyFaces(dropBodyPartFaces(faces.filter((face) => face.width > 0 && face.height > 0))));
  const labels = readLabels(words, roster, aspect);
  const boxes = found.length ? found.map((face) => bodyCropFromFace(face)) : [WHOLE_PHOTO];
  const spots = found.length
    ? found.map((face, index) => ({
      centerX: face.left + face.width / 2,
      width: boxes[index].width,
      faceTop: face.top,
      faceHeight: face.height,
    }))
    : [{ centerX: 0.5, width: 1 }];
  const assigned = assignLabels(spots, labels);
  return boxes.map((box, index) => ({ box, ...personNaming(assigned[index]) }));
}
