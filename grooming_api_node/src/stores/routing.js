import { dataRoute } from "../config/dynamo.js";
import { incrementMetric } from "../services/telemetry.js";

/**
 * Sends one store operation to MongoDB, DynamoDB or both, as the store's
 * switches say (src/config/dynamo.js).
 *
 * With writes going to both databases, the one reads come from is the source
 * of truth: it is written first and its failure fails the request. The other
 * is a shadow copy being proven. Its failure is logged and counted, never
 * shown to the user, and the compare script (scripts/dynamodb-sync.js)
 * reports and repairs the difference.
 */
export async function routedWrite(store, operation, { mongo, dynamo }) {
  const { writeTo, readFrom } = dataRoute(store);
  if (writeTo === "mongo") return mongo();
  if (writeTo === "dynamo") return dynamo();

  const [primary, shadow, shadowName] = readFrom === "dynamo"
    ? [dynamo, mongo, "mongo"]
    : [mongo, dynamo, "dynamo"];
  const result = await primary();
  try {
    await shadow();
  } catch (error) {
    incrementMetric(`shadow_write_failed_${shadowName}`);
    console.error(JSON.stringify({
      event: "shadow_write_failed",
      database: shadowName,
      store,
      operation,
      error: String(error?.name || "Error"),
      message: String(error?.message || "").slice(0, 200),
    }));
  }
  return result;
}

export async function routedRead(store, { mongo, dynamo }) {
  return dataRoute(store).readFrom === "dynamo" ? dynamo() : mongo();
}
