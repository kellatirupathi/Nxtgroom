import { z } from "zod";

export const collegeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(160),
});

export const boaSchema = z.object({
  employee_id: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
  college_id: z.string().trim().min(1).max(100),
});

export const boaUpdateSchema = z.object({
  employee_id: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().min(12).max(128).optional()
  ),
  college_id: z.string().trim().min(1).max(100),
});

export const instructorSchema = z.object({
  employee_id: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(120),
  role: z.enum(["Trainee", "Senior Instructor", "Lead Instructor"]),
  gender: z.string().trim().transform((value) => value.toUpperCase()).pipe(z.enum(["MALE", "FEMALE"])),
  college_id: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone_no: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().trim().max(30).regex(/^[+()\-\s\d]*$/, "Invalid phone number").optional()
  ),
});

export const checkoutSchema = z.object({
  instructor_id: z.string().trim().min(1).max(100),
});

export function parseCoordinates(value) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return `${latitude},${longitude}`;
}

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(422).json({
        detail: result.error.issues.map((issue) => ({
          loc: ["body", ...issue.path],
          msg: issue.message,
          type: issue.code,
        })),
      });
    }
    req.validatedBody = result.data;
    return next();
  };
}

export const adminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});

export const adminUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  // Blank means "leave the existing credential alone".
  password: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().min(12).max(128).optional()
  ),
});

export const setPasswordSchema = z.object({
  new_password: z.string().min(12).max(128),
});
