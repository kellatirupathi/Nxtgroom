import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);
    const evaluations = db.collection("evaluations");

    const attendanceIds = [
      "b442c711-1199-4476-80e8-d2775619c87e",
      "b63bc05e-f00f-48d0-ad19-cd4714ab6b58" // Wait, I need to fetch the attendance_ids from the previous report
    ];
    // Actually, I can just find duplicates using aggregation
    const duplicates = await evaluations.aggregate([
      { $match: { attendance_id: { $type: "string" } } },
      { $group: { _id: "$attendance_id", count: { $sum: 1 }, docs: { $push: "$$ROOT" } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    for (const group of duplicates) {
      console.log(`Attendance ID: ${group._id} has ${group.count} evaluations.`);
      const sortedDocs = group.docs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const [newest, ...olderDocs] = sortedDocs;
      console.log(`Keeping newest: ${newest._id} (${newest.created_at})`);
      for (const older of olderDocs) {
        console.log(`Deleting older: ${older._id} (${older.created_at})`);
        await evaluations.deleteOne({ _id: older._id });
      }
    }
  } finally {
    await client.close();
  }
}

run().catch(console.dir);
