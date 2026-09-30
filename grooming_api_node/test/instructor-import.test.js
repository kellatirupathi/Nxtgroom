import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  commitImportRows,
  fetchSheetCsv,
  loadImportPhoto,
  matchCollege,
  normalizeImportGender,
  normalizeImportRole,
  previewImportRows,
  validateImportFields,
} from "../src/services/instructorImport.js";
import { RemoteFetchError } from "../src/services/remoteFetch.js";

/**
 * The instructor import: every row is either added whole, photograph
 * included, or reported with reasons an admin can act on. The rules are
 * proved against an in-memory roster, with the photograph download, the face
 * check and the create step injected.
 */

const COLLEGES = [
  { _id: "c-hyd", name: "Aurora Institute", location: "Hyderabad" },
  { _id: "c-blr-1", name: "City College", location: "Bengaluru" },
  { _id: "c-blr-2", name: "City College", location: "Mysuru" },
];

const goodRow = (overrides = {}) => ({
  row: 2,
  name: "Asha Rao",
  email: "Asha.Rao@Example.com",
  gender: "Female",
  role: "Instructor",
  institute: "aurora  institute",
  employee_id: "EMP-1",
  phone_no: "+91 98765 43210",
  photo_url: "https://cdn.example.com/asha.jpg",
  ...overrides,
});

let jpeg;
async function sampleJpeg() {
  jpeg ??= await sharp({ create: { width: 400, height: 400, channels: 3, background: "#8899aa" } })
    .jpeg()
    .toBuffer();
  return jpeg;
}

