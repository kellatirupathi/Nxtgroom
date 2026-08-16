import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app } from "../server.js";
import { createAccessToken } from "../src/middleware/auth.js";

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("instructor pages are deterministic and feedback is capped per returned instructor", async () => {
  const instructors = [
    { _id: "instructor-page-1", name: "One", college_id: "college-1" },
    { _id: "instructor-page-2", name: "Two", college_id: "college-1" },
  ];
  let instructorFinds = 0;
  let instructorSort;
  let instructorOffset;
  let instructorLimit;
  let feedbackPipeline;
  let feedbackOptions;
  const instructorCursor = {
    sort(specification) { instructorSort = specification; return this; },
    skip(value) { instructorOffset = value; return this; },
    limit(value) { instructorLimit = value; return this; },
    toArray: async () => instructors,
  };
  app.locals.db = {
    collection(name) {
      if (name === "users") return {
        findOne: async ({ email }) => ({
          email,
          role: "SUPER_ADMIN",
          session_version: 0,
        }),
      };
      if (name === "instructors") return {
        find() {
          instructorFinds += 1;
          return instructorCursor;
        },
      };
      if (name === "attendance") return {
        aggregate(pipeline, options) {
          feedbackPipeline = pipeline;
          feedbackOptions = options;
          return {
            toArray: async () => [
              {
                _id: "feedback-2",
                instructor_id: "instructor-page-1",
                date: new Date("2026-08-14T10:00:00.000Z"),
                status: "compliant",
                remarks: "Ready",
              },
              {
                _id: "feedback-1",
                instructor_id: "instructor-page-2",
                date: new Date("2026-08-13T10:00:00.000Z"),
                status: "review_required",
                remarks: "Review",
              },
            ],
          };
        },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };

  const token = createAccessToken({ sub: "admin@example.com", role: "SUPER_ADMIN" });
  const response = await fetch(`${baseUrl}/api/v2/instructors?limit=2&offset=3`, {
    headers: { authorization: `Bearer ${token}`, connection: "close" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Array.isArray(body), true);
  assert.equal(body.length, 2);
  assert.equal(body[0].daily_feedbacks.length, 1);
  assert.equal(body[1].daily_feedbacks.length, 1);
  assert.deepEqual(instructorSort, { name: 1, _id: 1 });
  assert.equal(instructorOffset, 3);
  assert.equal(instructorLimit, 2);
  assert.equal(feedbackOptions.allowDiskUse, true);

  const windowStage = feedbackPipeline.find((stage) => stage.$setWindowFields);
  assert.deepEqual(windowStage.$setWindowFields.sortBy, {
    _private_paging_feedback_date: -1,
    _id: -1,
  });
  assert.equal(
    feedbackPipeline.find((stage) => stage.$match?._private_paging_feedback_rank)
      .$match._private_paging_feedback_rank.$lte,
    100
  );
  assert.equal(feedbackPipeline.at(-1).$limit, 200);

  for (const query of [
    "limit=0",
    "limit=101",
    "limit=01",
    "limit=1.5",
    "limit=1&limit=2",
    "offset=-1",
    "offset=1000001",
    "offset=01",
    "offset=0&offset=1",
  ]) {
    const invalid = await fetch(`${baseUrl}/api/v2/instructors?${query}`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });
    assert.equal(invalid.status, 422, query);
  }
  assert.equal(instructorFinds, 1);
});
