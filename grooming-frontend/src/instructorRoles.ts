/**
 * The roles an administrator can give an instructor in the Instructors form.
 *
 * INSTRUCTOR and CENTRAL_INSTRUCTOR are the values the BigQuery roster uses;
 * CENTRAL_TEAM, MENTOR and OTHER cover people the roster has no role for.
 * Stored exactly as written here, in the same upper-case form as the synced
 * values, so filters and exports group them together.
 */
export const INSTRUCTOR_ROLES = ['INSTRUCTOR', 'CENTRAL_INSTRUCTOR', 'CENTRAL_TEAM', 'MENTOR', 'OTHER'] as const;

/**
 * The Role dropdown's options: the standard roles first, in a fixed order,
 * then any other role already in the roster or on the instructor being
 * edited, alphabetically. Keeping those extra values means opening the form
 * never silently replaces an unusual role with the first option.
 */
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
