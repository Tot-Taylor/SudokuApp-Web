import { useEffect, useState } from 'react';

type Availability = 'preparing' | 'ready' | 'unavailable';

export function useInstallState() {
  const supported = import.meta.env.PROD && 'serviceWorker' in navigator;
  const [availability, setAvailability] = useState<Availability>(supported ? 'preparing' : 'unavailable');
  const [updateWaiting, setUpdateWaiting] = useState(false);
  const [standalone] = useState(() => window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true);

  useEffect(() => {
    if (!supported) return;
    const serviceWorker = navigator.serviceWorker;
    let stopped = false;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    let lastCheck = Date.now();

    function refresh() {
      if (stopped) return;
      const controlled = serviceWorker.controller !== null;
      setAvailability(controlled ? 'ready' : installing?.state === 'redundant' ? 'unavailable' : 'preparing');
      setUpdateWaiting(controlled && Boolean(registration?.waiting));
    }

    function watchInstall() {
      installing?.removeEventListener('statechange', refresh);
      installing = registration?.installing ?? null;
      installing?.addEventListener('statechange', refresh);
      refresh();
    }

    function checkForUpdate() {
      if (!registration || !navigator.onLine || document.visibilityState === 'hidden'
        || Date.now() - lastCheck < 30_000) return;
      lastCheck = Date.now();
      void registration.update().catch(() => undefined);
    }

    serviceWorker.addEventListener('controllerchange', refresh);
    window.addEventListener('focus', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    document.addEventListener('visibilitychange', checkForUpdate);

    void serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((worker) => {
      if (stopped) return;
      registration = worker;
      registration.addEventListener('updatefound', watchInstall);
      watchInstall();
    }).catch(() => {
      if (!stopped) setAvailability(serviceWorker.controller ? 'ready' : 'unavailable');
    });

    if (standalone) void navigator.storage?.persist?.().catch(() => false);

    return () => {
      stopped = true;
      serviceWorker.removeEventListener('controllerchange', refresh);
      registration?.removeEventListener('updatefound', watchInstall);
      installing?.removeEventListener('statechange', refresh);
      window.removeEventListener('focus', checkForUpdate);
      window.removeEventListener('online', checkForUpdate);
      document.removeEventListener('visibilitychange', checkForUpdate);
    };
  }, [standalone, supported]);

  return { availability, standalone, updateWaiting };
}
