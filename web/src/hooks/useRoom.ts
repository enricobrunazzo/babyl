import { useEffect, useMemo, useSyncExternalStore } from "react";
import { RoomClient, type RoomOptions } from "../lib/roomClient";

function signalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

export function useRoom(options: Omit<RoomOptions, "url">) {
  const client = useMemo(
    () => new RoomClient({ ...options, url: signalingUrl() }),
    // La stanza vive per l'intera permanenza: le opzioni non cambiano dopo
    // l'onboarding (sistema stateless, nessun profilo persistito).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__babylClient = client;
    }
    void client.connect();
    return () => client.disconnect();
  }, [client]);

  const state = useSyncExternalStore(client.subscribe, client.getState);
  return { client, state };
}
