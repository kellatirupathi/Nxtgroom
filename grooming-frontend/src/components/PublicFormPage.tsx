import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, ImagePlus, Loader2, Pencil, RefreshCw, X } from 'lucide-react';
import { apiFetch, type ApiError } from '../api';
import ConfirmDialog from './ConfirmDialog';
import FormDatePicker from './FormDatePicker';
import FormPeopleEditor, { type DraftPerson, type EditablePhoto, type PersonField, type PhotoPeople } from './FormPeopleEditor';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';
import { publicFormFromLocation } from '../routes';
import { localDateValue } from '../attendanceFilters';
import {
  cachedInstitute,
  publicFormPath,
  readCachedForm,
  rosterPath,
  takePrefetchedForm,
  takePrefetchedRoster,
  writeCachedForm,
} from '../lib/formPrefetch';
import {
  deleteFormDraft,
  draftKey,
  draftMatches,
  loadFormDraft,
  saveFormDraft,
  type StoredDraft,
} from '../lib/formDraftStore';
import {
  FORM_MAX_FILE_BYTES,
  FORM_MAX_FILE_MB,
  FORM_MAX_PHOTOS,
  FORM_REASON_OPTIONS,
  FORM_STATUS_OPTIONS,
  FORM_TITLE,
  formatMoment,
  formPagePath,
  longDate,
  prepareFormPhoto,
  statusLabel,
  type FormInstructor,
  type FormPhoto,
  type FormReason,
  type FormResponse,
  type FormStatus,
  type PublicFormData,
} from '../lib/instituteForm';

interface PublicFormPageProps {
  slug: string;
  token: string;
  date: string | null;
}

interface NewPhoto {
  id: string;
  // The photo as uploaded (shrunk for sending).
  file: File;
  // The photo as chosen, full size: people are found and cut out from it.
  original: File;
  preview: string;
}

interface Draft {
  status: FormStatus | '';
  submittedBy: string;
  reason: FormReason | '';
  reasonOther: string;
  kept: FormPhoto[];
  added: NewPhoto[];
  // The people in each photo, by saved photo id or new photo id.
  people: Record<string, PhotoPeople>;
}

type Errors = Partial<Record<'status' | 'photos' | 'submitted_by' | 'reason', string>>;

const REQUIRED = 'This is a required question';
const NAME_KEY = 'ft_form_submitted_by';
// A new form starts with Photo Submission Status set to Yes.
const EMPTY_DRAFT: Draft = { status: 'yes', submittedBy: '', reason: '', reasonOther: '', kept: [], added: [], people: {} };

let personCounter = 0;

function nextPersonKey(): string {
  personCounter += 1;
  return `person-${personCounter}`;
}

// The people already saved on a photo, ready to edit.
function savedPeople(photo: FormPhoto): PhotoPeople {
  return {
    status: 'ready',
    people: (photo.people ?? []).map((person) => ({
      key: nextPersonKey(),
      id: person.id,
      preview: person.crop_url,
      instructorId: person.instructor_id ?? '',
      source: person.source,
      // A name kept as printed (not in the instructor list).
      labelName: !person.instructor_id && person.name ? person.name : undefined,
      labelId: !person.instructor_id && person.employee_id ? person.employee_id : undefined,
      box: person.box,
    })),
  };
}

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch { }
}

function draftFrom(response: FormResponse | null): Draft {
  if (!response) return { ...EMPTY_DRAFT, people: {}, submittedBy: rememberedName() };
  return {
    status: response.status,
    submittedBy: response.submitted_by,
    reason: response.reason || '',
    reasonOther: response.reason_other || '',
    kept: response.photos,
    added: [],
    people: Object.fromEntries(response.photos.map((photo) => [photo.id, savedPeople(photo)])),
  };
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

// A person after their name or ID is typed in: a name or ID that is one of
// the institute's instructors links that instructor (filling in the other),
// anything else is kept as typed, with the other value left as it was.
function editedPerson(person: DraftPerson, field: PersonField, value: string, roster: readonly FormInstructor[]): DraftPerson {
  const current = person.instructorId ? roster.find((option) => option.id === person.instructorId) : undefined;
  const name = current?.name ?? person.labelName;
  const id = current?.employee_id ?? person.labelId;
  if (field === 'name') {
    const match = roster.find((option) => sameText(option.name, value));
    if (match) return { ...person, instructorId: match.id, source: 'manual', labelName: undefined, labelId: undefined };
    return { ...person, instructorId: '', source: value.trim() || id ? 'manual' : 'none', labelName: value || undefined, labelId: id || undefined };
  }
  const typed = value.toUpperCase();
  const match = roster.find((option) => sameText(option.employee_id, typed));
  if (match) return { ...person, instructorId: match.id, source: 'manual', labelName: undefined, labelId: undefined };
  return { ...person, instructorId: '', source: typed.trim() || name ? 'manual' : 'none', labelName: name || undefined, labelId: typed || undefined };
}

// What is kept in the browser while the form is being filled in.
function toStoredDraft(draft: Draft, baseUpdatedAt: string | null): StoredDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    baseUpdatedAt,
    status: draft.status,
    submittedBy: draft.submittedBy,
    reason: draft.reason,
    reasonOther: draft.reasonOther,
    keptIds: draft.kept.map((photo) => photo.id),
    added: draft.added.map((photo) => ({ key: photo.id, file: photo.file, name: photo.file.name })),
    people: Object.fromEntries(Object.entries(draft.people)
      .filter(([, state]) => state.status !== 'reading')
      .map(([key, state]) => [key, {
        status: state.status as 'ready' | 'failed',
        message: state.message,
        photoInstructorIds: state.photoInstructorIds,
        labelsRead: state.labelsRead,
        labelsFailed: state.labelsFailed,
        people: state.people.map((person) => ({
          id: person.id,
          crop: person.crop,
          instructorId: person.instructorId,
          source: person.source,
          readText: person.readText,
          labelName: person.labelName,
          labelId: person.labelId,
          box: person.box,
        })),
      }])),
  };
}

