import assert from "node:assert/strict";
import { test } from "node:test";
import { mapInstructorRow, isSyncConfigured } from "../src/services/instructorSync.js";

test("maps the roster columns the Settings table displays", () => {
  const row = {
    instructor_user_id: "  U-1001 ",
    instructor_name: "Cheekati  Veena",
    instructor_role: "INSTRUCTOR",
    institute_name: "Training Institute",
    instructor_category: "TECH",
    instructor_manager_mail: "Satyasyamala.Penumarthi@NxtWave.co.in",
  };
  const mapped = mapInstructorRow(row);

  assert.equal(mapped.instructor_user_id, "U-1001", "ids are trimmed");
  assert.equal(mapped.name, "Cheekati Veena", "runs of whitespace collapse");
  assert.equal(mapped.instructor_role, "INSTRUCTOR");
  assert.equal(mapped.institute_name, "Training Institute");
  assert.equal(mapped.instructor_category, "TECH");
  assert.equal(mapped.manager_email, "satyasyamala.penumarthi@nxtwave.co.in", "addresses lowercase");
});

test("column names are matched regardless of casing", () => {
  // The warehouse is not consistent about casing between tables.
  const mapped = mapInstructorRow({
    INSTRUCTOR_USER_ID: "U-2",
    Instructor_Name: "Pasika Archana",
    Instructor_Role: "CENTRAL_INSTRUCTOR",
  });
  assert.equal(mapped.instructor_user_id, "U-2");
  assert.equal(mapped.name, "Pasika Archana");
  assert.equal(mapped.instructor_role, "CENTRAL_INSTRUCTOR");
});

test("employee id and phone are optional", () => {
  const mapped = mapInstructorRow({ instructor_user_id: "U-3", instructor_name: "No Extras" });
  assert.equal(mapped.employee_id, null);
  assert.equal(mapped.phone_no, null);
  assert.equal(mapped.instructor_user_id, "U-3", "the row is still usable");
});

test("rows without an id or a name are rejected", () => {
  // These cannot be keyed or displayed, so they are skipped rather than
  // written as anonymous records.
  assert.equal(mapInstructorRow({ instructor_name: "Nameless Id" }), null);
  assert.equal(mapInstructorRow({ instructor_user_id: "U-4" }), null);
  assert.equal(mapInstructorRow({ instructor_user_id: "  ", instructor_name: " " }), null);
  assert.equal(mapInstructorRow(null), null);
});

test("sync reports itself unconfigured rather than throwing", () => {
  const original = process.env.BIGQUERY_CREDENTIALS_JSON;
  try {
    delete process.env.BIGQUERY_CREDENTIALS_JSON;
    assert.equal(isSyncConfigured(), false);

    process.env.BIGQUERY_CREDENTIALS_JSON = "not json at all";
    assert.equal(isSyncConfigured(), false, "malformed credentials are not usable");

    const creds = JSON.stringify({ project_id: "p", client_email: "a@b.c", private_key: "k" });
    process.env.BIGQUERY_CREDENTIALS_JSON = creds;
    assert.equal(isSyncConfigured(), true);

    // Some hosts mangle multi-line values, so a base64 copy is accepted too.
    process.env.BIGQUERY_CREDENTIALS_JSON = Buffer.from(creds).toString("base64");
    assert.equal(isSyncConfigured(), true, "base64 credentials are accepted");
  } finally {
    if (original === undefined) delete process.env.BIGQUERY_CREDENTIALS_JSON;
    else process.env.BIGQUERY_CREDENTIALS_JSON = original;
  }
});
