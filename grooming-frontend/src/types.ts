/** Shared domain types mirroring the API's serialized documents. */

export type Role = 'SUPER_ADMIN' | 'BOA';

export type AttendanceStatus =
  | 'compliant'
  | 'non_compliant'
  | 'review_required'
  | 'error'
  | 'pending';

export type ImageQuality = 'ADEQUATE' | 'RETAKE_RECOMMENDED';

export interface College {
  _id: string;
  name: string;
  location: string;
}

export interface Boa {
  _id: string;
  employee_id: string;
  name: string;
  college_id: string;
  college_name?: string | null;
  email?: string | null;
  created_at?: string;
}

export interface DailyFeedback {
  date?: string;
  status?: string;
  overall_status?: string;
}

export interface Instructor {
  _id: string;
  uuid?: string;
  employee_id?: string;
  name: string;
  role: string;
  gender: string;
  college_id: string;
  college_name?: string | null;
  email?: string | null;
  phone_no?: string | null;
  created_at?: string;
  daily_feedbacks?: DailyFeedback[];
}

export interface AttendanceRecord {
  _id: string;
  instructor_id: string;
  instructor_name?: string;
  instructor_role?: string;
  college_name?: string;
  date?: string;
  check_in_time?: string;
  check_out_time?: string | null;
  location_coordinates?: string | null;
  status?: string;
  remarks?: string | null;
}

export interface CheckItem {
  checkpoint_name: string;
  observation: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  reason: string;
}

export interface Evaluation {
  overall_status?: string;
  ai_summary?: string;
  requires_human_review?: boolean;
  image_quality?: ImageQuality;
  general_idcard_check?: CheckItem[];
  grooming_check?: CheckItem[];
  attire_check?: CheckItem[];
  accessories_check?: CheckItem[];
  footwear_check?: CheckItem[];
}

export interface CurrentUser {
  email: string;
  role: Role;
  college_id: string | null;
}

export interface NotificationSettings {
  checkin_email_enabled: boolean;
  checkout_email_enabled: boolean;
  only_when_non_compliant: boolean;
  only_when_review_required: boolean;
}

/** Options accepted by the shared fetch helpers. */
export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set false for endpoints that must be called without a bearer token. */
  auth?: boolean;
  timeoutMs?: number;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  role: Role;
  expires_in: number;
}

export interface PaginatedOptions extends ApiRequestOptions {
  pageSize?: number;
  maxItems?: number;
}
