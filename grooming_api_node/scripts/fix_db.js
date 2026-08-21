import { MongoClient } from 'mongodb';

const uri = "mongodb+srv://psm_db_user:9udfQKGmffhG2ymD@cluster0.obvnixm.mongodb.net/?appName=Cluster0";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("grooming_standards");
    const evals = db.collection("evaluations");

    // Delete the older 'checkin' evaluation to resolve the attendance_id unique index collision
    const result = await evals.deleteOne({ _id: "3243ac8b-08c4-470d-aefc-aa52e56989c6" });
    console.log("Deleted count:", result.deletedCount);
  } finally {
    await client.close();
  }
}

run().catch(console.dir);
