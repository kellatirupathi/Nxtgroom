import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { apiFetch } from '../api';
import CollegeEnrolmentList from './CollegeEnrolmentList';
import { useToast } from './useToast';
import type { IdentificationSettings } from '../types';

const IDENTIFICATION_PATH = '/api/v2/settings/identification';

export default function IdentificationSettingsSection() {
  const [settings, setSettings] = useState<IdentificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [openCollege, setOpenCollege] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const toast = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<IdentificationSettings>(IDENTIFICATION_PATH, { signal });
      if (!signal?.aborted && data) setSettings(data);
    } catch (error) {
      if (signal?.aborted) return;
      if ((error as { status?: number })?.status === 401) return;
      toast.error('Could not load identification settings');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return (
      <div className="bg-white rounded-md shadow-sm border border-slate-200 p-6">
        <p className="text-sm text-slate-400 font-medium">Loading identification settings…</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="bg-white rounded-md shadow-sm border border-slate-200 p-6">
        <p className="text-sm text-rose-700 font-medium">Identification settings are unavailable.</p>
      </div>
    );
  }

  if (openCollege) {
    return (
      <CollegeEnrolmentList
        collegeId={openCollege.id}
        collegeName={openCollege.name}
        onBack={() => setOpenCollege(null)}
        onEnrolmentChanged={() => { void load(); }}
      />
    );
  }

  const term = search.trim().toLowerCase();
  const visibleColleges = term
    ? settings.colleges.filter((college) => (
        String(college.college_name || '').toLowerCase().includes(term)
      ))
    : settings.colleges;

  return (
    <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-3 border-b border-slate-100">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search colleges…"
            aria-label="Search colleges"
            className="w-full pl-9 pr-3 py-2 rounded-md border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
          />
        </div>
      </div>

      <div className="overflow-x-auto overscroll-x-contain">
        <table className="w-full text-left border-collapse table-fixed">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
              <th className="px-2 py-2.5 w-[48%] text-[10px] tracking-wide sm:px-3 sm:w-[56%] sm:text-xs sm:tracking-wider">College</th>
              <th className="px-2 py-2.5 w-[26%] text-[10px] tracking-wide sm:px-3 sm:w-[22%] sm:text-xs sm:tracking-wider">Instructors</th>
              <th className="px-2 py-2.5 w-[26%] text-[10px] tracking-wide sm:px-3 sm:w-[22%] sm:text-xs sm:tracking-wider">Photos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleColleges.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-6 text-center text-slate-400 font-medium">
                  {settings.colleges.length === 0
                    ? 'No colleges yet.'
                    : `No colleges match “${search.trim()}”.`}
                </td>
              </tr>
            ) : (
              visibleColleges.map((college) => (
                <tr
                  key={college.college_id}
                  onClick={() => setOpenCollege({
                    id: college.college_id,
                    name: college.college_name || 'College',
                  })}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <td className="px-3 py-2.5 font-bold text-slate-800 truncate" title={college.college_name || ''}>
                    {college.college_name || '--'}
                  </td>
                  <td className="px-3 py-2.5 text-sm font-medium text-slate-600 whitespace-nowrap">
                    {college.instructors}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="text-sm font-bold text-slate-700">
                      {college.enrolled}/{college.instructors}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
