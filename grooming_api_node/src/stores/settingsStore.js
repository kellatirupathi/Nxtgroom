// Application settings, one document per settings group in app_settings.
const STORE = "app_settings";

export async function getSetting(db, id) {
  return db.collection(STORE).findOne({ _id: id });
}

export async function saveSetting(db, id, { set = {}, setOnInsert } = {}) {
  await db.collection(STORE).updateOne(
    { _id: id },
    setOnInsert ? { $set: set, $setOnInsert: setOnInsert } : { $set: set },
    { upsert: true }
  );
}

export async function addSettingListValue(db, id, field, value, { set = {}, setOnInsert } = {}) {
  await db.collection(STORE).updateOne(
    { _id: id },
    {
      $addToSet: { [field]: value },
      $set: set,
      ...(setOnInsert ? { $setOnInsert: setOnInsert } : {}),
    },
    { upsert: true }
  );
}

export async function removeSettingListValue(db, id, field, value, { set = {} } = {}) {
  await db.collection(STORE).updateOne(
    { _id: id },
    { $pull: { [field]: value }, $set: set }
  );
}
