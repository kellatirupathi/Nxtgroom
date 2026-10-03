import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoTableName, getDynamoDocumentClient } from "../config/dynamo.js";
import { fromItem, isConditionFailure, upsertCommandInput } from "./dynamoItems.js";
import { routedRead, routedWrite } from "./routing.js";

const STORE = "report_delivery_runs";

function table() {
  return dynamoTableName(STORE);
}

export async function getDeliveryRun(db, runId) {
  return routedRead(STORE, {
    mongo: () => db.collection(STORE).findOne({ _id: runId }),
    dynamo: async () => {
      const { Item } = await getDynamoDocumentClient().send(new GetCommand({
        TableName: table(),
        Key: { _id: runId },
        ConsistentRead: true,
      }));
      return Item ? fromItem(Item) : null;
    },
  });
}

export async function saveDeliveryRun(db, runId, { set = {}, setOnInsert } = {}) {
  await routedWrite(STORE, "save", {
    mongo: () => db.collection(STORE).updateOne(
      { _id: runId },
      setOnInsert ? { $set: set, $setOnInsert: setOnInsert } : { $set: set },
      { upsert: true }
    ),
    dynamo: async () => {
      const input = upsertCommandInput(table(), { _id: runId }, { set, setOnInsert });
      if (input) await getDynamoDocumentClient().send(new UpdateCommand(input));
    },
  });
}

export async function completeDeliveryRunIfDone(db, runId, set) {
  await routedWrite(STORE, "complete_if_done", {
    mongo: () => db.collection(STORE).updateOne(
      { _id: runId, $expr: { $gte: ["$terminal", "$queued"] } },
      { $set: set }
    ),
    dynamo: async () => {
      const input = upsertCommandInput(table(), { _id: runId }, { set });
      try {
        await getDynamoDocumentClient().send(new UpdateCommand({
          ...input,
          ConditionExpression: "#terminal >= #queued",
          ExpressionAttributeNames: { ...input.ExpressionAttributeNames, "#terminal": "terminal", "#queued": "queued" },
        }));
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    },
  });
}

export async function recordDeliveryOutcome(db, runId, outcome, now) {
  return routedWrite(STORE, "record_outcome", {
    mongo: async () => {
      const result = await db.collection(STORE).findOneAndUpdate(
        { _id: runId },
        { $inc: { [outcome]: 1, terminal: 1 }, $set: { updated_at: now } },
        { returnDocument: "after" }
      );
      return result?.value || result;
    },
    dynamo: async () => {
      try {
        const { Attributes } = await getDynamoDocumentClient().send(new UpdateCommand({
          TableName: table(),
          Key: { _id: runId },
          UpdateExpression: "ADD #outcome :one, #terminal :one SET #updated = :now",
          ConditionExpression: "attribute_exists(#id)",
          ExpressionAttributeNames: {
            "#outcome": outcome,
            "#terminal": "terminal",
            "#updated": "updated_at",
            "#id": "_id",
          },
          ExpressionAttributeValues: { ":one": 1, ":now": now.toISOString() },
          ReturnValues: "ALL_NEW",
        }));
        return fromItem(Attributes);
      } catch (error) {
        if (isConditionFailure(error)) return null;
        throw error;
      }
    },
  });
}
