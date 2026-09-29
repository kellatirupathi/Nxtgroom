import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoTableName, getDynamoDocumentClient } from "../config/dynamo.js";
import { fromItem, isConditionFailure, toItem, upsertCommandInput, upsertExpression } from "./dynamoItems.js";
import { routedRead, routedWrite } from "./routing.js";

/**
 * The app_settings collection: a handful of single documents keyed by name
 * (access_settings, notification_settings, identification_settings,
 * rp_recipients, instructor_sync, institute_sync, storage_orphan_scan).
 *
 * The MongoDB half issues exactly the operations the services issued before
 * this store existed. The DynamoDB half reproduces their meaning on a table
 * keyed by `_id`.
 */
const STORE = "app_settings";
// Retries of a read-modify-write that lost a race with another writer.
const MAX_LIST_ATTEMPTS = 5;

function table() {
  return dynamoTableName(STORE);
}

export async function getSetting(db, id) {
  return routedRead(STORE, {
    mongo: () => db.collection(STORE).findOne({ _id: id }),
    dynamo: async () => {
      const { Item } = await getDynamoDocumentClient().send(new GetCommand({
        TableName: table(),
        Key: { _id: id },
        ConsistentRead: true,
      }));
      return Item ? fromItem(Item) : null;
    },
  });
}

async function dynamoUpsert(id, { set, setOnInsert }) {
  const input = upsertCommandInput(table(), { _id: id }, { set, setOnInsert });
  if (input) await getDynamoDocumentClient().send(new UpdateCommand(input));
}

/** MongoDB updateOne({ _id }, { $set, $setOnInsert }, { upsert: true }). */
export async function saveSetting(db, id, { set = {}, setOnInsert } = {}) {
  await routedWrite(STORE, "save", {
    mongo: () => db.collection(STORE).updateOne(
      { _id: id },
      setOnInsert ? { $set: set, $setOnInsert: setOnInsert } : { $set: set },
      { upsert: true }
    ),
    dynamo: () => dynamoUpsert(id, { set, setOnInsert }),
  });
}

/**
 * MongoDB $addToSet of one value, with $set and $setOnInsert, upserting.
 * Kept as an ordered list, as MongoDB keeps it, rather than a DynamoDB set,
 * so the settings screen shows addresses in the order they were added.
 */
export async function addSettingListValue(db, id, field, value, { set = {}, setOnInsert } = {}) {
  await routedWrite(STORE, "add_list_value", {
    mongo: () => db.collection(STORE).updateOne(
      { _id: id },
      {
        $addToSet: { [field]: value },
        $set: set,
        ...(setOnInsert ? { $setOnInsert: setOnInsert } : {}),
      },
      { upsert: true }
    ),
    dynamo: async () => {
      const expression = upsertExpression({ set, setOnInsert });
      const list = expression.name(field);
      try {
        await getDynamoDocumentClient().send(new UpdateCommand({
          TableName: table(),
          Key: { _id: id },
          UpdateExpression: `SET ${[
            ...expression.clauses,
            `${list} = list_append(if_not_exists(${list}, ${expression.value([])}), ${expression.value([value])})`,
          ].join(", ")}`,
          ConditionExpression: `attribute_not_exists(${list}) OR NOT contains(${list}, ${expression.value(value)})`,
          ExpressionAttributeNames: expression.names,
          ExpressionAttributeValues: expression.values,
        }));
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        // Already present. MongoDB still applies $set in that case.
        await dynamoUpsert(id, { set, setOnInsert });
      }
    },
  });
}

/**
 * MongoDB $pull of one value, with $set, without upsert: nothing happens when
 * the document does not exist. DynamoDB cannot remove a list element by
 * value, only by position, so the position is read first and checked again
 * in the write.
 */
export async function removeSettingListValue(db, id, field, value, { set = {} } = {}) {
  await routedWrite(STORE, "remove_list_value", {
    mongo: () => db.collection(STORE).updateOne(
      { _id: id },
      { $pull: { [field]: value }, $set: set }
    ),
    dynamo: async () => {
      const client = getDynamoDocumentClient();
      for (let attempt = 1; attempt <= MAX_LIST_ATTEMPTS; attempt += 1) {
        const { Item } = await client.send(new GetCommand({
          TableName: table(),
          Key: { _id: id },
          ConsistentRead: true,
        }));
        if (!Item) return;
        const expression = upsertExpression({ set });
        let condition = `attribute_exists(${expression.name("_id")})`;
        let removal = "";
        const position = Array.isArray(Item[field]) ? Item[field].indexOf(toItem(value)) : -1;
        if (position > -1) {
          // Removed by position, on condition that the element there is still
          // this value; a concurrent change that moved it fails the condition
          // and the loop reads again.
          const element = `${expression.name(field)}[${position}]`;
          removal = ` REMOVE ${element}`;
          condition += ` AND ${element} = ${expression.value(value)}`;
        }
        if (!expression.clauses.length && !removal) return;
        try {
          await client.send(new UpdateCommand({
            TableName: table(),
            Key: { _id: id },
            UpdateExpression: `${expression.clauses.length ? `SET ${expression.clauses.join(", ")}` : ""}${removal}`.trim(),
            ConditionExpression: condition,
            ExpressionAttributeNames: expression.names,
            ExpressionAttributeValues: expression.values,
          }));
          return;
        } catch (error) {
          if (!isConditionFailure(error)) throw error;
        }
      }
      throw new Error(`app_settings ${id}: ${field} kept changing; gave up after ${MAX_LIST_ATTEMPTS} attempts`);
    },
  });
}
