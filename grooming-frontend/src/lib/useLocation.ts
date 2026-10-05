import { useEffect, useState } from 'react';
import { LOCATION_CHANGE_EVENT } from '../routes';

export interface LocationSnapshot {
  pathname: string;
  search: string;
}

function readLocation(): LocationSnapshot {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function useLocation(): LocationSnapshot {
  const [location, setLocation] = useState<LocationSnapshot>(readLocation);
  useEffect(() => {
    const update = () => setLocation((current) => {
      const next = readLocation();
      return next.pathname === current.pathname && next.search === current.search ? current : next;
    });
    window.addEventListener('popstate', update);
    window.addEventListener(LOCATION_CHANGE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(LOCATION_CHANGE_EVENT, update);
    };
  }, []);
  return location;
}
