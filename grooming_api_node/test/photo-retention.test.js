import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import express from "express";
import { reportRouter } from "../src/routes/reportRoutes.js";

const CRON_SECRET = "test-cron-secret-value";

function untouchableDb() {
  return {
    collection(name) {
      throw new Error(`the photo purge must not read or change ${name}`);
    },
  };
}

const servers = [];
after(() => servers.forEach((server) => server.close()));

function openServer() {
  const app = express();
  app.locals.db = untouchableDb();
  app.use("/api/v2/reports", reportRouter);
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address();
  return (query = "", headers = { "x-cron-secret": CRON_SECRET }) => fetch(
    `http://127.0.0.1:${port}/api/v2/reports/cron/purge-photos${query}`,
    { method: "POST", headers }
  );
}

test("the old photo purge call deletes nothing: photos are kept permanently", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const purge = openServer();
  for (const query of ["", "?months=1", "?dry=1"]) {
    const response = await purge(query);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "disabled",
      photos_deleted: 0,
      note: "Photos are kept permanently. Nothing is deleted.",
    });
  }
});

test("the purge call still refuses a caller without the shared secret", async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = CRON_SECRET;
  const purge = openServer();
  assert.equal((await purge("", {})).status, 401);
});

test("no worker scans storage to delete photos it cannot match", async () => {
  const worker = await readFile(new URL("../src/services/storageCleanupWorker.js", import.meta.url), "utf8");
  assert.ok(!worker.includes("reconcileOrphanPhotos"));
  assert.ok(!worker.includes("listPhotoObjects"));
  const storage = await readFile(new URL("../src/services/photoStorage.js", import.meta.url), "utf8");
  assert.ok(!storage.includes("ListObjectsV2Command"), "storage is never listed for deletion");
  const routes = await readFile(new URL("../src/routes/reportRoutes.js", import.meta.url), "utf8");
  assert.ok(!routes.includes("PHOTO_RETENTION_MONTHS"));
  assert.ok(!routes.includes("deletePhoto("), "reports never delete photos");
});
