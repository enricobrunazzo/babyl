/**
 * Genera un id stanza breve e condivisibile. Alfabeto senza caratteri
 * ambigui (niente 0/O, 1/l/i) così è facile dettarlo a voce o trascriverlo.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newRoomId(): string {
  let id = "";
  for (let i = 0; i < 5; i++) {
    id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return id;
}
