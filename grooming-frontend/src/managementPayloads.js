export function buildBoaPayload(formData, { editing = false } = {}) {
  const payload = { ...formData };
  if (editing && !payload.password) delete payload.password;
  return payload;
}
