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

test("institute is required for a new instructor", () => {
  assert.deepEqual(validateImportFields(goodRow({ institute: " " }), COLLEGES).errors, ["Institute is missing"]);
  assert.deepEqual(validateImportFields(goodRow({ institute: "Nowhere" }), COLLEGES).errors, ['Institute "Nowhere" was not found']);
});

test("a blank institute for an existing instructor takes the one on their record", async () => {
  const db = fakeDb({
    instructors: [{ _id: "i-1", name: "Asha", email: "asha.rao@example.com", employee_id: "EMP-1", college_id: "c-blr-2", face_ids: ["f"] }],
  });
  const [result] = await previewImportRows(db, [goodRow({ institute: "", photo_url: "" })], await deps());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.college_id, "c-blr-2");
  assert.ok(result.filled.includes("institute"));
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

test("a row whose email or employee ID exists updates that instructor", async () => {
  const db = fakeDb({
    instructors: [
      { _id: "i-asha", name: "Asha R", email: "asha.rao@example.com", employee_id: "OLD-ID", deleted_at: null, face_ids: [] },
      { _id: "i-ravi", name: "Ravi K", email: "ravi@example.com", employee_id: "EMP-5", deleted_at: null, face_ids: ["f1"] },
    ],
  });
  const results = await previewImportRows(db, [
    goodRow(),
    goodRow({ row: 3, name: "Ravi Kumar", email: "ravi.new@example.com", employee_id: "EMP-5", photo_url: "" }),
    goodRow({ row: 4, email: "new@example.com", employee_id: "EMP-7" }),
  ], await deps());

  assert.equal(results[0].ok, true);
  assert.equal(results[0].action, "update");
  assert.deepEqual(results[0].existing, { id: "i-asha", name: "Asha R" });
  assert.equal(results[0].photo, "enrol");
  assert.match(results[0].thumbnail, /^data:image/);

  assert.equal(results[1].ok, true);
  assert.equal(results[1].action, "update");
  assert.deepEqual(results[1].existing, { id: "i-ravi", name: "Ravi K" });
  assert.equal(results[1].photo, "keep");
  assert.equal(results[1].thumbnail, null);

  assert.equal(results[2].action, "create");
  assert.equal(results[2].existing, null);
});

test("blank cells for an existing instructor are filled from their record", async () => {
  const db = fakeDb({
    instructors: [{
      _id: "i-asha", name: "Asha Rao", email: "asha.rao@example.com", employee_id: "EMP-1",
      gender: "FEMALE", instructor_role: "Trainee", role: "Trainee", college_id: "c-blr-2",
      phone_no: "9000000000", face_ids: ["f1"],
    }],
  });
  const [result] = await previewImportRows(db, [{
    row: 2, employee_id: "EMP-1", phone_no: "9876543210",
  }], await deps());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.action, "update");
  assert.deepEqual(result.value, {
    name: "Asha Rao",
    email: "asha.rao@example.com",
    employee_id: "EMP-1",
    role: "Trainee",
    instructor_role: "Trainee",
    gender: "FEMALE",
    college_id: "c-blr-2",
    phone_no: "9876543210",
    photo_url: "",
    institute: "City College",
  });
  assert.deepEqual(result.filled, ["name", "email", "gender", "role", "institute"]);
});

test("a sheet repeating the role on record is accepted even if it is not a standard one", async () => {
  const db = fakeDb({
    instructors: [{ _id: "i-1", name: "Asha", email: "asha.rao@example.com", employee_id: "EMP-1", gender: "FEMALE", instructor_role: "Trainee", college_id: "c-hyd", face_ids: ["f"] }],
  });
  const [kept] = await previewImportRows(db, [goodRow({ role: "trainee", photo_url: "" })], await deps());
  assert.equal(kept.ok, true, JSON.stringify(kept.errors));
  assert.equal(kept.value.role, "Trainee");
  const [other] = await previewImportRows(db, [goodRow({ role: "Teacher", photo_url: "" })], await deps());
  assert.match(other.errors[0], /Role "Teacher" must be/);
});

test("the sheet's values win over the record where it gives them", async () => {
  const db = fakeDb({
    instructors: [{ _id: "i-1", name: "Old Name", email: "asha.rao@example.com", gender: "MALE", role: "INSTRUCTOR", college_id: "c-blr-1", face_ids: ["f"] }],
  });
  const [result] = await previewImportRows(db, [goodRow({ photo_url: "" })], await deps());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.name, "Asha Rao");
  assert.equal(result.value.gender, "FEMALE");
  assert.equal(result.value.college_id, "c-hyd");
  assert.deepEqual(result.filled, []);
});

test("a field missing from both the sheet and the record is still flagged", async () => {
  const db = fakeDb({
    instructors: [{ _id: "i-1", name: "Asha", email: "asha.rao@example.com", employee_id: "EMP-1", face_ids: ["f"] }],
  });
  const [result] = await previewImportRows(db, [{ row: 2, email: "asha.rao@example.com" }], await deps());
  assert.deepEqual(result.errors, ["Gender is missing", "Role is missing", "Institute is missing"]);
});

