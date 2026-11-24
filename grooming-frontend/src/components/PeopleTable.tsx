import { useState } from 'react';
import { UserRound } from 'lucide-react';
import ImageLightbox from './ImageLightbox';
import { peopleCount, peopleRows, type FormPhoto } from '../lib/instituteForm';

interface PeopleTableProps {
  photos: readonly FormPhoto[];
  title: string;
}

// Name | ID | Image for everyone cut out of a response's photos. Named people
// come first; people left without a name follow.
export default function PeopleTable({ photos, title }: PeopleTableProps) {
  const [viewing, setViewing] = useState<number | null>(null);
  const rows = peopleRows(photos);
  if (!rows.length) return <p className="text-sm text-slate-500">No people were marked in the photos.</p>;
  const count = peopleCount(photos);
  const images = rows.map((row) => ({ url: row.crop_url, label: row.employee_id ? `${row.label} (${row.employee_id})` : row.label }));

  return (
    <div>
      <p className="mb-2 text-xs text-slate-500">
        {count.identified} named{count.unknown ? ` · ${count.unknown} not named` : ''}
      </p>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full min-w-[20rem] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2">Name</th>
              <th scope="col" className="px-3 py-2">ID</th>
              <th scope="col" className="px-3 py-2">Image</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key} className="border-t border-slate-100 align-middle">
                <td className="px-3 py-2">
                  <span className={`block font-semibold ${row.matched ? 'text-slate-900' : 'text-slate-500'}`}>{row.label}</span>
                  {row.matched && row.source === 'label' && row.instructor_id && <span className="block text-xs text-slate-500">Read from the name label</span>}
                  {row.matched && !row.instructor_id && <span className="block text-xs text-amber-700">As printed in the photo · not in the instructor list</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-700">{row.employee_id || '—'}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setViewing(index)}
                    aria-label={`View the picture of ${row.label}`}
                    className="block h-24 w-[4.5rem] overflow-hidden rounded-md border border-slate-200 bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    {row.crop_url
                      ? <img src={row.crop_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                      : <UserRound size={22} className="mx-auto text-slate-300" aria-hidden="true" />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing !== null && (
        <ImageLightbox images={images} startIndex={viewing} title={title} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
