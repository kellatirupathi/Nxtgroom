import type { Instructor } from '../types';

export interface SearchableInstructor {
  instructor: Instructor;
  name: string;
  email: string;
  role: string;
  institute: string;
  category: string;
  userId: string;
}

export function buildSearchIndex(instructors: Instructor[]): SearchableInstructor[] {
  return instructors.map((instructor) => ({
    instructor,
    name: String(instructor.name ?? '').toLowerCase(),
    email: String(instructor.email ?? '').toLowerCase(),
    role: String(instructor.instructor_role ?? instructor.role ?? '').toLowerCase(),
    institute: String(instructor.institute_name ?? '').toLowerCase(),
    category: String(instructor.instructor_category ?? '').toLowerCase(),
    userId: String(instructor.instructor_user_id ?? instructor.employee_id ?? '').toLowerCase(),
  }));
}

function scoreToken(entry: SearchableInstructor, token: string): number {
  if (entry.name.startsWith(token)) return 100;
  if (entry.name.includes(` ${token}`)) return 80;
  if (entry.email.startsWith(token)) return 70;
  if (entry.name.includes(token)) return 50;
  if (entry.email.includes(token)) return 40;
  if (entry.userId.startsWith(token)) return 30;
  if (entry.institute.includes(token)) return 15;
  if (entry.role.includes(token)) return 10;
  if (entry.category.includes(token)) return 10;
  if (entry.userId.includes(token)) return 5;
  return 0;
}

export function searchInstructors(
  index: SearchableInstructor[],
  query: string,
  limit = 50,
): Instructor[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return index.slice(0, limit).map((entry) => entry.instructor);
  }

  const scored: { entry: SearchableInstructor; score: number }[] = [];
  for (const entry of index) {
    let total = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const score = scoreToken(entry, token);
      if (score === 0) {
        matchedAll = false;
        break;
      }
      total += score;
    }
    if (matchedAll) scored.push({ entry, score: total });
  }

  scored.sort((a, b) => (
    b.score - a.score || a.entry.name.localeCompare(b.entry.name)
  ));
  return scored.slice(0, limit).map((item) => item.entry.instructor);
}
