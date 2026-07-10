import { useCallback, useState } from "react";
import { Onboarding, type Profile } from "./components/Onboarding";
import { Room } from "./components/Room";
import { InstallPrompt } from "./components/InstallPrompt";
import { newRoomId } from "./lib/roomName";

/**
 * Stanza dall'URL (?room=… oppure /r/<nome>), con default pubblico:
 * l'accesso resta "zero click" — il link È la stanza.
 */
function roomFromUrl(): string {
  const query = new URLSearchParams(location.search).get("room");
  if (query) return query.slice(0, 64);
  const match = location.pathname.match(/^\/r\/([\w-]{1,64})/);
  if (match) return match[1];
  return "piazza";
}

export default function App() {
  const [roomId, setRoomId] = useState(roomFromUrl);
  // Stanza privata per la modalità single-device: l'audio torna solo al
  // dispositivo stesso, quindi non deve collidere con una stanza pubblica.
  const [soloRoom] = useState(
    () => `solo-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [profile, setProfile] = useState<Profile | null>(null);

  // Cambia stanza e allinea l'URL, così un refresh o il link di condivisione
  // puntano alla stanza corrente.
  const changeRoom = useCallback((id: string) => {
    // Non troncare mentre si digita: lo slice basta, il default scatta
    // solo se il campo resta vuoto.
    const value = id.slice(0, 64);
    setRoomId(value);
    const url = new URL(location.href);
    url.pathname = "/";
    url.searchParams.set("room", value.trim() || "piazza");
    history.replaceState(null, "", url.toString());
  }, []);

  const activeRoom =
    profile?.mode === "solo" ? soloRoom : roomId.trim() || "piazza";

  return (
    <>
      {profile ? (
        // key: cambiare stanza rimonta il client così si entra in quella nuova.
        <Room
          key={activeRoom}
          roomId={activeRoom}
          profile={profile}
          onLeave={() => setProfile(null)}
          onNewRoom={() => changeRoom(newRoomId())}
        />
      ) : (
        <Onboarding
          roomId={roomId}
          onRoomChange={changeRoom}
          onEnter={setProfile}
        />
      )}
      <InstallPrompt />
    </>
  );
}