function fakeDb({ instructors = [], colleges = COLLEGES } = {}) {
  return {
    collection(name) {
      if (name === "colleges") return { find: () => ({ toArray: async () => colleges }) };
      if (name === "instructors") {
        return {
          find: (query) => ({
            toArray: async () => instructors.filter((row) => query.$or.some((clause) => {
              const [field, condition] = Object.entries(clause)[0];
              return condition.$in.includes(row[field]);
            })),
          }),
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
}

async function deps(overrides = {}) {
  const buffer = await sampleJpeg();
  return {
    fetcher: async () => ({ buffer, contentType: "image/jpeg" }),
    faceConfigured: true,
    checkQuality: async () => ({ ok: true, quality: { sharpness: 80, brightness: 70, confidence: 99 } }),
    ...overrides,
  };
}

test("roles are read however a sheet spells them", () => {
  assert.equal(normalizeImportRole("Instructor"), "INSTRUCTOR");
  assert.equal(normalizeImportRole("central instructor"), "CENTRAL_INSTRUCTOR");
  assert.equal(normalizeImportRole("Central-Instructor"), "CENTRAL_INSTRUCTOR");
  assert.equal(normalizeImportRole(" MENTOR "), "MENTOR");
  assert.equal(normalizeImportRole("other"), "OTHER");
  assert.equal(normalizeImportRole("Teacher"), null);
  assert.equal(normalizeImportRole(""), null);
});

test("Central Team is a role, however it is spelled", () => {
  for (const spelling of ["Central Team", "central team", "CENTRAL_TEAM", "Central-Team", "central team."]) {
    assert.equal(normalizeImportRole(spelling), "CENTRAL_TEAM", spelling);
  }
});

test("gender accepts M, F, Male, Female, Man and Woman in any case and nothing else", () => {
  assert.equal(normalizeImportGender("m"), "MALE");
  assert.equal(normalizeImportGender("Female"), "FEMALE");
  assert.equal(normalizeImportGender("FEMALE"), "FEMALE");
  assert.equal(normalizeImportGender("fEmAlE."), "FEMALE");
  assert.equal(normalizeImportGender("Woman"), "FEMALE");
  assert.equal(normalizeImportGender("MAN"), "MALE");
  assert.equal(normalizeImportGender("X"), null);
  assert.equal(normalizeImportGender(""), null);
});

test("an institute is found by id, or by a name that is unique", () => {
  assert.equal(matchCollege("c-blr-2", COLLEGES).college._id, "c-blr-2");
  assert.equal(matchCollege("AURORA INSTITUTE", COLLEGES).college._id, "c-hyd");
  // Case, spacing and punctuation never decide a match.
  assert.equal(matchCollege("aurora-institute.", COLLEGES).college._id, "c-hyd");
  assert.equal(
    matchCollege("hyderabad - kondapur campus", [{ _id: "k", name: "Hyderabad – Kondapur Campus" }]).college._id,
    "k",
  );
  assert.match(matchCollege("City College", COLLEGES).error, /matches 2 institutes; use its institute ID/);
  assert.match(matchCollege("Nowhere", COLLEGES).error, /"Nowhere" was not found/);
  assert.equal(matchCollege("", COLLEGES).error, "Institute is missing");
});

test("a good row comes back in stored form", () => {
  const { errors, value, collegeName } = validateImportFields(goodRow(), COLLEGES);
  assert.deepEqual(errors, []);
  assert.deepEqual(value, {
    name: "Asha Rao",
    email: "asha.rao@example.com",
    employee_id: "EMP-1",
    role: "INSTRUCTOR",
    instructor_role: "INSTRUCTOR",
    gender: "FEMALE",
    college_id: "c-hyd",
    phone_no: "+91 98765 43210",
    photo_url: "https://cdn.example.com/asha.jpg",
  });
  assert.equal(collegeName, "Aurora Institute");
});

test("phone is optional and left out when blank", () => {
  const { value } = validateImportFields(goodRow({ phone_no: "" }), COLLEGES);
  assert.equal("phone_no" in value, false);
});

test("employee ID is required", () => {
  assert.deepEqual(validateImportFields(goodRow({ employee_id: " " }), COLLEGES).errors, ["Employee ID is missing"]);
});

test("a cell holding two values uses the first", () => {
  const { errors, value } = validateImportFields(goodRow({
    name: "Asha Rao\nA. Rao",
    email: "asha@example.com, asha.personal@example.com",
    gender: "F / Female",
    role: "Mentor, Instructor",
    institute: "Aurora Institute | City College",
    employee_id: "EMP-1 EMP-2",
    phone_no: "+91 98765 43210 / 9123456789",
    photo_url: "https://cdn.example.com/a.jpg https://cdn.example.com/b.jpg",
  }), COLLEGES);
  assert.deepEqual(errors, []);
  assert.equal(value.name, "Asha Rao");
  assert.equal(value.email, "asha@example.com");
  assert.equal(value.gender, "FEMALE");
  assert.equal(value.role, "MENTOR");
  assert.equal(value.college_id, "c-hyd");
  assert.equal(value.employee_id, "EMP-1");
  assert.equal(value.phone_no, "+91 98765 43210");
  assert.equal(value.photo_url, "https://cdn.example.com/a.jpg");
});

test("a comma in a name or a slash in a link is not read as two values", () => {
  const { value } = validateImportFields(goodRow({
    name: "Nair, Anjali",
    photo_url: "https://drive.google.com/file/d/ABC/view",
  }), COLLEGES);
  assert.equal(value.name, "Nair, Anjali");
  assert.equal(value.photo_url, "https://drive.google.com/file/d/ABC/view");
});

test("every problem in a row is reported at once, naming the bad value", () => {
  const { errors, value } = validateImportFields({
    name: "A",
    email: "not-an-email",
    gender: "X",
    role: "Teacher",
    institute: "Nowhere",
    phone_no: "call me",
    photo_url: "ftp://files/asha.jpg",
  }, COLLEGES);
  assert.equal(value, undefined);
  assert.deepEqual(errors, [
    "Name must be at least 2 characters",
    'Email "not-an-email" is not a valid address',
    'Gender "X" must be Male or Female',
    'Role "Teacher" must be Instructor, Central Instructor, Central Team, Mentor or Other',
    'Institute "Nowhere" was not found',
    "Employee ID is missing",
    'Phone "call me" is not a valid phone number',
    "Photo link: The link must start with http:// or https://",
  ]);
});

test("missing required fields are each named", () => {
  const { errors } = validateImportFields({ row: 3 }, COLLEGES);
  assert.deepEqual(errors, [
    "Name is missing",
    "Email is missing",
    "Gender is missing",
    "Role is missing",
    "Institute is missing",
    "Employee ID is missing",
    "Photo link is missing",
  ]);
});

test("a photo link to a private address is refused before anything is fetched", () => {
  const { errors } = validateImportFields(goodRow({ photo_url: "http://169.254.169.254/latest" }), COLLEGES);
  assert.deepEqual(errors, ["Photo link: This link points to a private address and cannot be opened"]);
});

test("preview passes a good row with a thumbnail and writes nothing", async () => {
  const [result] = await previewImportRows(fakeDb(), [goodRow()], await deps());
  assert.equal(result.ok, true);
  assert.equal(result.row, 2);
  assert.equal(result.value.institute, "Aurora Institute");
  assert.match(result.thumbnail, /^data:image\/jpeg;base64,/);
});

test("preview flags an email or employee ID the roster already has", async () => {
  const db = fakeDb({
    instructors: [
      { email: "asha.rao@example.com", employee_id: "OTHER-ID", deleted_at: null },
      { email: "gone@example.com", employee_id: "EMP-9", deleted_at: new Date() },
    ],
  });
  const results = await previewImportRows(db, [
    goodRow(),
    goodRow({ row: 3, email: "new@example.com", employee_id: "EMP-9" }),
    goodRow({ row: 4, email: "gone@example.com", employee_id: "EMP-10" }),
  ], await deps());
  assert.deepEqual(results[0].errors, ["An instructor with email asha.rao@example.com already exists"]);
  // A removed instructor still owns their employee ID, as the unique index does.
  assert.deepEqual(results[1].errors, ["Employee ID EMP-9 already exists"]);
  // Their email, though, can be used again.
  assert.equal(results[2].ok, true);
});

test("preview flags a repeat within the same batch", async () => {
  const results = await previewImportRows(fakeDb(), [
    goodRow(),
    goodRow({ row: 3, employee_id: "EMP-2" }),
  ], await deps());
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[1].errors, ["Email asha.rao@example.com appears more than once"]);
});

test("a photo link that opens a web page is named as such", async () => {
  const [result] = await previewImportRows(fakeDb(), [goodRow()], await deps({
    fetcher: async () => ({ buffer: Buffer.from("<html>Sign in</html>"), contentType: "text/html; charset=utf-8" }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /opens a web page, not an image/);
});

test("an unreachable photo link and a too-small image are flagged", async () => {
  const [unreachable] = await previewImportRows(fakeDb(), [goodRow()], await deps({
    fetcher: async () => { throw new RemoteFetchError("The link returned an error (HTTP 404)"); },
  }));
  assert.deepEqual(unreachable.errors, ["Photo link: The link returned an error (HTTP 404)"]);

  const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#000" } }).png().toBuffer();
  const [small] = await previewImportRows(fakeDb(), [goodRow()], await deps({
    fetcher: async () => ({ buffer: tiny, contentType: "image/png" }),
  }));
  assert.deepEqual(small.errors, ["Photo: The image must be at least 320x320 pixels"]);
});

test("a photograph without a usable face is flagged", async () => {
  const [result] = await previewImportRows(fakeDb(), [goodRow()], await deps({
    checkQuality: async () => ({ ok: false, reason: "MULTIPLE_FACES", message: "More than one face was found." }),
  }));
  assert.deepEqual(result.errors, ["Photo: More than one face was found."]);
});

test("Drive share links are fetched as direct downloads", async () => {
  const requested = [];
  const base = await deps();
  await loadImportPhoto("https://drive.google.com/file/d/FILE123/view?usp=sharing", {
    fetcher: async (url) => { requested.push(url); return base.fetcher(); },
  });
  assert.deepEqual(requested, ["https://drive.google.com/uc?export=download&id=FILE123"]);
});

test("commit creates the instructor and enrols the checked photograph", async () => {
  const created = [];
  const enrolled = [];
  const outcomes = await commitImportRows(fakeDb(), [goodRow()], await deps({
    createInstructor: async (_db, fields) => {
      created.push(fields);
      return { outcome: "created", instructor: { _id: "new-1", ...fields } };
    },
    enrollPhoto: async (_db, instructor, normalized, options) => {
      enrolled.push({ id: instructor._id, bytes: normalized.buffer.length, options });
      return { ok: true };
    },
  }));
  assert.deepEqual(outcomes, [{ row: 2, ok: true, id: "new-1", name: "Asha Rao", photo_enrolled: true }]);
  assert.equal(created.length, 1);
  assert.equal("photo_url" in created[0], false);
  assert.equal(created[0].instructor_role, "INSTRUCTOR");
  assert.equal(enrolled[0].id, "new-1");
  assert.equal(enrolled[0].options.mode, "add");
  // Quality was checked once already, so enrolment is told not to pay again.
  assert.deepEqual(enrolled[0].options.checkedQuality, { sharpness: 80, brightness: 70, confidence: 99 });
});

test("commit adds nobody when the photograph fails, and reports why", async () => {
  let creates = 0;
  const outcomes = await commitImportRows(fakeDb(), [goodRow()], await deps({
    checkQuality: async () => ({ ok: false, message: "No face was found in this photograph." }),
    createInstructor: async () => { creates += 1; return { outcome: "created", instructor: { _id: "x" } }; },
  }));
  assert.equal(creates, 0);
  assert.deepEqual(outcomes, [{ row: 2, ok: false, errors: ["Photo: No face was found in this photograph."] }]);
});

test("commit keeps an instructor whose photo could not be enrolled, and says so", async () => {
  const outcomes = await commitImportRows(fakeDb(), [goodRow()], await deps({
    createInstructor: async (_db, fields) => ({ outcome: "created", instructor: { _id: "new-2", ...fields } }),
    enrollPhoto: async () => ({ ok: false, status: 503, detail: "The reference photo could not be stored. Try again." }),
  }));
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[0].photo_enrolled, false);
  assert.match(outcomes[0].warning, /photo was not enrolled: The reference photo could not be stored/);
});

test("commit reports a race the create guard caught", async () => {
  const outcomes = await commitImportRows(fakeDb(), [goodRow()], await deps({
    createInstructor: async () => ({ outcome: "duplicate_employee_id" }),
  }));
  assert.deepEqual(outcomes, [{ row: 2, ok: false, errors: ["Employee ID EMP-1 already exists"] }]);
});

test("a sheet link that is not Google Sheets is refused before any request", async () => {
  await assert.rejects(fetchSheetCsv("https://example.com/sheet.csv", { fetcher: async () => assert.fail("fetched") }), /Google Sheets link/);
});

test("a private sheet is reported as needing to be shared", async () => {
  await assert.rejects(
    fetchSheetCsv("https://docs.google.com/spreadsheets/d/abc/edit", {
      fetcher: async () => ({ buffer: Buffer.from("<html>"), contentType: "text/html" }),
    }),
    /Anyone with the link/,
  );
});

test("a shared sheet comes back as its CSV text, from Google only", async () => {
  let seen;
  const csv = await fetchSheetCsv("https://docs.google.com/spreadsheets/d/abc/edit#gid=5", {
    fetcher: async (url, options) => {
      seen = { url, allowsGoogle: options.allowHost("docs.google.com"), allowsOther: options.allowHost("example.com") };
      return { buffer: Buffer.from("Name,Email\nAsha,a@x.com\n"), contentType: "text/csv" };
    },
  });
  assert.equal(csv, "Name,Email\nAsha,a@x.com\n");
  assert.deepEqual(seen, {
    url: "https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=5",
    allowsGoogle: true,
    allowsOther: false,
  });
});
