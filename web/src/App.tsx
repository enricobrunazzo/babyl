import { useState } from "react";
import { Onboarding, type Profile } from "./components/Onboarding";
import { Room } from "./components/Room";

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
  const [roomId] = useState(roomFromUrl);
  const [profile, setProfile] = useState<Profile | null>(null);

  return profile ? (
    <Room
      roomId={roomId}
      profile={profile}
      onLeave={() => setProfile(null)}
    />
  ) : (
    <Onboarding roomId={roomId} onEnter={setProfile} />
  );
}
