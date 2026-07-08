import { useRoom } from "../hooks/useRoom";
import { languageByCode } from "../lib/languages";
import type { Profile } from "./Onboarding";
import { PTTButton } from "./PTTButton";

interface Props {
  roomId: string;
  profile: Profile;
  onLeave: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "Inizializzazione…",
  mic: "Attivazione microfono…",
  connecting: "Connessione alla stanza…",
  connected: "Connesso",
  closed: "Disconnesso",
  error: "Errore di connessione",
};

export function Room({ roomId, profile, onLeave }: Props) {
  const { client, state } = useRoom({
    room: roomId,
    nickname: profile.nickname,
    lang: profile.lang,
  });

  if (state.error === "mic-denied") {
    return (
      <main className="room room-error">
        <h2>Microfono non disponibile</h2>
        <p>
          Babyl ha bisogno del microfono per la traduzione in tempo reale.
          Consenti l'accesso dalle impostazioni del browser e riprova.
        </p>
        <button type="button" className="enter-button" onClick={onLeave}>
          Torna all'inizio
        </button>
      </main>
    );
  }

  const participants = state.self ? [state.self, ...state.peers] : state.peers;
  const pttState = client.pttState();
  const connected = state.status === "connected";

  return (
    <main className="room">
      <header className="room-header">
        <div>
          <h2>{roomId}</h2>
          <p className={`status status-${state.status}`}>
            {STATUS_LABELS[state.status]}
            {connected && ` · ${participants.length} partecipant${participants.length === 1 ? "e" : "i"}`}
          </p>
        </div>
        <button type="button" className="leave-button" onClick={onLeave}>
          Esci
        </button>
      </header>

      <ul className="participants">
        {participants.map((peer) => {
          const lang = languageByCode(peer.lang);
          const speaking = state.channel.speakerId === peer.id;
          return (
            <li
              key={peer.id}
              className={`participant${speaking ? " speaking" : ""}`}
            >
              <span className="participant-flag" aria-hidden="true">
                {lang?.flag ?? "🌐"}
              </span>
              <span className="participant-name">
                {peer.nickname}
                {peer.id === state.self?.id && " (tu)"}
              </span>
              {speaking && <span className="speaking-dot" aria-hidden="true" />}
            </li>
          );
        })}
      </ul>

      <PTTButton
        state={pttState}
        speakerName={state.channel.speakerName}
        disabled={!connected}
        onPress={() => client.pttDown()}
        onRelease={() => client.pttUp()}
      />
    </main>
  );
}
