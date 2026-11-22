// Low-level DynamoDB access used by the document store.
//
// Two implementations share one interface:
//   AwsDynamoDriver     the real service (or DynamoDB Local / dynalite)
//   MemoryDynamoDriver  an in-process copy for tests and offline development
//
// Conditions understood by write():
//   { absent: "<key attribute>" }                      item must not exist
//   { equals: { attr, value } }                        attribute must equal value
//   { absentOr: { key, attr, value } }                 missing, or attribute equals value

import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

export const MAX_TRANSACTION_ACTIONS = 100;
const BATCH_GET_LIMIT = 100;
const SCAN_SEGMENTS = 4;

export class ConditionFailedError extends Error {
  constructor(index, { conflict = false } = {}) {
    super(conflict ? "A concurrent transaction touched the same item" : "A write condition was not met");
    this.name = "ConditionFailedError";
    this.index = index;
    this.conflict = conflict;
  }
}

function conditionExpression(condition) {
  if (!condition) return {};
  if (condition.absent) {
    return {
      ConditionExpression: "attribute_not_exists(#key)",
      ExpressionAttributeNames: { "#key": condition.absent },
    };
  }
  if (condition.equals) {
    return {
      ConditionExpression: "#attr = :value",
      ExpressionAttributeNames: { "#attr": condition.equals.attr },
      ExpressionAttributeValues: { ":value": condition.equals.value },
    };
  }
  if (condition.absentOr) {
    return {
      ConditionExpression: "attribute_not_exists(#key) OR #attr = :value",
      ExpressionAttributeNames: { "#key": condition.absentOr.key, "#attr": condition.absentOr.attr },
      ExpressionAttributeValues: { ":value": condition.absentOr.value },
    };
  }
  throw new Error(`Unknown write condition ${JSON.stringify(condition)}`);
}