// A kept draft back as the form's answers. Returns the picture addresses it
// made for new cut-outs, and the added photos still to be read.
function draftFromStored(stored: StoredDraft, response: FormResponse | null): { draft: Draft; cropUrls: string[]; unread: NewPhoto[] } {
  const cropUrls: string[] = [];
  const kept = (response?.photos ?? []).filter((photo) => stored.keptIds.includes(photo.id));
  const renamed = new Map<string, string>();
  const added: NewPhoto[] = stored.added.map((item) => {
    photoCounter += 1;
    const file = item.file instanceof File ? item.file : new File([item.file], item.name || 'photo.jpg', { type: item.file.type || 'image/jpeg' });
    const id = `new-${photoCounter}`;
    renamed.set(item.key, id);
    return { id, file, original: file, preview: URL.createObjectURL(file) };
  });
  const people: Record<string, PhotoPeople> = {};
  const restorePeople = (photoKey: string, saved: Map<string, string | null>) => {
    const state = stored.people[photoKey];
    if (!state) return undefined;
    return {
      status: state.status,
      message: state.message,
      photoInstructorIds: state.photoInstructorIds,
      labelsRead: state.labelsRead,
      labelsFailed: state.labelsFailed,
      people: state.people
        .filter((person) => (person.id ? saved.has(person.id) : Boolean(person.crop)))
        .map((person) => {
          let preview: string | null = person.id ? saved.get(person.id) ?? null : null;
          if (!person.id && person.crop) {
            preview = URL.createObjectURL(person.crop);
            cropUrls.push(preview);
          }
          return { ...person, key: nextPersonKey(), preview };
        }),
    } satisfies PhotoPeople;
  };
  for (const photo of kept) {
    const saved = new Map((photo.people ?? []).map((person) => [person.id, person.crop_url]));
    people[photo.id] = restorePeople(photo.id, saved) ?? savedPeople(photo);
  }
  for (const [oldKey, id] of renamed) {
    const state = restorePeople(oldKey, new Map());
    if (state) people[id] = state;
  }
  return {
    draft: {
      status: stored.status,
      submittedBy: stored.submittedBy,
      reason: (stored.reason || '') as FormReason | '',
      reasonOther: stored.reasonOther,
      kept,
      added,
      people,
    },
    cropUrls,
    unread: added.filter((photo) => !people[photo.id]),
  };
}

function validate(draft: Draft): Errors {
  const errors: Errors = {};
  if (!draft.status) errors.status = REQUIRED;
  if (draft.status === 'yes') {
    const total = draft.kept.length + draft.added.length;
    if (total === 0) errors.photos = REQUIRED;
    else if (total > FORM_MAX_PHOTOS) errors.photos = `You can upload up to ${FORM_MAX_PHOTOS} photos.`;
  }
  if (!draft.submittedBy.trim()) errors.submitted_by = REQUIRED;
  else if (draft.submittedBy.trim().length > 120) errors.submitted_by = 'Use 120 characters or fewer';
  if (draft.status === 'no') {
    if (!draft.reason) errors.reason = REQUIRED;
    else if (draft.reason === 'other' && !draft.reasonOther.trim()) errors.reason = 'Please type the other reason';
  }
  return errors;
}

let photoCounter = 0;

function Card({ id, invalid = false, children }: { id?: string; invalid?: boolean; children: ReactNode }) {
  return (
    <section
      id={id}
      className={`rounded-lg border bg-white px-5 py-5 sm:px-6 sm:py-6 ${invalid ? 'border-rose-600' : 'border-[#dadce0]'}`}
    >
      {children}
    </section>
  );
}

function QuestionTitle({ children, required = false, htmlFor }: { children: ReactNode; required?: boolean; htmlFor?: string }) {
  const content = (
    <>
      {children}
      {required && <span className="ml-1 text-rose-600" aria-hidden="true">*</span>}
    </>
  );
  return htmlFor
    ? <label htmlFor={htmlFor} className="block text-base text-slate-900">{content}</label>
    : <h2 className="text-base font-normal text-slate-900">{content}</h2>;
}

function ErrorLine({ message, id }: { message?: string; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-3 flex items-center gap-2 text-sm text-rose-600">
      <AlertCircle size={18} aria-hidden="true" className="shrink-0" />
      {message}
    </p>
  );
}

function RadioRow({ name, value, checked, label, onChange }: { name: string; value: string; checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md py-1.5 text-[15px] text-slate-800">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="h-5 w-5 shrink-0 cursor-pointer accent-indigo-600"
      />
      {label}
    </label>
  );
}

