import { randomUUID } from "node:crypto";

// AI evaluation results, one per attendance and kind (check-in or check-out).
const STORE = "evaluations";

const CHECK_GROUPS = [
  "general_idcard_check",
  "grooming_check",
  "attire_check",
  "accessories_check",
  "footwear_check",
];

export function evaluationFilter(attendanceId, kind = "checkin") {
  return kind === "checkout"
    ? { attendance_id: attendanceId, kind: "checkout" }
    : { attendance_id: attendanceId, kind: { $ne: "checkout" } };
}

export async function getEvaluation(db, attendanceId, kind) {
  return db.collection(STORE).findOne(evaluationFilter(attendanceId, kind));
}

export async function saveEvaluation(db, attendanceId, kind, evaluation, now = new Date()) {
  await db.collection(STORE).updateOne(
    evaluationFilter(attendanceId, kind),
    { $set: evaluation, $setOnInsert: { _id: randomUUID(), created_at: now } },
    { upsert: true }
  );
}

export async function deleteEvaluation(db, attendanceId, kind) {
  await db.collection(STORE).deleteMany(evaluationFilter(attendanceId, kind));
}

export async function deleteEvaluationsForAttendance(db, attendanceId) {
  await db.collection(STORE).deleteMany({ attendance_id: String(attendanceId) });
}

export async function evaluationsForSessions(db, attendanceIds) {
  if (!attendanceIds.length) return [];
  const ids = [...new Set(attendanceIds.map(String))];
  return db.collection(STORE).find({ attendance_id: { $in: ids } }).toArray();
}

// Every failed checkpoint across the given sessions, one row per failure.
export async function failedCheckpointRows(db, attendanceIds) {
  const evaluations = await evaluationsForSessions(db, attendanceIds);
  return evaluations.flatMap((evaluation) => (
    CHECK_GROUPS.flatMap((group) => evaluation[group] || [])
      .filter((row) => row?.status === "FAIL")
      .map((row) => ({
        attendance_id: evaluation.attendance_id,
        kind: evaluation.kind,
        code: row.code,
        name: row.checkpoint_name,
      }))
  ));
}