// Builds the request body for one write action; the same shape serves a
// single PutItem/DeleteItem call and an element of TransactWriteItems.
export function actionRequest(action) {
  if (action.op === "put") {
    return { Put: { TableName: action.table, Item: action.item, ...conditionExpression(action.condition) } };
  }
  if (action.op === "delete") {
    return {
      Delete: {
        TableName: action.table,
        Key: { [action.key.name]: action.key.value },
        ...conditionExpression(action.condition),
      },
    };
  }
  throw new Error(`Unknown write action ${action.op}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AwsDynamoDriver {
  constructor(rawClient) {
    this.raw = rawClient;
    this.client = DynamoDBDocumentClient.from(rawClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async getItem(table, keyName, keyValue, { consistent = false } = {}) {
    const result = await this.client.send(new GetCommand({
      TableName: table,
      Key: { [keyName]: keyValue },
      ConsistentRead: consistent,
    }));
    return result.Item || null;
  }

  async batchGetItems(table, keyName, keyValues, { consistent = false } = {}) {
    const unique = [...new Set(keyValues)];
    const items = [];
    for (let start = 0; start < unique.length; start += BATCH_GET_LIMIT) {
      let keys = unique.slice(start, start + BATCH_GET_LIMIT).map((value) => ({ [keyName]: value }));
      for (let attempt = 0; keys.length; attempt += 1) {
        if (attempt > 8) throw new Error(`DynamoDB did not return ${keys.length} key(s) from ${table}`);
        if (attempt) await sleep(Math.min(1000, 50 * 2 ** attempt));
        const result = await this.client.send(new BatchGetCommand({
          RequestItems: { [table]: { Keys: keys, ConsistentRead: consistent } },
        }));
        items.push(...(result.Responses?.[table] || []));
        keys = result.UnprocessedKeys?.[table]?.Keys || [];
      }
    }
    return items;
  }

  async queryIndex(table, { indexName, pkAttr, pkValue, skAttr, skFrom, skTo, skEquals }) {
    const names = { "#pk": pkAttr };
    const values = { ":pk": pkValue };
    let expression = "#pk = :pk";
    if (skAttr && skEquals !== undefined) {
      names["#sk"] = skAttr;
      values[":sk"] = skEquals;
      expression += " AND #sk = :sk";
    } else if (skAttr && skFrom !== undefined && skTo !== undefined) {
      names["#sk"] = skAttr;
      values[":from"] = skFrom;
      values[":to"] = skTo;
      expression += " AND #sk BETWEEN :from AND :to";
    }
    const items = [];
    let ExclusiveStartKey;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: table,
        IndexName: indexName,
        KeyConditionExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ExclusiveStartKey,
      }));
      items.push(...(result.Items || []));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async scanTable(table, { consistent = false } = {}) {
    const segments = await Promise.all(Array.from({ length: SCAN_SEGMENTS }, async (_, segment) => {
      const items = [];
      let ExclusiveStartKey;
      do {
        const result = await this.client.send(new ScanCommand({
          TableName: table,
          ConsistentRead: consistent,
          Segment: segment,
          TotalSegments: SCAN_SEGMENTS,
          ExclusiveStartKey,
        }));
        items.push(...(result.Items || []));
        ExclusiveStartKey = result.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    }));
    return segments.flat();
  }

  async write(actions) {
    if (!actions.length) return;
    if (actions.length > MAX_TRANSACTION_ACTIONS) {
      throw new Error(`A single change needs ${actions.length} writes; DynamoDB allows ${MAX_TRANSACTION_ACTIONS}`);
    }
    if (actions.length === 1) {
      const request = actionRequest(actions[0]);
      try {
        if (request.Put) await this.client.send(new PutCommand(request.Put));
        else await this.client.send(new DeleteCommand(request.Delete));
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") throw new ConditionFailedError(0);
        throw error;
      }
      return;
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: actions.map(actionRequest) }));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") {
        const reasons = error.CancellationReasons || [];
        const failed = reasons.findIndex((reason) => reason?.Code === "ConditionalCheckFailed");
        if (failed >= 0) throw new ConditionFailedError(failed);
        if (reasons.some((reason) => reason?.Code === "TransactionConflict")) {
          throw new ConditionFailedError(-1, { conflict: true });
        }
      }
      if (error?.name === "TransactionConflictException") throw new ConditionFailedError(-1, { conflict: true });
      throw error;
    }
  }

  async listTables() {
    const names = [];
    let ExclusiveStartTableName;
    do {
      const result = await this.raw.send(new ListTablesCommand({ ExclusiveStartTableName }));
      names.push(...(result.TableNames || []));
      ExclusiveStartTableName = result.LastEvaluatedTableName;
    } while (ExclusiveStartTableName);
    return names;
  }

  async describeTable(table) {
    try {
      const result = await this.raw.send(new DescribeTableCommand({ TableName: table }));
      return result.Table;
    } catch (error) {
      if (error?.name === "ResourceNotFoundException") return null;
      throw error;
    }
  }

  async createTable(definition) {
    await this.raw.send(new CreateTableCommand(definition));
  }

  async ttlEnabled(table) {
    const result = await this.raw.send(new DescribeTimeToLiveCommand({ TableName: table }));
    return ["ENABLED", "ENABLING"].includes(result.TimeToLiveDescription?.TimeToLiveStatus);
  }

  async enableTtl(table, attribute) {
    await this.raw.send(new UpdateTimeToLiveCommand({
      TableName: table,
      TimeToLiveSpecification: { Enabled: true, AttributeName: attribute },
    }));
  }

  async enablePointInTimeRecovery(table) {
    await this.raw.send(new UpdateContinuousBackupsCommand({
      TableName: table,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    }));
  }

  async ping(table) {
    await this.raw.send(new DescribeTableCommand({ TableName: table }));
    return true;
  }
}

// ---------------------------------------------------------------------------

function copy(item) {
  return item ? structuredClone(item) : null;
}

export class MemoryDynamoDriver {
  constructor(definitions = []) {
    this.tables = new Map();
    for (const definition of definitions) this.#create(definition);
  }

  #create(definition) {
    const key = definition.KeySchema.find((entry) => entry.KeyType === "HASH").AttributeName;
    const indexes = new Map((definition.GlobalSecondaryIndexes || []).map((index) => [
      index.IndexName,
      {
        pk: index.KeySchema.find((entry) => entry.KeyType === "HASH").AttributeName,
        sk: index.KeySchema.find((entry) => entry.KeyType === "RANGE")?.AttributeName || null,
      },
    ]));
    this.tables.set(definition.TableName, { definition, key, indexes, items: new Map(), ttl: null });
  }

  #table(name) {
    const table = this.tables.get(name);
    if (!table) {
      const error = new Error(`Requested resource not found: Table: ${name} not found`);
      error.name = "ResourceNotFoundException";
      throw error;
    }
    return table;
  }

  async getItem(table, keyName, keyValue) {
    return copy(this.#table(table).items.get(keyValue));
  }

  async batchGetItems(table, keyName, keyValues) {
    const store = this.#table(table).items;
    return [...new Set(keyValues)].map((value) => copy(store.get(value))).filter(Boolean);
  }

  async queryIndex(table, { indexName, pkAttr, pkValue, skAttr, skFrom, skTo, skEquals }) {
    const store = this.#table(table);
    if (!store.indexes.has(indexName)) throw new Error(`Index ${indexName} does not exist on ${table}`);
    const rows = [...store.items.values()].filter((item) => {
      if (item[pkAttr] !== pkValue) return false;
      if (skAttr && item[skAttr] === undefined) return false;
      if (skAttr && skEquals !== undefined) return item[skAttr] === skEquals;
      if (skAttr && skFrom !== undefined) return item[skAttr] >= skFrom && item[skAttr] <= skTo;
      return true;
    });
    if (skAttr) rows.sort((a, b) => (a[skAttr] < b[skAttr] ? -1 : a[skAttr] > b[skAttr] ? 1 : 0));
    return rows.map(copy);
  }

  async scanTable(table) {
    return [...this.#table(table).items.values()].map(copy);
  }

  #check(action) {
    const store = this.#table(action.table);
    const keyValue = action.op === "put" ? action.item[store.key] : action.key.value;
    const current = store.items.get(keyValue);
    const condition = action.condition;
    if (!condition) return true;
    if (condition.absent) return !current;
    if (condition.equals) return Boolean(current) && current[condition.equals.attr] === condition.equals.value;
    if (condition.absentOr) {
      return !current || current[condition.absentOr.attr] === condition.absentOr.value;
    }
    throw new Error(`Unknown write condition ${JSON.stringify(condition)}`);
  }

  async write(actions) {
    if (actions.length > MAX_TRANSACTION_ACTIONS) {
      throw new Error(`A single change needs ${actions.length} writes; DynamoDB allows ${MAX_TRANSACTION_ACTIONS}`);
    }
    const touched = new Set();
    actions.forEach((action) => {
      const store = this.#table(action.table);
      const keyValue = action.op === "put" ? action.item[store.key] : action.key.value;
      const id = `${action.table}\u0000${keyValue}`;
      if (touched.has(id)) {
        const error = new Error("Transaction request cannot include multiple operations on one item");
        error.name = "ValidationException";
        throw error;
      }
      touched.add(id);
    });
    const failed = actions.findIndex((action) => !this.#check(action));
    if (failed >= 0) throw new ConditionFailedError(failed);
    for (const action of actions) {
      const store = this.#table(action.table);
      if (action.op === "put") store.items.set(action.item[store.key], copy(action.item));
      else store.items.delete(action.key.value);
    }
  }

  async listTables() {
    return [...this.tables.keys()];
  }

  async describeTable(table) {
    const store = this.tables.get(table);
    if (!store) return null;
    return { ...structuredClone(store.definition), TableStatus: "ACTIVE", ItemCount: store.items.size };
  }

  async createTable(definition) {
    if (this.tables.has(definition.TableName)) {
      const error = new Error(`Table already exists: ${definition.TableName}`);
      error.name = "ResourceInUseException";
      throw error;
    }
    this.#create(definition);
  }

  async ttlEnabled(table) {
    return Boolean(this.#table(table).ttl);
  }

  async enableTtl(table, attribute) {
    this.#table(table).ttl = attribute;
  }

  async enablePointInTimeRecovery() {}

  async ping() {
    return true;
  }
}
