import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error';

export function useUpdater() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [version, setVersion] = useState('');
  const [availableVersion, setAvailableVersion] = useState('');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);
  const startedRef = useRef(false);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (!isTauri() || busyRef.current) return;
    busyRef.current = true;
    if (manual) setDismissed(false);
    setPhase('checking');
    setMessage('');
    try {
      const found = await check({ timeout: 15000 });
      await updateRef.current?.close();
      updateRef.current = found;
      if (found) {
        setAvailableVersion(found.version);
        setPhase('available');
      } else {
        setAvailableVersion('');
        setPhase('idle');
        if (manual) setMessage('You have the latest version.');
      }
    } catch (error) {
      setPhase(manual ? 'error' : 'idle');
      if (manual) setMessage(`Could not check for updates: ${String(error)}`);
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (startedRef.current || !isTauri()) return;
    startedRef.current = true;
    void getVersion().then(setVersion).catch(() => {});
    void checkForUpdates();
  }, [checkForUpdates]);

  const install = useCallback(async () => {
    if (!updateRef.current || busyRef.current) return;
    busyRef.current = true;
    setPhase('downloading');
    setMessage('Downloading update…');
    setProgress(null);
    let downloaded = 0;
    let contentLength = 0;
    try {
      await updateRef.current.downloadAndInstall(event => {
        if (event.event === 'Started') contentLength = event.data.contentLength || 0;
        if (event.event === 'Progress') downloaded += event.data.chunkLength;
        if (event.event === 'Finished') {
          setPhase('installing');
          setMessage('Installing update…');
        } else if (contentLength) {
          setProgress(Math.min(100, Math.round(downloaded / contentLength * 100)));
          setMessage('Downloading update…');
        }
      });
      setMessage('Restarting…');
      await relaunch();
    } catch (error) {
      setPhase('error');
      setMessage(`Update failed: ${String(error)}`);
    } finally {
      busyRef.current = false;
    }
  }, []);

  return {
    phase, version, availableVersion, message, progress, dismissed,
    checkForUpdates, install, dismiss: () => setDismissed(true),
  };
}

export type Updater = ReturnType<typeof useUpdater>;
