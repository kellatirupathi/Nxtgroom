export interface BoaFormData {
  employee_id?: string;
  name?: string;
  email?: string;
  password?: string;
  college_id?: string;
  [key: string]: unknown;
}

export interface BuildBoaPayloadOptions {
  editing?: boolean;
}

export function buildBoaPayload(
  formData: BoaFormData,
  { editing = false }: BuildBoaPayloadOptions = {},
): BoaFormData {
  const payload: BoaFormData = { ...formData };
  if (editing && !payload.password) delete payload.password;
  return payload;
}