test("a new instructor still needs every required field", async () => {
  const [result] = await previewImportRows(fakeDb(), [{ row: 2, email: "new@example.com", employee_id: "EMP-50" }], await deps());
  assert.deepEqual(result.errors, [
    "Name is missing", "Gender is missing", "Role is missing", "Institute is missing", "Photo link is missing",
  ]);
});

test("an existing instructor with no photo still needs a photo link", async () => {
  const db = fakeDb({ instructors: [{ _id: "i-1", name: "Asha", email: "asha.rao@example.com", employee_id: "EMP-1", face_ids: [] }] });
  const [result] = await previewImportRows(db, [goodRow({ photo_url: "" })], await deps());
  assert.deepEqual(result.errors, ["Photo link is missing"]);
});

test("an email and employee ID belonging to two different people is flagged", async () => {
  const db = fakeDb({
    instructors: [
      { _id: "i-1", name: "Asha", email: "asha.rao@example.com", employee_id: "EMP-X" },
      { _id: "i-2", name: "Ravi", email: "ravi@example.com", employee_id: "EMP-1" },
    ],
  });
  const [result] = await previewImportRows(db, [goodRow()], await deps());
  assert.deepEqual(result.errors, [
    "Email asha.rao@example.com belongs to Asha but Employee ID EMP-1 belongs to Ravi; change one of them",
  ]);
});

test("an employee ID reserved by a removed instructor is flagged, but their email is free", async () => {
  const db = fakeDb({
    instructors: [{ _id: "i-9", name: "Gone", email: "gone@example.com", employee_id: "EMP-9", deleted_at: new Date() }],
  });
  const results = await previewImportRows(db, [
    goodRow({ employee_id: "EMP-9" }),
    goodRow({ row: 3, email: "gone@example.com", employee_id: "EMP-10" }),
  ], await deps());
  assert.deepEqual(results[0].errors, ["Employee ID EMP-9 belonged to Gone who was removed; use a different Employee ID"]);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].action, "create");
});

test("an email shared by several instructors is flagged rather than guessed", async () => {
  const db = fakeDb({
    instructors: [
      { _id: "a", name: "A", email: "asha.rao@example.com" },
      { _id: "b", name: "B", email: "asha.rao@example.com" },
    ],
  });
  const [result] = await previewImportRows(db, [goodRow()], await deps());
  assert.match(result.errors[0], /used by 2 instructors/);
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
  assert.deepEqual(outcomes, [{ row: 2, ok: true, id: "new-1", name: "Asha Rao", updated: false, photo_enrolled: true }]);
  assert.equal(created.length, 1);
  assert.equal("photo_url" in created[0], false);
  assert.equal(created[0].instructor_role, "INSTRUCTOR");
  assert.equal(enrolled[0].id, "new-1");
  assert.equal(enrolled[0].options.mode, "add");
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

test("commit updates a matched instructor with the sheet's values", async () => {
  const db = fakeDb({ instructors: [{ _id: "i-asha", name: "Asha R", email: "asha.rao@example.com", employee_id: "OLD", face_ids: [] }] });
  const updates = [];
  const enrolled = [];
  let creates = 0;
  const outcomes = await commitImportRows(db, [goodRow()], await deps({
    createInstructor: async () => { creates += 1; },
    updateInstructor: async (_db, id, fields) => { updates.push({ id, fields }); return { outcome: "updated" }; },
    enrollPhoto: async (_db, instructor) => { enrolled.push(instructor._id); return { ok: true }; },
  }));
  assert.equal(creates, 0);
  assert.equal(updates[0].id, "i-asha");
  assert.equal(updates[0].fields.employee_id, "EMP-1");
  assert.equal(updates[0].fields.name, "Asha Rao");
  assert.equal("photo_url" in updates[0].fields, false);
  assert.deepEqual(enrolled, ["i-asha"]);
  assert.deepEqual(outcomes, [{ row: 2, ok: true, id: "i-asha", name: "Asha Rao", updated: true, photo_enrolled: true }]);
});

test("commit leaves the photo of an instructor who already has one", async () => {
  const db = fakeDb({ instructors: [{ _id: "i-1", name: "Asha", email: "asha.rao@example.com", face_ids: ["f1"] }] });
  let fetched = 0;
  const outcomes = await commitImportRows(db, [goodRow({ phone_no: "" })], await deps({
    fetcher: async () => { fetched += 1; throw new Error("should not fetch"); },
    updateInstructor: async (_db, _id, fields) => {
      assert.equal("phone_no" in fields, false);
      return { outcome: "updated" };
    },
    enrollPhoto: async () => assert.fail("no enrolment expected"),
  }));
  assert.equal(fetched, 0);
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[0].photo_kept, true);
});

test("commit reports why an update was refused", async () => {
  const db = fakeDb({ instructors: [{ _id: "i-1", name: "Asha", email: "asha.rao@example.com", face_ids: ["f1"] }] });
  const outcomes = await commitImportRows(db, [goodRow()], await deps({
    updateInstructor: async () => ({ outcome: "active_attendance" }),
  }));
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].errors[0], /checked in today/);
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
