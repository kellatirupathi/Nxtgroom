export const INSTRUCTOR_ROLES = ['INSTRUCTOR', 'CENTRAL_INSTRUCTOR', 'CENTRAL_TEAM', 'MENTOR', 'OTHER'] as const;

export function instructorRoleOptions(
  existingRoles: Iterable<string | null | undefined>,
  currentRole?: string | null,
): string[] {
  const standard: readonly string[] = INSTRUCTOR_ROLES;
  const extra = new Set<string>();
  for (const role of [...existingRoles, currentRole]) {
    const value = typeof role === 'string' ? role.trim() : '';
    if (value && !standard.includes(value)) extra.add(value);
  }
  return [...standard, ...[...extra].sort((a, b) => a.localeCompare(b))];
}
