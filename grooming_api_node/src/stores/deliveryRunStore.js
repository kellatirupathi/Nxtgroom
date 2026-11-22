// Progress of each scheduled report delivery: how many mails were queued and
// how many have finished.
const STORE = "report_delivery_runs";

export async function getDeliveryRun(db, runId) {
  return db.collection(STORE).findOne({ _id: runId });
}

export async function saveDeliveryRun(db, runId, { set = {}, setOnInsert } = {}) {
  await db.collection(STORE).updateOne(
    { _id: runId },
    setOnInsert ? { $set: set, $setOnInsert: setOnInsert } : { $set: set },
    { upsert: true }
  );
}

export async function completeDeliveryRunIfDone(db, runId, set) {
  await db.collection(STORE).updateOne(
    { _id: runId, $expr: { $gte: ["$terminal", "$queued"] } },
    { $set: set }
  );
}

export async function recordDeliveryOutcome(db, runId, outcome, now) {
  return db.collection(STORE).findOneAndUpdate(
    { _id: runId },
    { $inc: { [outcome]: 1, terminal: 1 }, $set: { updated_at: now } },
    { returnDocument: "after" }
  );
}
