export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'BOA';

export const ELEVATED_ROLES: readonly Role[] = ['SUPER_ADMIN', 'ADMIN'];

export const ALL_ROLES: readonly Role[] = ['SUPER_ADMIN', 'ADMIN', 'BOA'];

export function isElevatedRole(role: Role | null | undefined): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN';
}

export interface AdminUser {
  _id: string;
  name: string;
  email: string;
  role: Role;
  created_at?: string | null;
  disabled_at?: string | null;
}

export type AttendanceStatus =
  | 'compliant'
  | 'non_compliant'
  | 'unassessed'
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
  has_email?: boolean;
  phone_no?: string | null;
  created_at?: string;
  daily_feedbacks?: DailyFeedback[];
  face_count?: number;
  face_indexed_at?: string | null;
  reference_photo_url?: string | null;
  instructor_user_id?: string | null;
  instructor_role?: string | null;
  institute_name?: string | null;
  instructor_category?: string | null;
  source?: string | null;
  synced_at?: string | null;
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
  location_accuracy_m?: number | null;
  location_address?: string | null;
  location_address_full?: string | null;
  check_out_coordinates?: string | null;
  check_out_location_accuracy_m?: number | null;
  check_out_location_address?: string | null;
  checkout_status?: string | null;
  checkout_compliance_status?: string | null;
  checkout_remarks?: string | null;
  evaluation_queue_status?: string | null;
  checkout_evaluation_queue_status?: string | null;
  attire_type?: string | null;
  report_token?: string | null;
  check_in_photo_key?: string | null;
  check_out_photo_key?: string | null;
  status?: string;
  remarks?: string | null;
  attendance_day?: string;
  updated_at?: string;
  escalation?: AttendanceEscalation | null;
}

export interface AttendanceEscalation {
  week_start: string;
  week_end: string;
  count: number;
  streak?: boolean;
  days?: string[];
}

export interface CheckItem {
  code?: string;
  checkpoint_name: string;
  observation: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  reason: string;
}

export type Visibility = 'VISIBLE' | 'PARTIAL' | 'NOT_VISIBLE';

export interface VisibleRegions {
  face: Visibility;
  upper_body: Visibility;
  lower_body: Visibility;
  footwear: Visibility;
  id_card: Visibility;
  hands: Visibility;
}

export type AttireType = 'FORMAL' | 'SAREE' | 'KURTI_WITH_DUPATTA' | 'ABAYA' | 'KURTA_PAJAMA' | 'UNKNOWN';

export interface WeeklyRotation {
  saree_days: number;
  kurti_days: number;
  unknown_days: number;
  required_saree_days: number;
  required_kurti_days: number;
  abaya_days?: number;
  status: 'IN_PROGRESS' | 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA' | 'NOT_APPLICABLE';
}

export interface Evaluation {
  overall_status?: string;
  ai_summary?: string;
  image_quality?: ImageQuality;
  attire_type?: AttireType;
  visible_regions?: VisibleRegions | null;
  unassessed_reason?: string | null;
  improvement_tips?: string[];
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
  can_delete_records?: boolean;
  can_delete_checkout?: boolean;
  reanalyse_enabled?: boolean;
  face_identification?: boolean;
}

export interface UserPermissions {
  user_id?: string;
  email?: string;
  role?: Role;
  can_delete_records: boolean;
  source: 'ROLE' | 'USER' | 'WORKSPACE';
  workspace_default: boolean;
}

export interface AccessSettings {
  boa_can_delete_records: boolean;
  boa_can_delete_checkout: boolean;
}

export type IdentificationMode = 'FACE_ONLY' | 'SELECTOR';

export interface CollegeIdentification {
  college_id: string;
  college_name: string | null;
  mode: IdentificationMode;
  source: 'COLLEGE' | 'DEFAULT';
  instructors: number;
  enrolled: number;
  enrolled_percent: number;
  low_enrolment: boolean;
}

export interface IdentificationSettings {
  default_mode: IdentificationMode;
  modes: IdentificationMode[];
  low_enrolment_percent: number;
  colleges: CollegeIdentification[];
}

export interface NotificationSettings {
  checkin_email_enabled: boolean;
  checkout_email_enabled: boolean;
  weekly_email_enabled: boolean;
  only_when_non_compliant: boolean;
  reanalyse_enabled: boolean;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
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
  cacheMs?: number;
}

export type DashboardStatusKey = 'compliant' | 'unassessed' | 'non_compliant' | 'pending' | 'error';

export interface DashboardSummary {
  total_instructors: number;
  present: number;
  present_percent: number | null;
  not_checked_in: number;
  check_ins: number;
  analysed: number;
  compliant: number;
  non_compliant: number;
  compliance_percent: number | null;
  compliance_same_day_last_week: number | null;
  unassessed: number;
  pending: number;
  errors: number;
  checked_out: number;
  on_duty: number;
  missed_checkout_previous_day: number;
}

export interface DashboardTrendDay {
  day: string;
  present: number;
  present_percent: number | null;
  compliant: number;
  non_compliant: number;
  compliance_percent: number | null;
}

export interface DashboardFailedCheckpoint {
  code: string;
  name: string;
  audience: string;
  count: number;
}

export interface DashboardEscalation {
  instructor_id: string;
  name: string;
  college_name: string;
  count: number;
  top_checkpoint: string | null;
  attendance_id: string;
}

export interface DashboardInstitute {
  college_id: string;
  name: string;
  mode: 'FACE_ONLY' | 'SELECTOR';
  present: number;
  expected: number;
  instructors: number;
  present_percent: number | null;
  compliant: number;
  non_compliant: number;
  compliance_percent: number | null;
  enrolled: number;
  enrolled_percent: number;
  low_enrolment: boolean;
}

export interface DashboardData {
  generated_at: string;
  time_zone: string;
  today: string;
  week_start: string;
  previous_working_day: string;
  same_day_last_week: string;
  college: { college_id: string; name: string } | null;
  summary: DashboardSummary;
  status_breakdown: { key: DashboardStatusKey; count: number }[];
  trend: DashboardTrendDay[];
  failed_checkpoints: DashboardFailedCheckpoint[];
  escalations: DashboardEscalation[];
}

export interface DashboardInstitutesRange {
  from: string;
  to: string;
  working_days: number;
  institutes: DashboardInstitute[];
}
