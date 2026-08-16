import React from 'react';
import { LayoutGrid, Users, X, History, Building2, UserCog } from 'lucide-react';

export default function Sidebar({ isSidebarOpen, setIsSidebarOpen, activeTab, navigate, role }) {
  return (
    <aside className={`fixed lg:static inset-y-0 left-0 w-64 bg-white border-r border-indigo-50 flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.02)] z-50 shrink-0 transform transition-transform duration-300 ease-in-out ${
      isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
    }`}>
      <div className="p-6 pt-8 mb-4 relative">
        <button 
          type="button"
          aria-label="Close navigation menu"
          className="lg:hidden absolute top-6 right-4 text-slate-400 hover:text-slate-600 bg-slate-50 p-1 rounded-full" 
          onClick={() => setIsSidebarOpen(false)}
        >
          <X size={20} />
        </button>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0">
            <img src="/logo.png" alt="FacultyTrack Logo" className="w-full h-full object-contain" />
          </div>
          <div>
            <h2 className="font-bold text-lg leading-tight text-slate-800">FacultyTrack</h2>
          </div>
        </div>
      
      </div>

      <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
        <button 
          onClick={() => navigate('overview')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200 ${
            activeTab === 'overview' 
              ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' 
              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
          }`}
        >
          <LayoutGrid size={20} />
          Attendance
        </button>
        
        <button 
          onClick={() => navigate('daily-records')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200 ${
            activeTab === 'daily-records' 
              ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' 
              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
          }`}
        >
          <History size={20} />
          Daily Records
        </button>

        {role === 'SUPER_ADMIN' && (
          <>
            <button 
              onClick={() => navigate('college-management')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200 ${
                activeTab === 'college-management' 
                  ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' 
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              <Building2 size={20} />
              College Management
            </button>
            <button 
              onClick={() => navigate('instructor-management')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200 ${
                activeTab === 'instructor-management' 
                  ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' 
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              <UserCog size={20} />
              Instructor Management
            </button>
            <button 
              onClick={() => navigate('boa-management')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200 ${
                activeTab === 'boa-management' 
                  ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' 
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              <Users size={20} />
              BOA Management
            </button>
          </>
        )}
      </nav>
    </aside>
  );
}
