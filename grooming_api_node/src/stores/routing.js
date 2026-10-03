import { dataRoute } from "../config/dynamo.js";
import { incrementMetric } from "../services/telemetry.js";

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