function Thumb({ src, label, onOpen, onRemove }: { src: string | null; label: string; onOpen: () => void; onRemove?: () => void }) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-slate-200 bg-slate-100">
      <button type="button" onClick={onOpen} className="block h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" aria-label={`View ${label}`}>
        {src ? <img src={src} alt={label} className="h-full w-full object-cover" loading="lazy" /> : <span className="text-xs text-slate-400">No preview</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          title="Remove photo"
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-900/70 text-white shadow hover:bg-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default function PublicFormPage({ slug, token, date: initialDate }: PublicFormPageProps) {
  const [date, setDate] = useState<string | null>(initialDate);
  const [data, setData] = useState<PublicFormData | null>(null);
  const [institute, setInstitute] = useState<PublicFormData['institute'] | null>(null);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState('');
  const [dateError, setDateError] = useState('');
  const [mode, setMode] = useState<'summary' | 'edit'>('edit');
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [removing, setRemoving] = useState<{ kind: 'kept' | 'added'; id: string } | null>(null);
  const [viewer, setViewer] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [roster, setRoster] = useState<FormInstructor[] | null>(null);
  const [rosterError, setRosterError] = useState('');
  const [personRemoving, setPersonRemoving] = useState<{ photoKey: string; personKey: string } | null>(null);
  const [restored, setRestored] = useState(false);
  // Whether the answers on screen have been changed since they were loaded,
  // and so are worth keeping in the browser.
  const dirtyRef = useRef(false);
  const modeRef = useRef<'summary' | 'edit'>('edit');
  const dataRef = useRef<PublicFormData | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const addedRef = useRef<NewPhoto[]>([]);
  const draftRef = useRef<Draft>(EMPTY_DRAFT);
  // Picture addresses made in the browser for new people's cut-outs.
  const cropUrlsRef = useRef<Set<string>>(new Set());
  const rosterRef = useRef<Promise<FormInstructor[]> | null>(null);

  useEffect(() => {
    addedRef.current = draft.added;
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    modeRef.current = mode;
    dataRef.current = data;
  }, [mode, data]);

  // Keep changed answers in this browser a moment after each change, so a
  // reload does not lose them...
  useEffect(() => {
    if (mode !== 'edit' || !data || !dirtyRef.current) return undefined;
    const key = draftKey(token, data.date);
    const base = data.response?.updated_at ?? null;
    const timer = setTimeout(() => { void saveFormDraft(key, toStoredDraft(draft, base)); }, 400);
    return () => clearTimeout(timer);
  }, [draft, mode, data, token]);

  // ...and at once when the page is being left or reloaded.
  useEffect(() => {
    const keepNow = () => {
      const current = dataRef.current;
      if (modeRef.current !== 'edit' || !current || !dirtyRef.current) return;
      void saveFormDraft(draftKey(token, current.date), toStoredDraft(draftRef.current, current.response?.updated_at ?? null));
    };
    window.addEventListener('pagehide', keepNow);
    return () => window.removeEventListener('pagehide', keepNow);
  }, [token]);

  const forgetKeptDraft = (date: string | undefined = data?.date) => {
    if (date) void deleteFormDraft(draftKey(token, date));
    setRestored(false);
  };

  // Brings back answers kept in this browser for this form and date, unless
  // the response has been sent or changed elsewhere since.
  const restoreKeptDraft = async (loaded: PublicFormData, isStale: () => boolean) => {
    const key = draftKey(token, loaded.date);
    const stored = await loadFormDraft(key);
    if (!stored || isStale()) return;
    if (!draftMatches(stored, loaded.response?.updated_at ?? null)) {
      await deleteFormDraft(key);
      return;
    }
    const { draft: next, cropUrls, unread } = draftFromStored(stored, loaded.response);
    replaceDraft(next);
    for (const url of cropUrls) cropUrlsRef.current.add(url);
    dirtyRef.current = true;
    setMode('edit');
    setRestored(true);
    for (const photo of unread) void readPeople(photo);
  };

  useEffect(() => () => {
    for (const photo of addedRef.current) URL.revokeObjectURL(photo.preview);
    for (const url of cropUrlsRef.current) URL.revokeObjectURL(url);
    void import('../lib/groupPhotoReader').then((reader) => reader.releaseGroupPhotoReader()).catch(() => { });
  }, []);

  // The institute's instructors, for naming the people in the photos.
  const ensureRoster = (): Promise<FormInstructor[]> => {
    if (!rosterRef.current) {
      rosterRef.current = (takePrefetchedRoster(token) ?? apiFetch<FormInstructor[]>(rosterPath(token), { auth: false }))
        .then((list) => {
          const value = Array.isArray(list) ? list : [];
          setRoster(value);
          setRosterError('');
          return value;
        })
        .catch(() => {
          rosterRef.current = null;
          setRoster([]);
          setRosterError('The list of names could not be loaded, so names cannot be filled in now. Reload the page to try again.');
          return [];
        });
    }
    return rosterRef.current;
  };

  const forgetCropUrls = (people: DraftPerson[] = []) => {
    for (const person of people) {
      if (person.crop && person.preview && cropUrlsRef.current.has(person.preview)) {
        URL.revokeObjectURL(person.preview);
        cropUrlsRef.current.delete(person.preview);
      }
    }
  };

  const setPhotoPeople = (photoKey: string, change: (current: PhotoPeople | undefined) => PhotoPeople | undefined) => {
    setDraft((current) => {
      const next = change(current.people[photoKey]);
      const people = { ...current.people };
      if (next) people[photoKey] = next;
      else delete people[photoKey];
      return { ...current, people };
    });
  };

  // Finds the people in a new photo, cuts them out and names them from the
  // labels printed next to them, all in this browser.
  const readPeople = async (photo: NewPhoto) => {
    setPhotoPeople(photo.id, () => ({ status: 'reading', stage: 'loading', people: [] }));
    try {
      const list = await ensureRoster();
      const reader = await import('../lib/groupPhotoReader');
      const reading = await reader.readGroupPhoto(
        photo.original,
        list,
        (stage) => setPhotoPeople(photo.id, (current) => (current?.status === 'reading' ? { ...current, stage } : current)),
      );
      const people: DraftPerson[] = reading.people.map((person) => {
        const preview = URL.createObjectURL(person.crop);
        cropUrlsRef.current.add(preview);
        const label = person.label;
        return {
          key: nextPersonKey(),
          crop: person.crop,
          preview,
          // The instructor the label names, or else the name and id as printed.
          instructorId: label?.instructor?.id ?? '',
          source: label ? 'label' : 'none',
          readText: label?.text,
          labelName: label && !label.instructor ? (label.nameText ?? undefined) : undefined,
          labelId: label && !label.instructor ? (label.idText ?? undefined) : undefined,
          box: person.box,
        } satisfies DraftPerson;
      });
      if (!draftRef.current.added.some((item) => item.id === photo.id)) {
        forgetCropUrls(people);
        return;
      }
      setPhotoPeople(photo.id, () => ({
        status: 'ready',
        people,
        photoInstructorIds: [...new Set(reading.labels.map((label) => label.instructor?.id).filter((id): id is string => Boolean(id)))],
        labelsRead: reading.labels.length,
        labelsFailed: reading.labelsFailed,
      }));
    } catch {
      setPhotoPeople(photo.id, (current) => (current ? {
        status: 'failed',
        people: [],
        message: 'The people in this photo could not be found automatically on this device.',
      } : current));
    }
  };

  const editPerson = (photoKey: string, personKey: string, field: PersonField, value: string) => {
    dirtyRef.current = true;
    setPhotoPeople(photoKey, (current) => current && {
      ...current,
      people: current.people.map((person) => (person.key === personKey ? editedPerson(person, field, value, roster ?? []) : person)),
    });
  };

  const removePerson = () => {
    if (!personRemoving) return;
    const { photoKey, personKey } = personRemoving;
    dirtyRef.current = true;
    forgetCropUrls(draft.people[photoKey]?.people.filter((person) => person.key === personKey));
    setPhotoPeople(photoKey, (current) => current && { ...current, people: current.people.filter((person) => person.key !== personKey) });
    setPersonRemoving(null);
  };

  useEffect(() => {
    document.title = institute ? `${FORM_TITLE} · ${institute.name}` : FORM_TITLE;
  }, [institute]);

  useEffect(() => {
    const onPopState = () => {
      const route = publicFormFromLocation();
      if (route && route.token === token) setDate(route.date);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [token]);

  const replaceDraft = (next: Draft) => {
    const keep = new Set(next.added.map((photo) => photo.id));
    for (const photo of addedRef.current) {
      if (!keep.has(photo.id)) URL.revokeObjectURL(photo.preview);
    }
    // A fresh draft shows saved people from their stored pictures, so the
    // cut-outs made in this browser are no longer needed.
    for (const url of cropUrlsRef.current) URL.revokeObjectURL(url);
    cropUrlsRef.current.clear();
    draftRef.current = next;
    addedRef.current = next.added;
    dirtyRef.current = false;
    setDraft(next);
  };

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setLoading(true);
    setFatal('');
    setDateError('');
    setErrors({});
    setSubmitError('');
    setJustSubmitted(false);
    // The institute's name from an earlier visit goes in the header at once.
    const known = cachedInstitute(token);
    if (known) setInstitute((current) => current ?? known);

    let shown: PublicFormData | null = null;
    const show = (result: PublicFormData, fresh: boolean) => {
      setInstitute(result.institute);
      setToday(result.today);
      if (date === 'invalid') {
        setData(null);
        setDateError('This address has a date that is not a real calendar date. Pick a date above.');
        return;
      }
      if (fresh) writeCachedForm(token, result);
      const unchanged = shown !== null
        && shown.date === result.date
        && (shown.response?.updated_at ?? null) === (result.response?.updated_at ?? null);
      setData(result);
      if (unchanged) {
        // The copy shown first was right: keep anything already typed, and
        // otherwise just take the fresh photo links.
        if (!dirtyRef.current) replaceDraft(draftFrom(result.response));
        return;
      }
      shown = result;
      replaceDraft(draftFrom(result.response));
      setMode(result.response ? 'summary' : 'edit');
      setRestored(false);
      void restoreKeptDraft(result, () => disposed);
      // Today's link shows today's date in the address, so it can be shared
      // or bookmarked for that day.
      if (!date) window.history.replaceState(window.history.state, '', formPagePath(slug, token, result.date));
    };

    // The same link opened recently shows at once from this browser...
    const cached = date === 'invalid' ? null : readCachedForm(token, date, localDateValue());
    if (cached) {
      show(cached, false);
      setLoading(false);
    }
    // ...while the fresh data (usually already asked for as the page started)
    // arrives and takes its place.
    const request = takePrefetchedForm(token, date)
      ?? apiFetch<PublicFormData>(publicFormPath(token, date === 'invalid' ? null : date), { auth: false, signal: controller.signal });
    request
      .then((result) => {
        if (disposed) return;
        show(result, true);
      })
      .catch((error: ApiError) => {
        if (disposed || controller.signal.aborted) return;
        // Offline for a moment with a recent copy on screen: keep showing it.
        if (shown && !(Number(error?.status) >= 400)) return;
        const details = (error?.details ?? null) as { institute?: PublicFormData['institute']; today?: string } | null;
        if (error?.status === 422 && details?.institute) {
          setInstitute(details.institute);
          setToday(details.today || '');
          setData(null);
          setDateError(error.message);
          return;
        }
        setFatal(error?.message || 'The form could not be opened.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
    // replaceDraft only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, token, slug, reloadKey]);

  const shownDate = data?.date ?? (date && date !== 'invalid' ? date : today);
  const response = data?.response ?? null;

  // The names are needed as soon as the form can be edited.
  useEffect(() => {
    if (mode === 'edit' && data) void ensureRoster();
  }, [mode, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const goToDate = (value: string) => {
    if (!value || value === shownDate) return;
    if (today && value > today) {
      setDateError("This date has not come yet. Open today's form or an earlier day's.");
      return;
    }
    window.history.pushState(window.history.state, '', formPagePath(slug, token, value));
    setDate(value);
  };

  const update = (patch: Partial<Draft>, clear: keyof Errors | (keyof Errors)[] = []) => {
    dirtyRef.current = true;
    setDraft((current) => ({ ...current, ...patch }));
    const keys = Array.isArray(clear) ? clear : [clear];
    if (keys.length) {
      setErrors((current) => {
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      });
    }
  };

  const onFilesChosen = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!files.length) return;
    const room = FORM_MAX_PHOTOS - draft.kept.length - draft.added.length;
    const problems: string[] = [];
    if (files.length > room) problems.push(`You can upload up to ${FORM_MAX_PHOTOS} photos.`);
    setPreparing(true);
    const ready: NewPhoto[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.type && !file.type.startsWith('image/')) {
        problems.push(`${file.name} is not an image.`);
        continue;
      }
      if (file.size > FORM_MAX_FILE_BYTES) {
        problems.push(`${file.name} is larger than ${FORM_MAX_FILE_MB} MB.`);
        continue;
      }
      try {
        const prepared = await prepareFormPhoto(file);
        photoCounter += 1;
        ready.push({ id: `new-${photoCounter}`, file: prepared, original: file, preview: URL.createObjectURL(prepared) });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : `${file.name} could not be added.`);
      }
    }
    setPreparing(false);
    if (ready.length) dirtyRef.current = true;
    setDraft((current) => ({ ...current, added: [...current.added, ...ready] }));
    draftRef.current = { ...draftRef.current, added: [...draftRef.current.added, ...ready] };
    for (const photo of ready) void readPeople(photo);
    setErrors((current) => {
      const next = { ...current };
      if (problems.length) next.photos = problems.join(' ');
      else delete next.photos;
      return next;
    });
  };

  const confirmRemove = () => {
    if (!removing) return;
    dirtyRef.current = true;
    forgetCropUrls(draft.people[removing.id]?.people);
    if (removing.kind === 'added') {
      const photo = draft.added.find((item) => item.id === removing.id);
      if (photo) URL.revokeObjectURL(photo.preview);
      setDraft((current) => ({ ...current, added: current.added.filter((item) => item.id !== removing.id) }));
      draftRef.current = { ...draftRef.current, added: draftRef.current.added.filter((item) => item.id !== removing.id) };
    } else {
      setDraft((current) => ({ ...current, kept: current.kept.filter((item) => item.id !== removing.id) }));
    }
    setPhotoPeople(removing.id, () => undefined);
    setRemoving(null);
  };

  const startEdit = () => {
    replaceDraft(draftFrom(response));
    setErrors({});
    setSubmitError('');
    setJustSubmitted(false);
    setMode('edit');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    forgetKeptDraft();
    replaceDraft(draftFrom(response));
    setErrors({});
    setSubmitError('');
    setMode('summary');
  };

  const clearForm = () => {
    forgetKeptDraft();
    replaceDraft({ ...EMPTY_DRAFT, people: {} });
    setErrors({});
    setSubmitError('');
  };

  // "Start over" on answers brought back after a reload.
  const discardRestored = () => {
    forgetKeptDraft();
    replaceDraft(draftFrom(response));
    setErrors({});
    setSubmitError('');
    setMode(response ? 'summary' : 'edit');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!data || submitting || preparing) return;
    const found = validate(draft);
    setErrors(found);
    setSubmitError('');
    const first = (['status', 'photos', 'reason', 'submitted_by'] as const).find((key) => found[key]);
    if (first) {
      document.getElementById(`question-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (draft.status === 'yes' && [...draft.kept.map((photo) => photo.id), ...draft.added.map((photo) => photo.id)]
      .some((key) => draft.people[key]?.status === 'reading')) {
      setSubmitError('The people in the photos are still being read. Please wait a moment and press Submit again.');
      return;
    }
    setSubmitting(true);
    try {
      const body = new FormData();
      body.append('status', draft.status);
      body.append('submitted_by', draft.submittedBy.trim());
      if (draft.status === 'no') {
        body.append('reason', draft.reason);
        if (draft.reason === 'other') body.append('reason_other', draft.reasonOther.trim());
        body.append('keep', '[]');
      } else {
        body.append('keep', JSON.stringify(draft.kept.map((photo) => photo.id)));
        for (const photo of draft.added) body.append('photos', photo.file, photo.file.name);
        // Each photo's people: saved ones by id, new ones with their cut-out
        // (by its position among the crops sent) and the name chosen.
        const crops: Blob[] = [];
        const personPlan = (person: DraftPerson) => {
          const printed = !person.instructorId && Boolean(person.labelName || person.labelId);
          const common = {
            instructor_id: person.instructorId || null,
            source: person.instructorId || printed ? person.source : 'none',
            ...(printed ? { label_name: person.labelName ?? null, label_id: person.labelId ?? null } : {}),
            box: person.box,
          };
          if (person.id) return { id: person.id, ...common };
          crops.push(person.crop as Blob);
          return { crop: crops.length - 1, ...common };
        };
        const plan = [
          ...draft.kept
            .filter((photo) => draft.people[photo.id]?.status === 'ready')
            .map((photo) => ({ photo: photo.id, people: draft.people[photo.id].people.map(personPlan) })),
          ...draft.added
            .map((photo, index) => ({ photo, index }))
            .filter(({ photo }) => draft.people[photo.id] && draft.people[photo.id].status !== 'reading')
            .map(({ photo, index }) => ({
              photo: `new:${index}`,
              people: draft.people[photo.id].people.filter((person) => person.id || person.crop).map(personPlan),
            })),
        ];
        body.append('people', JSON.stringify(plan));
        crops.forEach((crop, index) => body.append('crops', crop, `person-${index + 1}.jpg`));
      }
      const result = await apiFetch<{ response: FormResponse }>(
        `/api/v2/forms/${encodeURIComponent(token)}/${data.date}`,
        { method: 'POST', body, auth: false, timeoutMs: 180_000 },
      );
      rememberName(draft.submittedBy.trim());
      forgetKeptDraft(data.date);
      writeCachedForm(token, { ...data, response: result.response });
      setData({ ...data, response: result.response });
      replaceDraft(draftFrom(result.response));
      setMode('summary');
      setJustSubmitted(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      const details = ((error as ApiError)?.details ?? null) as { errors?: Errors } | null;
      if (details?.errors) setErrors(details.errors);
      setSubmitError(error instanceof Error ? error.message : 'The form could not be sent. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const openViewer = (images: LightboxImage[], index: number) => setViewer({ images, index });
  const keptImages = draft.kept.map((photo, index) => ({ url: photo.url, label: `Photo ${index + 1}` }));
  const addedImages = draft.added.map((photo, index) => ({ url: photo.preview, label: `New photo ${index + 1}` }));
  const allImages = [...keptImages, ...addedImages];
  const photoCount = draft.kept.length + draft.added.length;
  const editablePhotos: EditablePhoto[] = [
    ...draft.kept.map((photo, index) => ({
      key: photo.id,
      title: `Photo ${index + 1}`,
      people: draft.people[photo.id],
    })),
    ...draft.added.map((photo, index) => ({
      key: photo.id,
      title: `Photo ${draft.kept.length + index + 1}`,
      people: draft.people[photo.id],
    })),
  ];
  const photosWillGo = draft.status === 'no' && (draft.added.length > 0 || Boolean(response?.photos.length));

  return (
    <main className="min-h-dvh bg-[#f0ebf8] px-3 py-4 text-slate-900 sm:px-4 sm:py-8">
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-3">
        <section className="overflow-hidden rounded-lg border border-[#dadce0] bg-white">
          <div className="h-2.5 bg-indigo-600" aria-hidden="true" />
          <div className="px-5 pb-4 pt-5 sm:px-6 sm:pt-6">
            <h1 className="text-[26px] leading-tight text-slate-900 sm:text-[32px]">{FORM_TITLE}</h1>
            {institute && (
              <p className="mt-2 text-sm text-slate-600">
                {institute.name}
                {institute.location ? ` · ${institute.location}` : ''}
              </p>
            )}
            {!institute && loading && !fatal && (
              <span className="mt-3 block h-4 w-64 max-w-full animate-pulse rounded bg-slate-100" aria-hidden="true" />
            )}
          </div>
          <p className="border-t border-[#dadce0] px-5 py-3 text-sm text-rose-600 sm:px-6">* Indicates required question</p>
        </section>

        {/* The questions' outline straight away, filled in when the data arrives. */}
        {loading && !data && !fatal && !dateError && (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Opening the form">
            {[
              { title: 'Date', field: 'h-10 w-52' },
              { title: 'Photo Submission Status', field: 'h-16 w-32' },
              { title: 'University Name', field: 'h-12 w-full max-w-md' },
              { title: 'Appearance Picture', field: 'h-10 w-32' },
              { title: 'Submitted By', field: 'h-10 w-full max-w-md' },
            ].map((question) => (
              <Card key={question.title}>
                <QuestionTitle required>{question.title}</QuestionTitle>
                <span className={`mt-4 block animate-pulse rounded bg-slate-100 ${question.field}`} aria-hidden="true" />
              </Card>
            ))}
          </div>
        )}

        {fatal && (
          <Card>
            <p className="flex items-start gap-2 text-sm text-rose-700" role="alert">
              <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              {fatal}
            </p>
            <button
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Try again
            </button>
          </Card>
        )}

        {/* Answers brought back after a reload: said at the top, above Date. */}
        {!fatal && restored && mode === 'edit' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">
            <span>Your answers that were not sent yet have been brought back. Check them and press Submit.</span>
            <button
              type="button"
              onClick={discardRestored}
              disabled={submitting}
              className="h-9 shrink-0 rounded-md border border-emerald-300 bg-white px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
            >
              Start over
            </button>
          </div>
        )}

        {/* Editing a sent response: said at the top, above Date. */}
        {!fatal && data && response && mode === 'edit' && (
          <p className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
            You are editing the response for {longDate(data.date)}. Press Submit to save your changes.
          </p>
        )}

        {!fatal && institute && today && (
          <Card id="question-date">
            <QuestionTitle required htmlFor="form-date">Date</QuestionTitle>
            <p className="mt-3 text-xs text-slate-500">Date</p>
            <FormDatePicker
              id="form-date"
              value={shownDate}
              today={today}
              min="2020-01-01"
              disabled={submitting}
              onChange={goToDate}
            />
            <p className="mt-2 text-xs text-slate-500">
              {shownDate === today ? "Today's form." : `The form for ${longDate(shownDate)}.`} Pick another date to see or change that day's response.
            </p>
          </Card>
        )}

        {!fatal && dateError && (
          <Card invalid>
            <ErrorLine message={dateError} />
          </Card>
        )}

        {!fatal && data && mode === 'summary' && response && (
          <Card>
            <div className="flex items-start gap-3">
              <CheckCircle2 size={24} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-slate-900">
                  {justSubmitted ? 'Your response has been recorded.' : `The response for ${longDate(data.date)} has been submitted.`}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Submitted {formatMoment(response.submitted_at)}
                  {response.edit_count > 0 && response.updated_at ? ` · last edited ${formatMoment(response.updated_at)}` : ''}
                </p>
              </div>
            </div>

            <dl className="mt-5 divide-y divide-slate-100 rounded-md border border-slate-200">
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
                <dt className="text-sm text-slate-500">Photo Submission Status</dt>
                <dd className="text-sm font-semibold text-slate-900">{statusLabel(response.status)}</dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
                <dt className="text-sm text-slate-500">University Name</dt>
                <dd className="text-sm font-semibold text-slate-900">{response.college_name || institute?.name}</dd>
              </div>
              {response.status === 'yes' && (
                <div className="grid gap-2 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
                  <dt className="text-sm text-slate-500">Appearance Picture</dt>
                  <dd>
                    {response.photos.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                        {response.photos.map((photo, index) => (
                          <Thumb
                            key={photo.id}
                            src={photo.thumb_url || photo.url}
                            label={`Photo ${index + 1}`}
                            onOpen={() => openViewer(response.photos.map((item, i) => ({ url: item.url, label: `Photo ${i + 1}` })), index)}
                          />
                        ))}
                      </div>
                    )}
                    {response.photo_links.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {response.photo_links.map((link, index) => (
                          <li key={link}>
                            <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-indigo-700 underline">
                              Picture link {index + 1}
                              <ExternalLink size={13} aria-hidden="true" />
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {!response.photos.length && !response.photo_links.length && <span className="text-sm text-slate-500">No photos</span>}
                  </dd>
                </div>
              )}
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
                <dt className="text-sm text-slate-500">Submitted By</dt>
                <dd className="break-words text-sm font-semibold text-slate-900">{response.submitted_by}</dd>
              </div>
              {response.status === 'no' && (
                <div className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
                  <dt className="text-sm text-slate-500">Reason for Non Submission</dt>
                  <dd className="break-words text-sm font-semibold text-slate-900">{response.reason_label}</dd>
                </div>
              )}
            </dl>

            <button
              type="button"
              onClick={startEdit}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-md border border-indigo-200 bg-white px-4 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Pencil size={16} aria-hidden="true" />
              Edit response
            </button>
          </Card>
        )}

        {!fatal && data && mode === 'edit' && (
          <form onSubmit={submit} noValidate className="flex flex-col gap-3">
            <Card id="question-status" invalid={Boolean(errors.status)}>
              <QuestionTitle required>Photo Submission Status</QuestionTitle>
              <div className="mt-3 flex flex-col" role="radiogroup" aria-label="Photo Submission Status">
                {FORM_STATUS_OPTIONS.map((option) => (
                  <RadioRow
                    key={option.value}
                    name="status"
                    value={option.value}
                    label={option.label}
                    checked={draft.status === option.value}
                    onChange={() => update({ status: option.value }, ['status', 'photos', 'reason'])}
                  />
                ))}
              </div>
              {photosWillGo && (
                <p className="mt-2 text-xs text-amber-700">Photos are not sent with No. Choose Yes to keep them.</p>
              )}
              <ErrorLine message={errors.status} />
            </Card>

            <Card id="question-university">
              <QuestionTitle required htmlFor="form-university">University Name</QuestionTitle>
              <select
                id="form-university"
                disabled
                value="current"
                className="mt-3 h-12 w-full max-w-md rounded border border-slate-300 bg-slate-50 px-3 text-[15px] text-slate-800 disabled:opacity-100"
              >
                <option value="current">{institute?.name}</option>
              </select>
              <p className="mt-2 text-xs text-slate-500">This link belongs to {institute?.name}.</p>
            </Card>

            {/* Shown from the start; hidden only when the answer is No. */}
            {draft.status !== 'no' && (
              <Card id="question-photos" invalid={Boolean(errors.photos)}>
                <QuestionTitle required>Appearance Picture</QuestionTitle>
                <p className="mt-2 text-sm text-slate-500">
                  Upload up to {FORM_MAX_PHOTOS} supported files: image. Max {FORM_MAX_FILE_MB} MB per file.
                </p>
                {photoCount > 0 && (
                  <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {draft.kept.map((photo, index) => (
                      <Thumb
                        key={photo.id}
                        src={photo.thumb_url || photo.url}
                        label={`Photo ${index + 1}`}
                        onOpen={() => openViewer(allImages, index)}
                        onRemove={() => setRemoving({ kind: 'kept', id: photo.id })}
                      />
                    ))}
                    {draft.added.map((photo, index) => (
                      <Thumb
                        key={photo.id}
                        src={photo.preview}
                        label={`New photo ${index + 1}`}
                        onOpen={() => openViewer(allImages, draft.kept.length + index)}
                        onRemove={() => setRemoving({ kind: 'added', id: photo.id })}
                      />
                    ))}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => { void onFilesChosen(event.target.files); }}
                />
                {photoCount < FORM_MAX_PHOTOS ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={preparing || submitting}
                    className="mt-4 inline-flex h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
                  >
                    {preparing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={16} aria-hidden="true" />}
                    {preparing ? 'Adding photos…' : 'Add file'}
                  </button>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">You have added the most photos allowed. Remove one to add another.</p>
                )}
                {response && response.photo_links.length > 0 && (
                  <p className="mt-3 text-xs text-slate-500">This response also has {response.photo_links.length} imported picture link(s), which are kept.</p>
                )}
                <ErrorLine message={errors.photos} />
              </Card>
            )}

            {/* Its own section once a photo is added: who is in the photos. */}
            {draft.status !== 'no' && editablePhotos.length > 0 && (
              <Card id="question-people">
                <QuestionTitle>People in the Photos</QuestionTitle>
                <FormPeopleEditor
                  photos={editablePhotos}
                  roster={roster}
                  rosterError={rosterError}
                  disabled={submitting}
                  onEdit={editPerson}
                  onRemove={(photoKey, personKey) => setPersonRemoving({ photoKey, personKey })}
                />
              </Card>
            )}

            {/* With No, the reason comes right after University Name. */}
            {draft.status === 'no' && (
              <Card id="question-reason" invalid={Boolean(errors.reason)}>
                <QuestionTitle required>Reason for Non Submission</QuestionTitle>
                <div className="mt-3 flex flex-col" role="radiogroup" aria-label="Reason for Non Submission">
                  {FORM_REASON_OPTIONS.filter((option) => option.value !== 'other').map((option) => (
                    <RadioRow
                      key={option.value}
                      name="reason"
                      value={option.value}
                      label={option.label}
                      checked={draft.reason === option.value}
                      onChange={() => update({ reason: option.value }, 'reason')}
                    />
                  ))}
                  <div className="flex min-h-11 flex-wrap items-center gap-3 py-1.5">
                    <label className="flex cursor-pointer items-center gap-3 text-[15px] text-slate-800">
                      <input
                        type="radio"
                        name="reason"
                        value="other"
                        checked={draft.reason === 'other'}
                        onChange={() => update({ reason: 'other' }, 'reason')}
                        className="h-5 w-5 shrink-0 cursor-pointer accent-indigo-600"
                      />
                      Other:
                    </label>
                    <input
                      type="text"
                      value={draft.reasonOther}
                      maxLength={300}
                      aria-label="Other reason"
                      onFocus={() => { if (draft.reason !== 'other') update({ reason: 'other' }, 'reason'); }}
                      onChange={(event) => update({ reason: 'other', reasonOther: event.target.value }, 'reason')}
                      className="h-9 min-w-0 flex-1 border-0 border-b border-slate-300 bg-transparent px-0 text-[15px] text-slate-900 outline-none focus:border-b-2 focus:border-indigo-600"
                    />
                  </div>
                </div>
                <ErrorLine message={errors.reason} />
              </Card>
            )}

            <Card id="question-submitted_by" invalid={Boolean(errors.submitted_by)}>
              <QuestionTitle required htmlFor="form-submitted-by">Submitted By</QuestionTitle>
              <input
                id="form-submitted-by"
                type="text"
                value={draft.submittedBy}
                maxLength={120}
                autoComplete="name"
                placeholder="Your answer"
                onChange={(event) => update({ submittedBy: event.target.value }, 'submitted_by')}
                className="mt-4 h-10 w-full max-w-md border-0 border-b border-slate-300 bg-transparent px-0 text-[15px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-b-2 focus:border-indigo-600"
              />
              <ErrorLine message={errors.submitted_by} />
            </Card>

            {submitError && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                {submitError}
              </p>
            )}

            {/* Clear form (or Cancel editing) on the left, Submit on the right. */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {response ? (
                <button type="button" onClick={cancelEdit} disabled={submitting} className="h-11 rounded-md px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">
                  Cancel editing
                </button>
              ) : (
                <button type="button" onClick={clearForm} disabled={submitting} className="h-11 rounded-md px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">
                  Clear form
                </button>
              )}
              <button
                type="submit"
                disabled={submitting || preparing}
                className="ml-auto inline-flex h-11 min-w-28 items-center justify-center gap-2 rounded-md bg-indigo-600 px-6 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60"
              >
                {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {submitting ? (draft.added.length ? 'Uploading photos…' : 'Submitting…') : 'Submit'}
              </button>
            </div>
          </form>
        )}

        <div className="pb-4" aria-hidden="true" />
      </div>

      <ConfirmDialog
        open={Boolean(personRemoving)}
        title="Remove this person?"
        message="This person will not be listed for the photo."
        confirmLabel="Remove"
        destructive
        onConfirm={removePerson}
        onCancel={() => setPersonRemoving(null)}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this photo?"
        message={removing?.kind === 'kept'
          ? 'This photo will be removed from the response when you press Submit.'
          : 'This photo will not be uploaded.'}
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />

      {viewer && (
        <ImageLightbox
          images={viewer.images}
          startIndex={viewer.index}
          title={institute?.name || FORM_TITLE}
          onClose={() => setViewer(null)}
        />
      )}
    </main>
  );
}
