export const CATEGORIES_PATH = '/api/v2/settings/config/categories';
export const CATEGORY_MAX_LENGTH = 60;

export interface InstructorCategory {
  name: string;
  count: number;
}

export function categoryPath(name: string): string {
  return `${CATEGORIES_PATH}/${encodeURIComponent(name)}`;
}

export function cleanCategoryName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function categoryNameProblem(value: string, existing: InstructorCategory[], renaming?: string): string {
  const name = cleanCategoryName(value);
  if (!name) return 'Enter a category name.';
  if (name.length > CATEGORY_MAX_LENGTH) return `Use at most ${CATEGORY_MAX_LENGTH} characters.`;
  const clash = existing.some((category) => category.name !== renaming && category.name.toLowerCase() === name.toLowerCase());
  return clash ? 'That category already exists.' : '';
}

export function categoryOptions(configured: string[], current: string | null | undefined): string[] {
  const value = String(current ?? '').trim();
  return value && !configured.includes(value) ? [...configured, value] : [...configured];
}

export function instructorsLabel(count: number): string {
  return count === 1 ? '1 instructor' : `${count} instructors`;
}

export function inUseCategories(instructors: Array<{ instructor_category?: string | null }>): string[] {
  const names = new Set<string>();
  for (const instructor of instructors) {
    const name = String(instructor.instructor_category ?? '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}
