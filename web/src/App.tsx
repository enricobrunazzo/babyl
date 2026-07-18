import { useCallback, useState } from "react";
import { Onboarding, type Profile } from "./components/Onboarding";
import { Room } from "./components/Room";
import { EarphoneGate } from "./components/EarphoneGate";
import { InstallPrompt } from "./components/InstallPrompt";
import { OrganizerApp } from "./components/OrganizerApp";
import { Configuratore } from "./components/Configuratore";
import { newRoomId } from "./lib/roomName";

/** Confronta il path corrente (senza slash finali) con una rotta statica. */
function pathIs(route: string): boolean {
  return location.pathname.replace(/\/+$/, "") === route;
}

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

/**
 * Il link di un evento porta `?event=1`: chi lo apre entra come pubblico
 * (ascolto puro, microfono disabilitato finché il relatore non dà la parola).
 */
function eventFromUrl(): boolean {
  return new URLSearchParams(location.search).get("event") === "1";
}

/**
 * Il link/QR condiviso porta `?join=1`: chi lo apre entra dritto nella stanza
 * con la schermata di join snella (lingua pre-rilevata, solo nome + consenso),
 * senza switch modalità né campo stanza. Chi crea una stanza da zero (nessun
 * parametro) vede invece il form completo.
 */
function joinFromUrl(): boolean {
  return new URLSearchParams(location.search).get("join") === "1";
}

/**
 * Il link `?host=1` (dall'area organizzatore) apre la stanza dell'evento come
 * **relatore**: form snello, ruolo speaker, modalità evento.
 */
function hostFromUrl(): boolean {
  return new URLSearchParams(location.search).get("host") === "1";
}

export default function App() {
  const [roomId, setRoomId] = useState(roomFromUrl);
  const [eventJoin] = useState(eventFromUrl);
  const [joinLink] = useState(joinFromUrl);
  const [hostJoin] = useState(hostFromUrl);
  // Stanza privata per la modalità single-device: l'audio torna solo al
  // dispositivo stesso, quindi non deve collidere con una stanza pubblica.
  const [soloRoom] = useState(
    () => `solo-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [profile, setProfile] = useState<Profile | null>(null);
  // Evento: prima di entrare si supera il gate degli auricolari (obbligatori).
  const [earphonesReady, setEarphonesReady] = useState(false);

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

  // Un evento richiede il gate auricolari prima di entrare in stanza.
  const needsEarphoneGate = profile?.mode === "event" && !earphonesReady;

  const leave = () => {
    setProfile(null);
    setEarphonesReady(false);
  };

  // Rotte statiche, indipendenti da stanza/onboarding.
  if (pathIs("/organizer")) return <OrganizerApp />;
  if (pathIs("/configuratore")) return <Configuratore />;

  return (
    <>
      {profile && needsEarphoneGate ? (
        <EarphoneGate
          lang={profile.lang}
          onReady={() => setEarphonesReady(true)}
          onBack={leave}
        />
      ) : profile ? (
        // key: cambiare stanza rimonta il client così si entra in quella nuova.
        <Room
          key={activeRoom}
          roomId={activeRoom}
          profile={profile}
          onLeave={leave}
          onNewRoom={() => changeRoom(newRoomId())}
        />
      ) : (
        <Onboarding
          roomId={roomId}
          eventJoin={eventJoin}
          joinLink={joinLink}
          hostJoin={hostJoin}
          onRoomChange={changeRoom}
          onEnter={setProfile}
        />
      )}
      <InstallPrompt />
    </>
  );
}
