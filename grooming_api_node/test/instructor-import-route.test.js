import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { instructorRouter } from "../src/routes/instructorRoutes.js";

const unconfigured = {
  REKOGNITION_COLLECTION_ID: "",
  REKOGNITION_ACCESS_KEY_ID: "",
  REKOGNITION_SECRET_ACCESS_KEY: "",
};

async function withEnv(values, run) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function call(path, body, role = "ADMIN") {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.locals.db = {
    collection() { throw new Error("no database access expected"); },
  };
  app.use((req, _res, next) => {
    req.currentUser = { role, collegeId: "c1" };
    next();
  });
  app.use("/api/v2/instructors", instructorRouter);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/instructors${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

const row = { row: 2, name: "Asha Rao", email: "asha@example.com" };

test("a BOA cannot import instructors", async () => {
  for (const path of ["/import/sheet", "/import/preview", "/import"]) {
    const result = await call(path, { url: "https://docs.google.com/spreadsheets/d/x/edit", rows: [row] }, "BOA");
    assert.equal(result.status, 403, path);
  }
});

test("a preview batch larger than 50 rows is refused", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ ...row, row: index + 2 }));
  const result = await call("/import/preview", { rows });
  assert.equal(result.status, 422);
});

test("a commit batch larger than 25 rows is refused", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({ ...row, row: index + 2 }));
  const result = await call("/import", { rows });
  assert.equal(result.status, 422);
});

test("without face recognition the import says so before checking anything", async () => {
  await withEnv(unconfigured, async () => {
    const preview = await call("/import/preview", { rows: [row] });
    assert.equal(preview.status, 503);
    assert.match(preview.body.detail, /Face recognition is not configured/);
    const commit = await call("/import", { rows: [row] });
    assert.equal(commit.status, 503);
  });
});

test("a link that is not a Google Sheet is a 400 with the reason", async () => {
  const result = await call("/import/sheet", { url: "https://example.com/roster.csv" });
  assert.equal(result.status, 400);
  assert.match(result.body.detail, /Google Sheets link/);
});

test("the literal import paths are registered before the parameterised ones", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/routes/instructorRoutes.js", import.meta.url), "utf8");
  const posts = [...source.matchAll(/instructorRouter\.post\(\s*"([^"]+)"/g)].map((match) => match[1]);
  const firstParameterised = posts.findIndex((path) => path.startsWith("/:"));
  for (const path of ["/import/sheet", "/import/preview", "/import"]) {
    const index = posts.indexOf(path);
    assert.ok(index >= 0 && index < firstParameterised, `${path} must come before ${posts[firstParameterised]}`);
  }
});
